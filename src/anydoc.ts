import { Worker } from "node:worker_threads";
import { SafeFetchError } from "./fetch-errors";

export const ANYDOC_FORMATS = ["doc", "docx", "odt", "ppt", "pptx", "rtf", "epub", "pdf", "xlsx", "ods", "odp", "csv"] as const;
export type AnyDocFormat = (typeof ANYDOC_FORMATS)[number];
export type AnyDocErrorCode = "unsupported" | "malformed" | "encrypted" | "resourceLimit" | "missingPart" | "io";

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
	return new Promise<AnyDocResult>((resolve, reject) => {
		const worker = new Worker(new URL("./anydoc-worker.mjs", import.meta.url));
		let settled = false;
		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			void worker.terminate();
		};
		const finish = (error?: unknown, result?: AnyDocResult): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error === undefined && result !== undefined) resolve(result);
			else reject(error ?? new AnyDocConversionError("malformed", "Local document conversion failed"));
		};
		const onAbort = (): void => finish(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" }));
		signal.addEventListener("abort", onAbort, { once: true });
		worker.once("error", (error) => finish(new AnyDocConversionError("malformed", "Local document converter failed to start", error)));
		worker.once("exit", (code) => {
			if (!settled && code !== 0) finish(new AnyDocConversionError("malformed", `Local document converter stopped with exit code ${code}`));
		});
		worker.once("message", (message: { ok: boolean; result?: AnyDocResult; error?: { code?: string; message?: string } }) => {
			if (!message.ok || message.result === undefined) {
				const code = isAnyDocErrorCode(message.error?.code) ? message.error.code : "malformed";
				finish(new AnyDocConversionError(code, message.error?.message ?? "Local document conversion failed"));
				return;
			}
			if (!isAnyDocFormat(message.result.documentFormat) || typeof message.result.content !== "string") {
				finish(new AnyDocConversionError("malformed", "Local document converter returned an invalid result"));
				return;
			}
			finish(undefined, message.result);
		});
		try {
			const transferable = bytes.slice();
			worker.postMessage({ bytes: transferable, formatHint }, [transferable.buffer]);
		} catch (error) {
			finish(new AnyDocConversionError("malformed", "Local document conversion could not start", error));
		}
	});
}

function isAnyDocFormat(value: unknown): value is AnyDocFormat {
	return typeof value === "string" && (ANYDOC_FORMATS as readonly string[]).includes(value);
}

function isAnyDocErrorCode(value: unknown): value is AnyDocErrorCode {
	return value === "unsupported" || value === "malformed" || value === "encrypted" || value === "resourceLimit" || value === "missingPart" || value === "io";
}
