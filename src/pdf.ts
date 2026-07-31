import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeFetchError } from "./fetch-errors";

export const DEFAULT_PDF_MAX_PAGES = 100;
export const MAX_PDF_PAGES = 500;
export const DEFAULT_PDF_TEXT_BYTES = 2 * 1024 * 1024;

export interface PdfExtractorOptions {
	readonly command?: string;
	readonly maxPages?: number;
	readonly maxOutputBytes?: number;
	readonly signal: AbortSignal;
	readonly spawnImpl?: (command: string, args: readonly string[], options: Record<string, unknown>) => any;
}

export interface PdfTextResult {
	readonly text: string;
	readonly bytesRead: number;
}

function canceled(): SafeFetchError {
	return new SafeFetchError({ kind: "canceled", message: "PDF extraction canceled" });
}

function extraction(message: string, cause?: unknown): SafeFetchError {
	return new SafeFetchError({ kind: "extraction", message, cause });
}

function appendBytes(chunks: Uint8Array[], chunk: unknown, current: number, max: number): number {
	const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
	const next = current + bytes.byteLength;
	if (next > max) throw new SafeFetchError({ kind: "responseTooLarge", message: "PDF text exceeds the configured extraction limit" });
	chunks.push(bytes);
	return next;
}

async function runPdfToText(
	command: string,
	inputPath: string,
	maxPages: number,
	maxOutputBytes: number,
	signal: AbortSignal,
	spawnImpl: NonNullable<PdfExtractorOptions["spawnImpl"]>,
): Promise<Uint8Array> {
	if (signal.aborted) return Promise.reject(canceled());
	return new Promise<Uint8Array>((resolve, reject) => {
		let child: any;
		let settled = false;
		let terminationError: SafeFetchError | undefined;
		let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutBytes = 0;
		const stdout: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		const finish = (error?: unknown): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
			if (error !== undefined) reject(error);
			else {
				const result = new Uint8Array(stdoutBytes);
				let offset = 0;
				for (const chunk of stdout) {
					result.set(chunk, offset);
					offset += chunk.byteLength;
				}
				resolve(result);
			}
		};
		const kill = (): void => {
			try {
				if (child?.pid && process.platform !== "win32") {
					try { process.kill(-child.pid, "SIGKILL"); } catch { /* group may already be gone */ }
				}
				child?.kill?.("SIGKILL");
			} catch {
				// Cleanup is best effort; the process result remains failed.
			}
		};
		const terminate = (error: SafeFetchError): void => {
			if (settled || terminationError !== undefined) return;
			terminationError = error;
			kill();
			fallbackTimer = setTimeout(() => finish(error), 1_000);
		};
		const onAbort = (): void => terminate(canceled());
		try {
			child = spawnImpl(command, ["-q", "-enc", "UTF-8", "-f", "1", "-l", String(maxPages), inputPath, "-"], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			signal.addEventListener("abort", onAbort, { once: true });
			child.stdout?.on("data", (chunk: unknown) => {
				if (settled) return;
				try {
					stdoutBytes = appendBytes(stdout, chunk, stdoutBytes, maxOutputBytes);
				} catch (error) {
					terminate(error instanceof SafeFetchError ? error : extraction("PDF output exceeded the extraction limit", error));
				}
			});
			child.stderr?.on("data", (chunk: unknown) => {
				if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 16_384) {
					try { appendBytes(stderr, chunk, stderr.reduce((sum, item) => sum + item.byteLength, 0), 16_384); } catch { /* diagnostics are bounded */ }
				}
			});
			child.once("error", (error: unknown) => finish(terminationError ?? extraction(`PDF extraction command failed: ${error instanceof Error ? error.message : String(error)}`, error)));
			if (signal.aborted) onAbort();
			child.once("close", (code: number | null) => {
				if (settled) return;
				if (terminationError !== undefined) return finish(terminationError);
				if (signal.aborted) return finish(canceled());
				if (code !== 0) {
					const diagnostic = new TextDecoder().decode(Uint8Array.from(stderr.flatMap((chunk) => [...chunk]))).trim().slice(0, 500);
					return finish(extraction(diagnostic.length > 0 ? `PDF parser exited with ${code}: ${diagnostic}` : `PDF parser exited with ${code}`));
				}
				finish();
			});
		} catch (error) {
			finish(extraction(`PDF extraction command could not start: ${error instanceof Error ? error.message : String(error)}`, error));
		}
	});
}

export async function extractPdfText(bytes: Uint8Array, options: PdfExtractorOptions): Promise<PdfTextResult> {
	if (options.signal.aborted) throw canceled();
	if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
		throw extraction("Response was identified as PDF but did not contain a valid PDF header");
	}
	const maxPages = options.maxPages ?? DEFAULT_PDF_MAX_PAGES;
	if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PDF_PAGES) {
		throw new SafeFetchError({ kind: "invalidRequest", message: `maxPages must be between 1 and ${MAX_PDF_PAGES}` });
	}
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PDF_TEXT_BYTES;
	if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > DEFAULT_PDF_TEXT_BYTES) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "max PDF text bytes are outside the supported bound" });
	}
	const directory = await mkdtemp(join(tmpdir(), "pi-search-pdf-"));
	const inputPath = join(directory, "document.pdf");
	try {
		await writeFile(inputPath, bytes);
		const output = await runPdfToText(options.command ?? "pdftotext", inputPath, maxPages, maxOutputBytes, options.signal, options.spawnImpl ?? (spawn as unknown as NonNullable<PdfExtractorOptions["spawnImpl"]>));
		const text = new TextDecoder("utf-8", { fatal: false }).decode(output).trim();
		if (text.length === 0) throw extraction("PDF contains no extractable text; scanned PDFs require OCR, which is not enabled");
		return { text, bytesRead: output.byteLength };
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}
