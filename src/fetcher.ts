import { Worker } from "node:worker_threads";
import type { FetchRequest, FetchedContent, FetchOutputFormat, FetchExtraction, FetchWarning, XReadMode } from "./contracts";
import { parseXUrl, readFxTwitter, type XUrl } from "./x-public";
import type { XBrowserReader } from "./x-browser";
import { SafeFetchError } from "./fetch-errors";
import { closeResponseBody, fetchRemoteUrl, type Lookup, type ResponseBody } from "./ssrf";
import type { DirectTransport } from "./direct-transport";
import { extractPdfText } from "./pdf";
import { extractYouTubeTranscript, parseYouTubeUrl } from "./youtube";
import {
	AnyDocConversionError,
	anyDocFormatHint,
	convertDocumentWithWorker,
	isAnyDocCandidate,
	isAnyDocMimeType,
	type AnyDocFormat,
	type DocumentConverter,
} from "./anydoc";

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_LENGTH = 8_000;
/** Character request bound aligned with the hard output byte bound below. */
export const MAX_FETCH_LENGTH = 32_000;
export const MAX_FETCH_OFFSET = MAX_FETCH_LENGTH * 100;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_FETCH_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_TITLE_LENGTH = 500;
const MAX_OUTPUT_BYTES = 32_000;

type NormalizedFetchRequest = Required<Pick<FetchRequest, "url" | "maxLength" | "offset" | "format" | "readable" | "allowRawHtmlFallback" | "captionLanguage">> & {
	readonly maxPages: number | undefined;
	readonly xMode: XReadMode | undefined;
};

interface ExtractedContent {
	readonly content: string;
	readonly outputFormat: FetchOutputFormat;
	readonly extraction: FetchExtraction;
	readonly documentFormat?: string;
	readonly title?: string;
	readonly fellBackToRaw?: boolean;
}

export interface FetcherOptions {
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly lookup?: Lookup;
	readonly transport?: DirectTransport;
	readonly now?: () => Date;
	readonly pdfCommand?: string;
	readonly youtubeCommand?: string;
	readonly pdfMaxOutputBytes?: number;
	readonly youtubeMaxOutputBytes?: number;
	readonly documentConverter?: DocumentConverter;
	/** Explicitly owned, user-authorized browser access. Never global auth discovery. */
	readonly xBrowser?: XBrowserReader;
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
		const xTarget = parseXUrl(normalized.url);
		const xDefaultMode = xTarget ? await options.xBrowser?.defaultMode() ?? "auto" : "direct";
		// A persistent user-selected direct-only policy cannot be overridden by a tool call.
		const xMode = xDefaultMode === "direct" ? "direct" : normalized.xMode ?? xDefaultMode;
		if (xTarget && xMode !== "direct") {
			return await fetchXContent(xTarget, xMode, normalized, controller.signal, options, maxResponseBytes);
		}
		if (parseYouTubeUrl(normalized.url) !== undefined) {
			return await fetchYouTubeContent(normalized, controller.signal, options, options.now ?? (() => new Date()));
		}
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
		const finalUrl = url.url.href;
		const pdfExpectedByMetadata = mimeType === "application/pdf" || isPdfUrl(normalized.url) || isPdfUrl(finalUrl);
		const documentCandidateByMetadata = isAnyDocCandidate(new Uint8Array(), mimeType, normalized.url) || isAnyDocCandidate(new Uint8Array(), mimeType, finalUrl);
		if (!isSupportedContentType(mimeType) && !pdfExpectedByMetadata && !documentCandidateByMetadata) {
			await closeResponseBody(response.body);
			throw new SafeFetchError({ kind: "unsupportedContentType", message: "Response content type is not supported" });
		}
		const responseByteLimit = options.maxResponseBytes === undefined && pdfExpectedByMetadata ? MAX_FETCH_RESPONSE_BYTES : maxResponseBytes;
		const contentLength = parseContentLength(response.headers.get("content-length"));
		if (contentLength !== undefined && contentLength > responseByteLimit) {
			await closeResponseBody(response.body);
			throw new SafeFetchError({ kind: "responseTooLarge", message: "Response exceeds the configured byte limit" });
		}

		const bytes = await readBoundedBody(response.body, responseByteLimit, controller.signal);
		const pdfExpected = hasPdfHeader(bytes);
		if (pdfExpectedByMetadata && !pdfExpected) {
			throw new SafeFetchError({
				kind: "extraction",
				message: "Response was identified as PDF but did not contain a valid PDF header",
			});
		}
		const documentCandidate = !pdfExpected && (isAnyDocCandidate(bytes, mimeType, normalized.url) || isAnyDocCandidate(bytes, mimeType, finalUrl));
		// AnyDoc has no page-range option; preserve explicit maxPages through the bounded PDF path.
		const extracted = pdfExpected
			? normalized.maxPages === undefined
				? await extractAnyDocContent(bytes, mimeType, finalUrl, controller.signal, options.documentConverter)
				: await extractPdfContent(bytes, normalized, controller.signal, options.pdfCommand, options.pdfMaxOutputBytes)
			: documentCandidate
				? await extractAnyDocContent(bytes, mimeType, finalUrl, controller.signal, options.documentConverter)
				: await extractWithDeadline(decodeText(bytes, contentType, mimeType), mimeType, normalized, controller.signal);
		return finishContent(extracted, normalized, {
			url: url.url.href, ...(contentType ? { contentType } : {}), status: response.status, redirectCount, bytesRead: bytes.byteLength,
		}, options.now);
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

function finishContent(
	extracted: ExtractedContent,
	request: NormalizedFetchRequest,
	metadata: Pick<FetchedContent, "url" | "contentType" | "status" | "redirectCount" | "bytesRead">,
	now: () => Date = () => new Date(),
	notices: readonly FetchWarning[] = [],
): FetchedContent {
	const sliced = sliceOutput(extracted.content, request.offset, request.maxLength);
	return {
		...metadata,
		...(metadata.url === request.url ? {} : { sourceUrl: request.url }),
		...(extracted.title === undefined ? {} : { title: boundText(extracted.title, MAX_TITLE_LENGTH) }),
		content: sliced.content, contentTrust: "untrusted", outputFormat: extracted.outputFormat,
		extraction: extracted.extraction, fetchedAt: now().toISOString(), truncated: sliced.truncated, offset: sliced.offset,
		...(extracted.documentFormat === undefined ? {} : { documentFormat: extracted.documentFormat }),
		...(sliced.nextOffset === undefined ? {} : { nextOffset: sliced.nextOffset }),
		totalCharacters: extracted.content.length,
		warnings: [
			...notices,
			...(extracted.fellBackToRaw ? [{ code: "raw-fallback" as const, message: "Readable extraction failed; bounded raw HTML was returned" }] : []),
			...(sliced.truncated ? [{ code: "truncated" as const, message: sliced.pagingLimitReached ? "Content was truncated at the maximum paging offset" : "Content was truncated to the configured output bound" }] : []),
		],
		...(extracted.fellBackToRaw ? { fellBackToRaw: true } : {}),
	};
}

async function fetchXContent(
	target: XUrl, mode: XReadMode, request: NormalizedFetchRequest,
	signal: AbortSignal, options: FetcherOptions, maxBytes: number,
): Promise<FetchedContent> {
	if (mode === "auto" || mode === "browser") {
		const browser = await options.xBrowser?.read(target, signal, maxBytes);
		if (browser) {
			const extracted = await extractWithDeadline(`<html><head><title></title></head><body><article>${browser.html}</article></body></html>`, "text/html", { ...request, readable: false }, signal);
			return finishContent({ ...extracted, title: browser.title, extraction: "x-browser" }, request, {
				url: target.url, status: 200, redirectCount: 0, bytesRead: browser.bytesRead, contentType: "text/html",
			}, options.now, [
				{ code: "authenticated", message: "Read using your authorized X browser profile; content may not be public and was not sent to FxTwitter" },
				...(target.kind === "post" ? [{ code: "partial" as const, message: "Only loaded author posts are included; thread completeness is unknown" }] : []),
			]);
		}
		if (mode === "browser") throw new SafeFetchError({ kind: "extraction", message: "X browser is not authorized. Run /search-x login once, or use public mode for free FxTwitter reads" });
	}
	let bytesRead = 0;
	let redirects = 0;
	const read = async (url: string) => {
		if (signal.aborted) throw new SafeFetchError({ kind: "canceled", message: "X read canceled" });
		const remote = await fetchRemoteUrl(url, {
			signal, lookup: options.lookup, transport: options.transport,
			maxRedirects: url.startsWith("https://api.fxtwitter.com/") ? 0 : 5,
			headers: { "accept-encoding": "identity" },
		});
		const { response } = remote;
		redirects += remote.redirectCount;
		if (response.status < 200 || response.status >= 300) {
			await closeResponseBody(response.body);
			throw new SafeFetchError({ kind: "http", status: response.status, message: `X retrieval returned HTTP ${response.status}`, retryable: response.status === 429 || response.status >= 500 });
		}
		const remaining = maxBytes - bytesRead;
		const declared = parseContentLength(response.headers.get("content-length"));
		if (remaining <= 0 || declared !== undefined && declared > remaining) {
			await closeResponseBody(response.body);
			throw new SafeFetchError({ kind: "responseTooLarge", message: "X retrieval exceeds the aggregate response-byte limit" });
		}
		const bytes = await readBoundedBody(response.body, remaining, signal);
		bytesRead += bytes.byteLength;
		return { bytes, url: remote.url.url.href, status: response.status, redirectCount: remote.redirectCount };
	};
	if (!target.postId) {
		// Article IDs are not post IDs. Try only the supplied public page, never a
		// guessed publishing post or a search that could return unrelated evidence.
		const page = await read(target.url);
		const extracted = await extractWithDeadline(new TextDecoder().decode(page.bytes), "text/html", request, signal);
		if (extracted.extraction !== "x-article") throw new SafeFetchError({ kind: "extraction", message: "X Article body is unavailable. Provide its /handle/article/POSTID or publishing post URL, or authorize the browser with /search-x login" });
		return finishContent(extracted, request, { url: page.url, contentType: "text/html", status: page.status, bytesRead, redirectCount: redirects }, options.now);
	}
	const result = await readFxTwitter(target, read);
	return finishContent({ content: result.content, title: result.title, outputFormat: "markdown", extraction: "fxtwitter" }, request, {
		url: result.url, contentType: "application/json", status: 200, redirectCount: redirects, bytesRead,
	}, options.now, result.warnings.map((message) => ({ code: "partial", message })));
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
	if (!Number.isInteger(offset) || offset < 0 || offset > MAX_FETCH_OFFSET) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "offset is outside the supported bound" });
	}
	const format = request.format ?? "markdown";
	if (format !== "markdown" && format !== "text" && format !== "html") {
		throw new SafeFetchError({ kind: "invalidRequest", message: "format is not supported" });
	}
	if (request.xMode !== undefined && !["auto", "public", "browser", "direct"].includes(request.xMode)) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "xMode is not supported" });
	}
	const maxPages = request.maxPages;
	if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500)) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "maxPages must be between 1 and 500" });
	}
	const captionLanguage = request.captionLanguage ?? "en";
	if (!/^[A-Za-z0-9,._*-]{1,32}$/.test(captionLanguage)) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "captionLanguage is invalid" });
	}
	return {
		url,
		maxLength,
		offset,
		format,
		readable: request.readable ?? true,
		allowRawHtmlFallback: request.allowRawHtmlFallback ?? true,
		maxPages,
		captionLanguage,
		xMode: request.xMode,
	};
}

async function extractPdfContent(
	bytes: Uint8Array,
	request: NormalizedFetchRequest,
	signal: AbortSignal,
	command: string | undefined,
	maxOutputBytes: number | undefined,
): Promise<ExtractedContent> {
	const result = await extractPdfText(bytes, {
		signal,
		command,
		maxPages: request.maxPages,
		maxOutputBytes,
	});
	return { content: result.text, outputFormat: "text", extraction: "pdf" };
}

async function extractAnyDocContent(
	bytes: Uint8Array,
	mimeType: string,
	url: string,
	signal: AbortSignal,
	converter: DocumentConverter | undefined,
): Promise<ExtractedContent> {
	const formatHint: AnyDocFormat | undefined = anyDocFormatHint(mimeType, url);
	try {
		const result = await (converter ?? convertDocumentWithWorker)(bytes, formatHint, signal);
		return {
			content: result.content,
			outputFormat: "markdown",
			extraction: "document",
			documentFormat: result.documentFormat,
		};
	} catch (error) {
		if (error instanceof SafeFetchError) throw error;
		if (error instanceof AnyDocConversionError) {
			const message = `AnyDoc ${error.code}: ${error.message}`;
			if (error.code === "unsupported") throw new SafeFetchError({ kind: "unsupportedContentType", message, cause: error });
			// needsOcr names scanned/image-only pages; OCR stays out of scope by
			// design, so it surfaces as an explicit unsupported-content failure.
			if (error.code === "needsOcr") throw new SafeFetchError({ kind: "unsupportedContentType", message, cause: error });
			throw new SafeFetchError({ kind: "extraction", message, cause: error });
		}
		throw new SafeFetchError({ kind: "extraction", message: "Local document conversion failed", cause: error });
	}
}

async function fetchYouTubeContent(
	request: NormalizedFetchRequest,
	signal: AbortSignal,
	options: FetcherOptions,
	now: () => Date,
): Promise<FetchedContent> {
	const result = await extractYouTubeTranscript(request.url, {
		signal,
		command: options.youtubeCommand,
		language: request.captionLanguage,
		maxOutputBytes: options.youtubeMaxOutputBytes,
	});
	return finishContent({ content: result.text, outputFormat: "text", extraction: "youtube-transcript" }, request, {
		url: `https://www.youtube.com/watch?v=${result.videoId}`, contentType: "text/plain", status: 200, redirectCount: 0, bytesRead: result.bytesRead,
	}, now);
}

function isPdfUrl(value: string): boolean {
	try {
		return new URL(value).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

function hasPdfHeader(bytes: Uint8Array): boolean {
	return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
}

async function extractWithDeadline(
	sourceText: string,
	mimeType: string,
	request: NormalizedFetchRequest,
	signal: AbortSignal,
): Promise<ExtractedContent> {
	if (signal.aborted) throw new SafeFetchError({ kind: "canceled", message: "Fetch canceled" });
	if (mimeType === "text/markdown" || mimeType === "text/x-markdown") {
		return { content: sourceText, outputFormat: "markdown", extraction: "markdown" };
	}
	if (mimeType !== "text/html" && mimeType !== "application/xhtml+xml") {
		return { content: sourceText, outputFormat: "text", extraction: "plain-text" };
	}
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
		try {
			worker.postMessage({ sourceText, mimeType, request });
		} catch (error) {
			fail(new SafeFetchError({ kind: "extraction", message: "Local content extraction could not start", cause: error }));
		}
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

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Keep a slice boundary out of the middle of a UTF-16 surrogate pair. */
function safeSliceEnd(value: string, end: number): number {
	return end > 0 && end < value.length && isHighSurrogate(value.charCodeAt(end - 1)) ? end - 1 : end;
}

function sliceOutput(content: string, requestedOffset: number, maxLength: number): { content: string; offset: number; truncated: boolean; nextOffset?: number; pagingLimitReached?: boolean } {
	// A caller-selected offset may land inside a surrogate pair; skip the low
	// half so a page never starts with an unpaired code unit.
	const offset = requestedOffset > 0 && requestedOffset < content.length && isLowSurrogate(content.charCodeAt(requestedOffset))
		? requestedOffset + 1
		: requestedOffset;
	if (offset >= content.length) return { content: "", offset, truncated: false };
	const requestedEnd = Math.min(content.length, offset + maxLength, MAX_FETCH_OFFSET);
	const candidate = content.slice(offset, safeSliceEnd(content, requestedEnd));
	const bounded = boundUtf8(candidate, MAX_OUTPUT_BYTES);
	const consumed = offset + bounded.length;
	const truncated = consumed < content.length;
	const pagingLimitReached = truncated && consumed >= MAX_FETCH_OFFSET;
	return {
		content: bounded,
		offset,
		truncated,
		...(truncated && !pagingLimitReached ? { nextOffset: consumed } : {}),
		...(pagingLimitReached ? { pagingLimitReached: true } : {}),
	};
}

export function boundUtf8(value: string, maxBytes: number): string {
	if (new TextEncoder().encode(value).byteLength <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (new TextEncoder().encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return value.slice(0, safeSliceEnd(value, low));
}

function boundText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function charsetFromContentType(contentType: string): string | undefined {
	const match = /(?:^|;)\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
	const label = match?.[1]?.trim().toLowerCase();
	return label ? label : undefined;
}

/** Honor an HTML meta charset when the response header omits one. */
function charsetFromHtml(bytes: Uint8Array): string | undefined {
	const head = new TextDecoder("latin1" as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes.subarray(0, 2_048));
	const match = /<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head);
	const label = match?.[1]?.trim().toLowerCase();
	return label ? label : undefined;
}

function decodeText(bytes: Uint8Array, contentType: string, mimeType: string): string {
	const declared = charsetFromContentType(contentType)
		?? (mimeType === "text/html" || mimeType === "application/xhtml+xml" ? charsetFromHtml(bytes) : undefined);
	if (declared !== undefined && declared !== "utf-8" && declared !== "utf8") {
		try {
			return new TextDecoder(declared as ConstructorParameters<typeof TextDecoder>[0], { fatal: false }).decode(bytes);
		} catch {
			// Unknown labels fall back to UTF-8 rather than failing the fetch.
		}
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseContentLength(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function isSupportedContentType(mimeType: string): boolean {
	if (mimeType === "") return true;
	if (mimeType === "application/pdf") return false;
	if (isAnyDocMimeType(mimeType)) return true;
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
