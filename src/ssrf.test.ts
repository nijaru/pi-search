import { describe, expect, it } from "bun:test";
import { SafeFetchError } from "./fetch-errors";
import {
	closeResponseBody,
	fetchRemoteUrl,
	validateRemoteUrl,
	type LookupAddress,
	type ResponseBody,
	type TransportResponse,
} from "./ssrf";
import type { DirectTransport } from "./direct-transport";

function lookup(addresses: LookupAddress[]) {
	return async (_hostname: string) => addresses;
}

function response(status: number, headers: Record<string, string> = {}, body: ResponseBody | null = null): TransportResponse {
	return { status, statusText: "", headers: new Headers(headers), body };
}

function emptyBody(spies?: { cancel?: () => void; destroy?: () => void }): ResponseBody {
	return {
		async *[Symbol.asyncIterator]() {},
		cancel: spies?.cancel,
		destroy: spies?.destroy,
	};
}

describe("SSRF and direct redirect boundary", () => {
	it("rejects literal private, link-local, loopback, IPv6, and mapped addresses before transport", async () => {
		for (const url of [
			"http://127.0.0.1/",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]/",
			"http://[fc00::1]/",
			"http://[::ffff:127.0.0.1]/",
			"http://[64:ff9b::a9fe:a9fe]/",
			"http://[64:ff9b::7f00:1]/",
			"http://[::ffff:0:7f00:1]/",
			"http://[100::1]/",
			"http://[2001:db8::1]/",
			"http://[fec0::1]/",
			"http://[3fff::1]/",
			"http://[100:0:0:1::1]/",
		]) {
			await expect(validateRemoteUrl(url)).rejects.toMatchObject({ kind: "ssrf" });
		}
	});

	it("rejects mixed DNS answers instead of selecting a public address", async () => {
		await expect(
			validateRemoteUrl("https://example.test/", {
				lookup: lookup([
					{ address: "93.184.216.34", family: 4 },
					{ address: "192.168.1.10", family: 4 },
				]),
			}),
		).rejects.toMatchObject({ kind: "ssrf" });
		await expect(
			validateRemoteUrl("https://ipv6.example.test/", {
				lookup: lookup([{ address: "3fff::1", family: 6 }]),
			}),
		).rejects.toMatchObject({ kind: "ssrf" });
	});

	it("pins the validated address at the transport boundary", async () => {
		let seenAddress = "";
		const transport: DirectTransport = async (target) => {
			seenAddress = target.address;
			return response(200, {}, emptyBody());
		};
		await fetchRemoteUrl("https://example.test/path", {
			lookup: lookup([{ address: "93.184.216.34", family: 4 }]),
			transport,
		});
		expect(seenAddress).toBe("93.184.216.34");
	});

	it("revalidates redirect targets and closes redirect bodies", async () => {
		let closed = 0;
		const body = emptyBody({ destroy: () => { closed += 1; } });
		const redirectTransport: DirectTransport = async () => response(302, { location: "http://127.0.0.1/private" }, body);
		await expect(
			fetchRemoteUrl("https://example.test/", {
				lookup: lookup([{ address: "93.184.216.34", family: 4 }]),
				transport: redirectTransport,
			}),
		).rejects.toMatchObject({ kind: "ssrf" });
		await closeResponseBody(body);
		expect(closed).toBeGreaterThan(0);
	});

	it("bounds redirect loops and malformed locations", async () => {
		const loop: DirectTransport = async () => response(302, { location: "/again" }, emptyBody());
		await expect(
			fetchRemoteUrl("https://example.test/", {
				lookup: lookup([{ address: "93.184.216.34", family: 4 }]),
				transport: loop,
				maxRedirects: 1,
			}),
		).rejects.toMatchObject({ kind: "redirect" });

		const malformed: DirectTransport = async () => response(302, { location: "http://[not-a-url" }, emptyBody());
		await expect(
			fetchRemoteUrl("https://example.test/", {
				lookup: lookup([{ address: "93.184.216.34", family: 4 }]),
				transport: malformed,
			}),
		).rejects.toMatchObject({ kind: "redirect" });
	});

	it("propagates cancellation while DNS is pending", async () => {
		const controller = new AbortController();
		const pendingLookup = async () => new Promise<LookupAddress[]>(() => {});
		const pending = validateRemoteUrl("https://example.test/", { lookup: pendingLookup, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "canceled" });
	});

	it("closes both cancellation hooks idempotently", async () => {
		let cancelCalls = 0;
		let destroyCalls = 0;
		const body = emptyBody({
			cancel: () => { cancelCalls += 1; },
			destroy: () => { destroyCalls += 1; },
		});
		await closeResponseBody(body);
		await closeResponseBody(body);
		expect(cancelCalls).toBe(2);
		expect(destroyCalls).toBe(2);
	});

	it("uses a typed SafeFetchError for invalid URLs", async () => {
		await expect(validateRemoteUrl("file:///tmp/x")).rejects.toBeInstanceOf(SafeFetchError);
	});
});
