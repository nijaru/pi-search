import http, { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import net from "node:net";
import { SafeFetchError } from "./fetch-errors";
import type { DirectTransportInit, ResponseBody, TransportResponse, ValidatedRemoteUrl } from "./ssrf";

/**
 * A transport is deliberately narrower than fetch(): the caller has already
 * resolved and validated the URL, and this implementation must connect to the
 * selected address while retaining the URL hostname for Host/SNI validation.
 */
export type DirectTransport = (
	target: ValidatedRemoteUrl,
	init: DirectTransportInit,
) => Promise<TransportResponse>;

export const directTransport: DirectTransport = (target, init) => requestDirect(target, init);

function requestDirect(target: ValidatedRemoteUrl, init: DirectTransportInit): Promise<TransportResponse> {
	if (init.signal.aborted) {
		return Promise.reject(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
	}

	const isHttps = target.url.protocol === "https:";
	const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
	const port = target.url.port === "" ? (isHttps ? 443 : 80) : Number(target.url.port);
	const path = `${target.url.pathname || "/"}${target.url.search}`;
	const requestOptions: RequestOptions = {
		protocol: target.url.protocol,
		hostname,
		port,
		method: "GET",
		path,
		headers: {
			accept: "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
			"user-agent": "pi-search/0.1 (+https://github.com/nijaru/pi-search)",
			...init.headers,
		},
		lookup: (_lookupHostname, lookupOptions, callback) => {
			if (lookupOptions.all) {
				callback(null, [{ address: target.address, family: target.family }]);
			} else {
				callback(null, target.address, target.family);
			}
		},
		...(isHttps && net.isIP(hostname) === 0 ? { servername: hostname } : {}),
	};

	return new Promise<TransportResponse>((resolve, reject) => {
		let settled = false;
		let response: IncomingMessage | undefined;
		let removeAbortListener: (() => void) | undefined;

		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			removeAbortListener?.();
			if (error instanceof SafeFetchError) {
				reject(error);
				return;
			}
			reject(
				new SafeFetchError({
					kind: "network",
					message: "Direct HTTP request failed",
					retryable: true,
					cause: error,
				}),
			);
		};

		const req = (isHttps ? https : http).request(requestOptions, (incoming) => {
			response = incoming;
			const body = makeResponseBody(incoming, req, init.signal, () => removeAbortListener?.());
			settled = true;
			removeAbortListener?.();
			resolve({
				status: incoming.statusCode ?? 0,
				statusText: STATUS_CODES[incoming.statusCode ?? 0] ?? "",
				headers: toHeaders(incoming.headers),
				body,
			});
		});

		const onAbort = (): void => {
			if (response) {
				response.destroy();
			} else {
				req.destroy();
			}
			fail(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
		};
		removeAbortListener = () => init.signal.removeEventListener("abort", onAbort);
		init.signal.addEventListener("abort", onAbort, { once: true });
		req.once("error", fail);
		req.end();
	});
}

function makeResponseBody(
	incoming: IncomingMessage,
	req: { destroy: () => void },
	signal: AbortSignal,
	onClose: () => void,
): ResponseBody {
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		signal.removeEventListener("abort", onAbort);
		onClose();
		incoming.destroy();
		req.destroy();
	};
	const onAbort = (): void => close();
	signal.addEventListener("abort", onAbort, { once: true });
	return {
		async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
			try {
				for await (const chunk of incoming) {
					yield chunk;
				}
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		cancel: close,
		destroy: close,
	};
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		for (const entry of Array.isArray(value) ? value : [value]) {
			headers.append(name, entry);
		}
	}
	return headers;
}
