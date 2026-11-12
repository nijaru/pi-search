import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SafeFetchError } from "./fetch-errors";

export const ANYDOC_FORMATS = ["doc", "docx", "odt", "ppt", "pptx", "rtf", "epub", "pdf", "xlsx", "ods", "odp", "csv"] as const;
export type AnyDocFormat = (typeof ANYDOC_FORMATS)[number];
export type AnyDocErrorCode = "unsupported" | "needsOcr" | "malformed" | "encrypted" | "resourceLimit" | "missingPart" | "io";

export const MAX_DOCUMENT_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const MAX_DIAGNOSTIC_BYTES = 8192;
const CONVERSION_TIMEOUT_MS = 30_000;

export interface AnyDocResult {
	readonly content: string;
	readonly documentFormat: AnyDocFormat;
}

export class AnyDocConversionError extends Error {
	readonly code: AnyDocErrorCode;

	constructor(code: AnyDocErrorCode, message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "AnyDocConversionError";
		this.code = code;
	}
}

export type DocumentConverter = (
	bytes: Uint8Array,
	formatHint: AnyDocFormat | undefined,
	signal: AbortSignal,
) => Promise<AnyDocResult>;

const formatByExtension: Readonly<Record<string, AnyDocFormat>> = {
	doc: "doc",
	docm: "docx",
	docx: "docx",
	epub: "epub",
	pdf: "pdf",
	ods: "ods",
	odp: "odp",
	odt: "odt",
	pot: "ppt",
	ppt: "ppt",
	pptm: "pptx",
	pptx: "pptx",
	pps: "ppt",
	ppsm: "pptx",
	ppsx: "pptx",
	rtf: "rtf",
	csv: "csv",
	xls: "xlsx",
	xlsb: "xlsx",
	xlsm: "xlsx",
	xlsx: "xlsx",
};

const formatByMimeType: Readonly<Record<string, AnyDocFormat>> = {
	"application/msword": "doc",
	"application/rtf": "rtf",
	"application/vnd.ms-excel": "xlsx",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.openxmlformats-officedocument.presentationml.slideshow": "pptx",
	"application/vnd.openxmlformats-officedocument.presentationml.template": "pptx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/epub+zip": "epub",
	"application/pdf": "pdf",
	"application/csv": "csv",
	"text/csv": "csv",
	"text/rtf": "rtf",
};

export function anyDocFormatHint(mimeType: string, url: string): AnyDocFormat | undefined {
	const mimeHint = Object.prototype.hasOwnProperty.call(formatByMimeType, mimeType) ? formatByMimeType[mimeType] : undefined;
	if (mimeHint !== undefined) return mimeHint;
	try {
		const pathname = new URL(url).pathname;
		const extension = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
		return Object.prototype.hasOwnProperty.call(formatByExtension, extension) ? formatByExtension[extension] : undefined;
	} catch {
		return undefined;
	}
}

export function isAnyDocMimeType(mimeType: string): boolean {
	return Object.prototype.hasOwnProperty.call(formatByMimeType, mimeType) || mimeType === "application/zip" || mimeType === "application/octet-stream";
}

export function isAnyDocCandidate(bytes: Uint8Array, mimeType: string, url: string): boolean {
	if (isPreservedTextMimeType(mimeType)) return false;
	if (mimeType.startsWith("text/") && mimeType !== "text/csv" && mimeType !== "text/rtf") {
		return anyDocFormatHint(mimeType, url) === "csv" || hasAnyDocSignature(bytes);
	}
	if (anyDocFormatHint(mimeType, url) !== undefined || isAnyDocMimeType(mimeType)) return true;
	return hasAnyDocSignature(bytes);
}

function isPreservedTextMimeType(mimeType: string): boolean {
	return mimeType === "text/html" || mimeType === "application/xhtml+xml" || mimeType === "text/markdown" || mimeType === "text/x-markdown" || mimeType === "application/json" || mimeType.endsWith("+json") || mimeType === "application/xml" || mimeType.endsWith("+xml") || mimeType === "application/javascript" || mimeType === "application/x-javascript" || mimeType === "application/graphql";
}

function hasAnyDocSignature(bytes: Uint8Array): boolean {
	if (bytes.length >= 4 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74) return true;
	if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) return true;
	return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

export function convertDocumentWithWorker(
	bytes: Uint8Array,
	formatHint: AnyDocFormat | undefined,
	signal: AbortSignal,
): Promise<AnyDocResult> {
	if (signal.aborted) return Promise.reject(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
	if (bytes.byteLength > MAX_DOCUMENT_INPUT_BYTES) {
		return Promise.reject(new AnyDocConversionError("resourceLimit", "Document input exceeds the 20 MiB limit"));
	}
	return new Promise<AnyDocResult>((resolve, reject) => {
		// AnyDoc 0.2.4 returns a complete native-allocated string, with no
		// configurable memory/output limit. A thread cannot contain native OOM
		// or stop an in-flight libuv task. Use a disposable process, not a thread.
		// This is crash/lifecycle isolation, NOT an OS memory or security sandbox:
		// native allocation can still exhaust host memory before it is killed.
		const worker = spawn(process.execPath, [
			fileURLToPath(new URL("./anydoc-worker.mjs", import.meta.url)),
			formatHint ?? "", String(MAX_DOCUMENT_INPUT_BYTES), String(MAX_DOCUMENT_TEXT_BYTES),
		], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let diagnosticBytes = 0;
		let failure: unknown;
		const stop = (error: unknown): void => {
			failure ??= error;
			worker.stdin.destroy();
			worker.stdout.destroy();
			worker.stderr.destroy();
			worker.kill("SIGKILL");
		};
		const onAbort = (): void => stop(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
		const timer = setTimeout(() => stop(new AnyDocConversionError("resourceLimit", "Local document conversion exceeded 30 seconds")), CONVERSION_TIMEOUT_MS);
		signal.addEventListener("abort", onAbort, { once: true });
		worker.once("error", (error) => stop(new AnyDocConversionError("malformed", "Local document converter failed to start", error)));
		worker.stdin.on("error", (error: NodeJS.ErrnoException) => {
			// An early native exit may close stdin before it has read the input.
			// Let close report the actual exit, including an exit-0 empty reply.
			if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
				stop(new AnyDocConversionError("io", "Could not send document to local converter", error));
			}
		});
		worker.stdout.on("error", (error) => stop(new AnyDocConversionError("io", "Could not read local converter output", error)));
		worker.stderr.on("error", (error) => stop(new AnyDocConversionError("io", "Could not read local converter diagnostics", error)));
		worker.stdout.on("data", (chunk: Buffer) => {
			if (failure !== undefined) return;
			outputBytes += chunk.length;
			if (outputBytes > MAX_DOCUMENT_TEXT_BYTES + MAX_HEADER_BYTES) {
				stop(new AnyDocConversionError("resourceLimit", "Local document converter output exceeded its byte limit"));
			} else {
				chunks.push(chunk);
			}
		});
		worker.stderr.on("data", (chunk: Buffer) => {
			// Drain small diagnostics without retaining or exposing native dumps.
			diagnosticBytes += chunk.length;
			if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
				stop(new AnyDocConversionError("resourceLimit", "Local document converter diagnostics exceeded their byte limit"));
			}
		});
		worker.once("close", (code, exitSignal) => {
			// Settle only after close: SIGKILL stops native tasks and close joins
			// the child and its pipes before the caller can start another attempt.
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			if (failure !== undefined) return reject(failure);
			if (code !== 0) {
				return reject(new AnyDocConversionError("malformed", `Local document converter stopped with ${exitSignal === null ? `exit code ${code}` : `signal ${exitSignal}`}`));
			}
			try {
				resolve(parseDocumentReply(Buffer.concat(chunks, outputBytes)));
			} catch (error) {
				reject(error instanceof AnyDocConversionError ? error : new AnyDocConversionError("malformed", "Local document converter returned an invalid result", error));
			}
		});
		if (signal.aborted) onAbort();
		else worker.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	});
}

function parseDocumentReply(reply: Buffer): AnyDocResult {
	// One bounded JSON header followed by raw UTF-8, avoiding JSON's potentially
	// sixfold escaping/serialization overhead for the Markdown body.
	const newline = reply.indexOf(0x0a);
	if (newline < 0 || newline >= MAX_HEADER_BYTES) throw new Error("Missing or oversized document reply header");
	const header = JSON.parse(reply.subarray(0, newline).toString("utf8"));
	if (header?.ok === false && isAnyDocErrorCode(header.error?.code) && typeof header.error?.message === "string" && reply.length === newline + 1) {
		throw new AnyDocConversionError(header.error.code, header.error.message.slice(0, 1_000));
	}
	if (header?.ok !== true || !isAnyDocFormat(header.documentFormat)) throw new Error("Invalid document reply header");
	const contentBytes = reply.subarray(newline + 1);
	if (contentBytes.length > MAX_DOCUMENT_TEXT_BYTES) throw new AnyDocConversionError("resourceLimit", "Document Markdown exceeds the 2 MiB limit");
	return { documentFormat: header.documentFormat, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contentBytes) };
}

function isAnyDocFormat(value: unknown): value is AnyDocFormat {
	return typeof value === "string" && (ANYDOC_FORMATS as readonly string[]).includes(value);
}

function isAnyDocErrorCode(value: unknown): value is AnyDocErrorCode {
	return value === "unsupported" || value === "needsOcr" || value === "malformed" || value === "encrypted" || value === "resourceLimit" || value === "missingPart" || value === "io";
}
