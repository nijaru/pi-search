import { describe, expect, it } from "bun:test";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FetchRequest } from "./contracts";
import { SafeFetchError } from "./fetch-errors";
import { fetchContent } from "./fetcher";
import type { DirectTransport } from "./direct-transport";
import type { ResponseBody, TransportResponse } from "./ssrf";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

function body(chunks: Array<string | Uint8Array>, onClose?: () => void): ResponseBody {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
		},
		cancel: onClose,
		destroy: onClose,
	};
}

function transportFor(
	content: string,
	contentType = "text/html; charset=utf-8",
	extra: { contentLength?: string; status?: number; body?: ResponseBody } = {},
): DirectTransport {
	return async () => ({
		status: extra.status ?? 200,
		statusText: "OK",
		headers: new Headers({
			"content-type": contentType,
			...(extra.contentLength === undefined ? {} : { "content-length": extra.contentLength }),
		}),
		body: extra.body ?? body([content]),
	});
}

const baseRequest: FetchRequest = { url: "https://example.test/article" };

describe("direct content fetch", () => {
	it("extracts readable HTML locally and reports provenance metadata", async () => {
		const result = await fetchContent(
			baseRequest,
			undefined,
			{
				lookup: publicLookup,
				transport: transportFor("<html><head><title>Ignored title</title></head><body><article><h1>Useful title</h1><p>Readable evidence.</p></article></body></html>"),
				now: () => new Date("2025-01-02T03:04:05.000Z"),
			},
		);
		expect(result).toMatchObject({
			url: "https://example.test/article",
			contentTrust: "untrusted",
			outputFormat: "markdown",
			extraction: "readability",
			status: 200,
			redirectCount: 0,
			fetchedAt: "2025-01-02T03:04:05.000Z",
			truncated: false,
		});
		expect(result.content).toContain("Readable evidence.");
		expect(result.title).toContain("Ignored title");
	});

	it("returns text and JSON as plain text without HTML extraction", async () => {
		const text = await fetchContent(
			{ url: baseRequest.url, format: "text" },
			undefined,
			{ lookup: publicLookup, transport: transportFor("hello\nworld", "text/plain") },
		);
		expect(text).toMatchObject({ content: "hello\nworld", outputFormat: "text", extraction: "plain-text" });

		const json = await fetchContent(
			{ url: baseRequest.url },
			undefined,
			{ lookup: publicLookup, transport: transportFor('{"answer":42}', "application/json") },
		);
		expect(json.content).toBe('{"answer":42}');
		expect(json.outputFormat).toBe("text");
	});

	it("falls back to bounded raw HTML when Readability cannot extract", async () => {
		const html = "<html><head><title>Shell</title></head><body><script>document.write('dynamic')</script></body></html>";
		const result = await fetchContent(
			baseRequest,
			undefined,
			{ lookup: publicLookup, transport: transportFor(html) },
		);
		expect(result).toMatchObject({ outputFormat: "html", extraction: "raw", fellBackToRaw: true });
		expect(result.warnings[0]?.code).toBe("raw-fallback");
		expect(result.content).toBe(html);

		await expect(
			fetchContent(
				{ ...baseRequest, allowRawHtmlFallback: false },
				undefined,
				{ lookup: publicLookup, transport: transportFor(html) },
			),
		).rejects.toMatchObject({ kind: "extraction" });
	});

	it("rejects binary and PDF content before reading it", async () => {
		let read = false;
		const binaryBody = body(["not read"], () => { read = true; });
		const unsupported = fetchContent(baseRequest, undefined, {
			lookup: publicLookup,
			transport: transportFor("", "application/pdf", { body: binaryBody }),
		});
		await expect(unsupported).rejects.toMatchObject({ kind: "extraction" });
		await expect(unsupported).rejects.toThrow("valid PDF header");
		expect(read).toBe(true);
	});

	it("extracts PDF URLs locally without publishing the downloaded file", async () => {
		const script = join(tmpdir(), `pi-search-pdftotext-${process.pid}-${Date.now()}.sh`);
		writeFileSync(script, "#!/bin/sh\nprintf 'PDF passage\\n'\n");
		chmodSync(script, 0o700);
		try {
			const result = await fetchContent({ ...baseRequest, url: "https://example.test/report.pdf" }, undefined, {
				lookup: publicLookup,
				pdfCommand: script,
				transport: transportFor("%PDF-test", "application/pdf"),
			});
			expect(result).toMatchObject({ extraction: "pdf", outputFormat: "text", content: "PDF passage", contentTrust: "untrusted" });
		} finally {
			unlinkSync(script);
		}
	});

	it("enforces actual streamed byte limits without Content-Length", async () => {
		let closed = 0;
		await expect(
			fetchContent(baseRequest, undefined, {
				lookup: publicLookup,
				maxResponseBytes: 5,
				transport: transportFor("", "text/plain", {
					body: body(["12", "345", "6"], () => { closed += 1; }),
				}),
			}),
		).rejects.toMatchObject({ kind: "responseTooLarge" });
		expect(closed).toBeGreaterThan(0);
	});

	it("uses Content-Length as an early rejection but never as the only bound", async () => {
		await expect(
			fetchContent(baseRequest, undefined, {
				lookup: publicLookup,
				maxResponseBytes: 5,
				transport: transportFor("tiny", "text/plain", { contentLength: "6" }),
			}),
		).rejects.toMatchObject({ kind: "responseTooLarge" });
	});

	it("bounds remote-derived titles independently of content length", async () => {
		const title = "t".repeat(100_000);
		const result = await fetchContent(
			baseRequest,
			undefined,
			{ lookup: publicLookup, transport: transportFor(`<html><head><title>${title}</title></head><body><article><p>body</p></article></body></html>`) },
		);
		expect(result.title?.length).toBeLessThanOrEqual(500);
	});

	it("returns bounded pages with offsets and nextOffset", async () => {
		const result = await fetchContent(
			{ ...baseRequest, format: "text", offset: 2, maxLength: 4 },
			undefined,
			{ lookup: publicLookup, transport: transportFor("0123456789", "text/plain") },
		);
		expect(result).toMatchObject({ content: "2345", offset: 2, truncated: true, nextOffset: 6, totalCharacters: 10 });
		expect(result.warnings[0]?.code).toBe("truncated");
	});

	it("distinguishes timeout and caller cancellation", async () => {
		const waiting: DirectTransport = async (_target, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new SafeFetchError({ kind: "canceled", message: "aborted" })), { once: true });
		});
		await expect(fetchContent(baseRequest, undefined, { lookup: publicLookup, transport: waiting, timeoutMs: 5 })).rejects.toMatchObject({ kind: "timeout" });

		const controller = new AbortController();
		const pending = fetchContent(baseRequest, controller.signal, { lookup: publicLookup, transport: waiting, timeoutMs: 1_000 });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "canceled" });
	});

	it("dispatches YouTube URLs to bounded local captions without direct HTTP", async () => {
		const script = join(tmpdir(), `pi-search-ytdlp-${process.pid}-${Date.now()}.sh`);
		writeFileSync(script, "#!/bin/sh\nout=''\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"--output\" ]; then shift; out=\"$1\"; fi\n  shift\ndone\nout=$(printf '%s' \"$out\" | sed 's/%(ext)s/vtt/')\nprintf 'WEBVTT\\n\\n00:00.000 --> 00:01.000\\nCaption text\\n' > \"$out\"\n");
		chmodSync(script, 0o700);
		try {
			const result = await fetchContent({ url: "https://youtu.be/abc12345678" }, undefined, { youtubeCommand: script });
			expect(result).toMatchObject({
				url: "https://www.youtube.com/watch?v=abc12345678",
				sourceUrl: "https://youtu.be/abc12345678",
				extraction: "youtube-transcript",
				outputFormat: "text",
				content: "Caption text",
				contentTrust: "untrusted",
			});
		} finally {
			unlinkSync(script);
		}
	});

	it("maps non-success HTTP responses to typed failures", async () => {
		await expect(
			fetchContent(baseRequest, undefined, {
				lookup: publicLookup,
				transport: transportFor("no", "text/plain", { status: 503 }),
			}),
		).rejects.toMatchObject({ kind: "http", status: 503, retryable: true });
	});
});
