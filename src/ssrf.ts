import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { SafeFetchError } from "./fetch-errors";
import { directTransport, type DirectTransport } from "./direct-transport";

/*
 * The validation and redirect structure is adapted from pi-web-access's
 * ssrf-protection.ts (MIT; Copyright (c) 2025 Nico Bailon). See
 * THIRD_PARTY_NOTICES.md for the retained attribution.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_MAX_REDIRECTS = 5;
export const MAX_URL_LENGTH = 8_192;

export interface LookupAddress {
	readonly address: string;
	readonly family: number;
}

export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

export interface ValidatedRemoteUrl {
	readonly url: URL;
	/** Address selected from DNS and pinned by the direct transport. */
	readonly address: string;
	readonly family: 4 | 6;
}

export interface ResponseBody extends AsyncIterable<Uint8Array> {
	readonly cancel?: () => void | Promise<void>;
	readonly destroy?: () => void;
}

export interface TransportResponse {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Headers;
	readonly body: ResponseBody | null;
}

export interface DirectTransportInit {
	readonly signal: AbortSignal;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface ValidateRemoteUrlOptions {
	readonly lookup?: Lookup;
	readonly signal?: AbortSignal;
}

export interface FetchRemoteOptions extends ValidateRemoteUrlOptions {
	readonly transport?: DirectTransport;
	readonly maxRedirects?: number;
	readonly headers?: Readonly<Record<string, string>>;
}

const defaultLookup: Lookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new SafeFetchError({ kind: "canceled", message: "Fetch canceled" });
	}
}

async function lookupWithCancellation(
	lookup: Lookup,
	hostname: string,
	signal?: AbortSignal,
): Promise<LookupAddress[]> {
	throwIfAborted(signal);
	const lookupPromise = lookup(hostname);
	if (!signal) return lookupPromise;
	return new Promise<LookupAddress[]>((resolve, reject) => {
		const onAbort = () => reject(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
		signal.addEventListener("abort", onAbort, { once: true });
		lookupPromise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Resolve and reject non-global targets before a socket is opened. */
export async function validateRemoteUrl(
	rawUrl: string | URL,
	options: ValidateRemoteUrlOptions = {},
): Promise<ValidatedRemoteUrl> {
	throwIfAborted(options.signal);
	let url: URL;
	try {
		url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl);
	} catch (error) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "URL is not valid", cause: error });
	}
	if (url.href.length > MAX_URL_LENGTH) {
		throw new SafeFetchError({ kind: "invalidRequest", message: `URL exceeds the ${MAX_URL_LENGTH}-character limit` });
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SafeFetchError({ kind: "invalidRequest", message: "Only HTTP and HTTPS URLs can be fetched" });
	}
	if (url.username || url.password) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "URLs with embedded credentials are not allowed" });
	}
	// Fragments are not sent over HTTP. Dropping them makes the final URL
	// deterministic without turning ordinary citation URLs into failures.
	url.hash = "";

	const hostname = normalizeHostname(url.hostname);
	if (!hostname) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "URL must include a hostname" });
	}
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new SafeFetchError({ kind: "ssrf", message: "Blocked internal hostname" });
	}

	const literalFamily = net.isIP(hostname);
	if (literalFamily === 4 || literalFamily === 6) {
		assertPublicAddress(hostname, hostname);
		return { url, address: hostname, family: literalFamily };
	}

	let addresses: LookupAddress[];
	try {
		addresses = await lookupWithCancellation(options.lookup ?? defaultLookup, hostname, options.signal);
	} catch (error) {
		if (error instanceof SafeFetchError) throw error;
		throw new SafeFetchError({
			kind: "network",
			message: "Failed to resolve remote hostname",
			retryable: true,
			cause: error,
		});
	}
	if (addresses.length === 0) {
		throw new SafeFetchError({ kind: "network", message: "Remote hostname returned no addresses", retryable: true });
	}
	for (const entry of addresses) {
		const address = normalizeHostname(entry.address);
		const actualFamily = net.isIP(address);
		if (actualFamily !== 4 && actualFamily !== 6 || entry.family !== actualFamily) {
			throw new SafeFetchError({ kind: "ssrf", message: "Resolved address family is invalid" });
		}
		assertPublicAddress(address, hostname);
	}
	const first = addresses[0];
	const firstAddress = normalizeHostname(first.address);
	const firstFamily = net.isIP(firstAddress);
	if (firstFamily !== 4 && firstFamily !== 6) {
		throw new SafeFetchError({ kind: "network", message: "Resolved address is invalid", retryable: true });
	}
	return { url, address: firstAddress, family: firstFamily };
}

/** Fetch one response and manually revalidate every redirect target. */
export async function fetchRemoteUrl(
	rawUrl: string | URL,
	options: FetchRemoteOptions = {},
): Promise<{ response: TransportResponse; url: ValidatedRemoteUrl; redirectCount: number }> {
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "maxRedirects must be an integer between 0 and 20" });
	}
	const transport = options.transport ?? directTransport;
	let current = await validateRemoteUrl(rawUrl, options);

	for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
		throwIfAborted(options.signal);
		const response = await transport(current, {
			signal: options.signal ?? new AbortController().signal,
			headers: options.headers,
		});
		if (!REDIRECT_STATUSES.has(response.status)) {
			return { response, url: current, redirectCount: redirects };
		}
		const location = response.headers.get("location");
		if (!location) return { response, url: current, redirectCount: redirects };
		await closeResponseBody(response.body);
		if (redirects === maxRedirects) {
			throw new SafeFetchError({ kind: "redirect", message: "Too many redirects" });
		}
		let nextUrl: URL;
		try {
			nextUrl = new URL(location, current.url);
		} catch (error) {
			throw new SafeFetchError({ kind: "redirect", message: "Redirect location is not a valid URL", cause: error });
		}
		current = await validateRemoteUrl(nextUrl, options);
	}

	throw new SafeFetchError({ kind: "redirect", message: "Too many redirects" });
}

export async function closeResponseBody(body: ResponseBody | null): Promise<void> {
	if (!body) return;
	try {
		if (body.cancel) await body.cancel();
	} finally {
		body.destroy?.();
	}
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function assertPublicAddress(address: string, hostname: string): void {
	const normalized = normalizeHostname(address);
	const family = net.isIP(normalized);
	if (family !== 4 && family !== 6) {
		throw new SafeFetchError({ kind: "ssrf", message: "Resolved non-IP address" });
	}
	if ((family === 4 && isBlockedIPv4(normalized)) || (family === 6 && isBlockedIPv6(normalized))) {
		throw new SafeFetchError({ kind: "ssrf", message: "Blocked internal address" });
	}
}

function isBlockedIPv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b, c, d] = parts;
	return a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 198 && b >= 18 && b <= 19) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224 ||
		(a === 255 && b === 255 && c === 255 && d === 255);
}

function isBlockedIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;
	const first = groups[0];
	if (groups.slice(0, 6).every((group) => group === 0)) return true; // IPv4-compatible, unspecified, and loopback
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return true; // IPv4-mapped
	if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0) return true; // IPv4-translated
	if ((first & 0xfe00) === 0xfc00) return true; // ULA
	if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true; // link-local and deprecated site-local
	if ((first & 0xff00) === 0xff00) return true; // multicast

	// IANA special-purpose and transition prefixes. Rejecting these avoids
	// treating NAT64, 6to4, Teredo, documentation, benchmarking, and other
	// non-global IPv6 destinations as ordinary public hosts.
	const specialPrefixes: readonly [readonly number[], number][] = [
		[[0x0064, 0xff9b, 0x0000, 0x0000, 0x0000, 0x0000], 96], // 64:ff9b::/96 (NAT64 well-known)
		[[0x0064, 0xff9b, 0x0001], 48], // 64:ff9b:1::/48 (NAT64 local-use)
		[[0x0100], 64], // 100::/64 discard-only
		[[0x2001, 0x0000], 23], // 2001::/23 IETF protocol assignments
		[[0x2001, 0x0000], 32], // Teredo
		[[0x2001, 0x0001], 32], // PCP anycast / special use
		[[0x2001, 0x0002], 48], // benchmarking
		[[0x2001, 0x0003], 32], // AMT
		[[0x2001, 0x0004], 48], // AS112-v4
		[[0x2001, 0x0005], 48], // AS112-v6
		[[0x2001, 0x0008], 32], // ORCHID
		[[0x2001, 0x0010], 28], // ORCHIDv2 range
		[[0x2001, 0x0020], 28], // ORCHIDv2 range
		[[0x2001, 0x0db8], 32], // documentation
		[[0x2002], 16], // 6to4
		[[0x3fff, 0x0000], 20], // documentation
		[[0x0100, 0x0000, 0x0000, 0x0001], 64], // dummy / discarded prefix
		[[0x5f00], 16], // Segment Routing local-use
	];
	return specialPrefixes.some(([prefix, bits]) => hasIPv6Prefix(groups, prefix, bits));
}

function hasIPv6Prefix(groups: readonly number[], prefix: readonly number[], bits: number): boolean {
	const fullGroups = Math.floor(bits / 16);
	for (let index = 0; index < fullGroups; index += 1) {
		if (groups[index] !== (prefix[index] ?? 0)) return false;
	}
	const remaining = bits % 16;
	return remaining === 0 || (groups[fullGroups] >> (16 - remaining)) === ((prefix[fullGroups] ?? 0) >> (16 - remaining));
}

function parseIPv6(address: string): number[] | null {
	if (address.includes(".")) {
		const lastColon = address.lastIndexOf(":");
		const ipv4 = address.slice(lastColon + 1);
		if (net.isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map(Number);
		address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const pieces = address.split("::");
	if (pieces.length > 2) return null;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 0) return null;
	const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return Number.parseInt(part, 16);
	});
	return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}
