import { Worker } from "node:worker_threads";
import type { FetchRequest, FetchedContent, FetchOutputFormat } from "./contracts";
import { SafeFetchError } from "./fetch-errors";
import { closeResponseBody, fetchRemoteUrl, type Lookup, type ResponseBody } from "./ssrf";
import type { DirectTransport } from "./direct-transport";

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_LENGTH = 8_000;
export const MAX_FETCH_LENGTH = 12_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_FETCH_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_TITLE_LENGTH = 500;
const MAX_OUTPUT_BYTES = 32_000;

type NormalizedFetchRequest = Required<Pick<FetchRequest, "url" | "maxLength" | "offset" | "format" | "readable" | "allowRawHtmlFallback">>;

interface ExtractedContent {
	readonly content: string;
	readonly outputFormat: FetchOutputFormat;
	readonly extraction: "readability" | "raw" | "plain-text";
	readonly title?: string;
	readonly fellBackToRaw?: boolean;
}

export interface FetcherOptions {
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly lookup?: Lookup;
	readonly transport?: DirectTransport;
	readonly now?: () => Date;
}

export async function fetchContent(
	request: FetchRequest,
	signal?: AbortSignal,
	options: FetcherOptions = {},
): Promise<FetchedContent> {
	const normalized = validateFetchRequest(request);
	const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "timeoutMs must be positive" });
	}
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_FETCH_RESPONSE_BYTES) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "maxResponseBytes is outside the supported bound" });
	}
	if (signal?.aborted) throw new SafeFetchError({ kind: "canceled", message: "Fetch canceled" });

	const controller = new AbortController();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = (): void => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const fetched = await fetchRemoteUrl(normalized.url, {
			signal: controller.signal,
			lookup: options.lookup,
			transport: options.transport,
			headers: { "accept-encoding": "identity" },
		});
		const { response, url, redirectCount } = fetched;
		if (response.status < 200 || response.status >= 300) {
			await closeResponseBody(response.body);
			throw new SafeFetchError({
				kind: "http",
				status: response.status,
				retryable: response.status === 408 || response.status === 429 || response.status >= 500,
				message: `HTTP ${response.status}`,
			});
		}

		const contentType = response.headers.get("content-type") ?? "";
		const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		if (!isSupportedContentType(mimeType)) {
			await closeResponseBody(response.body);
			throw new SafeFetchError({ kind: "unsupportedContentType", message: "Response content type is not supported" });
		}
		const contentLength = parseContentLength(response.headers.get("content-length"));
		if (contentLength !== undefined && contentLength > maxResponseBytes) {
			await closeResponseBody(response.body);
			throw new SafeFetchError({ kind: "responseTooLarge", message: "Response exceeds the configured byte limit" });
		}

		const bytes = await readBoundedBody(response.body, maxResponseBytes, controller.signal);
		const sourceText = decodeUtf8(bytes);
		const extracted = await extractWithDeadline(sourceText, mimeType, normalized, controller.signal);
		const sliced = sliceOutput(extracted.content, normalized.offset, normalized.maxLength);
		const warnings = [
			...(extracted.fellBackToRaw ? [{ code: "raw-fallback" as const, message: "Readable extraction failed; bounded raw HTML was returned" }] : []),
			...(sliced.truncated ? [{ code: "truncated" as const, message: "Content was truncated to the configured output bound" }] : []),
		];
		const title = extracted.title === undefined ? undefined : boundText(extracted.title, MAX_TITLE_LENGTH);

		return {
			url: url.url.href,
			...(url.url.href === normalized.url ? {} : { sourceUrl: normalized.url }),
			...(title === undefined ? {} : { title }),
			content: sliced.content,
			contentTrust: "untrusted",
			...(contentType === "" ? {} : { contentType }),
			outputFormat: extracted.outputFormat,
			extraction: extracted.extraction,
			fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
			status: response.status,
			redirectCount,
			bytesRead: bytes.byteLength,
			truncated: sliced.truncated,
			offset: normalized.offset,
			...(sliced.nextOffset === undefined ? {} : { nextOffset: sliced.nextOffset }),
			totalCharacters: extracted.content.length,
			warnings,
			...(extracted.fellBackToRaw ? { fellBackToRaw: true } : {}),
		};
	} catch (error) {
		if (timedOut && !signal?.aborted && isCanceled(error)) {
			throw new SafeFetchError({ kind: "timeout", message: `Fetch timed out after ${timeoutMs} ms`, retryable: true, cause: error });
		}
		if (signal?.aborted && isCanceled(error)) {
			throw new SafeFetchError({ kind: "canceled", message: "Fetch canceled", cause: error });
		}
		throw mapFetchFailure(error);
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function validateFetchRequest(request: FetchRequest): NormalizedFetchRequest {
	if (typeof request.url !== "string" || request.url.trim().length === 0) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "URL must not be empty" });
	}
	const url = request.url.trim();
	if (url.length > 8_192) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "URL exceeds the supported length limit" });
	}
	const maxLength = request.maxLength ?? DEFAULT_MAX_LENGTH;
	if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > MAX_FETCH_LENGTH) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "maxLength is outside the supported bound" });
	}
	const offset = request.offset ?? 0;
	if (!Number.isInteger(offset) || offset < 0 || offset > MAX_FETCH_LENGTH * 100) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "offset is outside the supported bound" });
	}
	const format = request.format ?? "markdown";
	if (format !== "markdown" && format !== "text" && format !== "html") {
		throw new SafeFetchError({ kind: "invalidRequest", message: "format is not supported" });
	}
	return {
		url,
		maxLength,
		offset,
		format,
		readable: request.readable ?? true,
		allowRawHtmlFallback: request.allowRawHtmlFallback ?? true,
	};
}

async function extractWithDeadline(
	sourceText: string,
	mimeType: string,
	request: NormalizedFetchRequest,
	signal: AbortSignal,
): Promise<ExtractedContent> {
	if (signal.aborted) throw new SafeFetchError({ kind: "canceled", message: "Fetch canceled" });
	return new Promise<ExtractedContent>((resolve, reject) => {
		const worker = new Worker(new URL("./fetch-extractor-worker.mjs", import.meta.url));
		let finished = false;
		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			void worker.terminate();
		};
		const fail = (error: unknown): void => {
			if (finished) return;
			finished = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => fail(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
		signal.addEventListener("abort", onAbort, { once: true });
		worker.once("error", (error) => fail(new SafeFetchError({ kind: "extraction", message: "Local content extraction failed", cause: error })));
		worker.once("exit", (code) => {
			if (!finished && code !== 0) fail(new SafeFetchError({ kind: "extraction", message: "Local content extraction stopped" }));
		});
		worker.once("message", (message: { ok: boolean; result?: ExtractedContent; error?: { kind: string; message: string } }) => {
			if (!message.ok || message.result === undefined) {
				const kind = message.error?.kind === "extraction" ? "extraction" : "unknown";
				fail(new SafeFetchError({ kind, message: message.error?.message ?? "Local content extraction failed" }));
				return;
			}
			finished = true;
			cleanup();
			resolve(message.result);
		});
		worker.postMessage({ sourceText, mimeType, request });
	});
}


async function readBoundedBody(body: ResponseBody | null, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const iterator = body[Symbol.asyncIterator]();
	let rejectAborted: ((error: SafeFetchError) => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		rejectAborted = reject;
	});
	const onAbort = (): void => rejectAborted?.(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const next = await Promise.race([iterator.next(), aborted]);
			if (next.done) break;
			const bytes = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
			total += bytes.byteLength;
			if (total > maxBytes) {
				throw new SafeFetchError({ kind: "responseTooLarge", message: "Response exceeds the configured byte limit" });
			}
			chunks.push(bytes);
		}
		if (signal.aborted) throw new SafeFetchError({ kind: "canceled", message: "Fetch canceled" });
	} finally {
		signal.removeEventListener("abort", onAbort);
		await closeResponseBody(body);
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function sliceOutput(content: string, offset: number, maxLength: number): { content: string; truncated: boolean; nextOffset?: number } {
	if (offset >= content.length) return { content: "", truncated: false };
	const requestedEnd = Math.min(content.length, offset + maxLength);
	const candidate = content.slice(offset, requestedEnd);
	const bounded = boundUtf8(candidate, MAX_OUTPUT_BYTES);
	const consumed = offset + bounded.length;
	const truncated = consumed < content.length;
	return {
		content: bounded,
		truncated,
		...(truncated ? { nextOffset: consumed } : {}),
	};
}

function boundUtf8(value: string, maxBytes: number): string {
	if (new TextEncoder().encode(value).byteLength <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (new TextEncoder().encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return value.slice(0, low);
}

function boundText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseContentLength(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function isSupportedContentType(mimeType: string): boolean {
	if (mimeType === "") return true;
	if (mimeType === "application/pdf" || mimeType === "application/octet-stream" || mimeType === "application/zip") return false;
	if (/^(image|audio|video)\//.test(mimeType)) return false;
	return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml" || mimeType === "application/javascript" || mimeType === "application/x-javascript" || mimeType === "application/graphql" || mimeType.endsWith("+json") || mimeType.endsWith("+xml");
}

function isCanceled(error: unknown): boolean {
	return (error instanceof SafeFetchError && error.kind === "canceled") || (error instanceof Error && /abort|cancell?ed/i.test(error.message));
}

function mapFetchFailure(error: unknown): SafeFetchError {
	if (error instanceof SafeFetchError) return error;
	return new SafeFetchError({ kind: "network", message: "Direct fetch failed", retryable: true, cause: error });
}
