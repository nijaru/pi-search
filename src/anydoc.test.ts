import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentConverter } from "./anydoc";
import type { FetchRequest } from "./contracts";
import { SafeFetchError } from "./fetch-errors";
import { fetchContent } from "./fetcher";
import type { DirectTransport } from "./direct-transport";
import type { ResponseBody } from "./ssrf";

const fixtureRoot = join(process.cwd(), "src", "fixtures");
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

function body(bytes: Uint8Array): ResponseBody {
	return {
		async *[Symbol.asyncIterator]() {
			yield bytes;
		},
	};
}

function transportFor(bytes: Uint8Array, contentType: string): DirectTransport {
	return async () => ({
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": contentType }),
		body: body(bytes),
	});
}

const fixtures = [
	{ file: "sample.docx", path: "/document.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", format: "docx", evidence: "Document evidence." },
	{ file: "sample.pptx", path: "/slides.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", format: "pptx", evidence: "Slide evidence." },
	{ file: "sample.xlsx", path: "/workbook.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", format: "xlsx", evidence: "Evidence" },
	{ file: "sample.odt", path: "/notes.odt", contentType: "application/vnd.oasis.opendocument.text", format: "odt", evidence: "ODT evidence." },
	{ file: "sample.rtf", path: "/notes.rtf", contentType: "application/rtf", format: "rtf", evidence: "RTF evidence." },
	{ file: "sample.epub", path: "/book.epub", contentType: "application/epub+zip", format: "epub", evidence: "EPUB evidence." },
	{ file: "sample.csv", path: "/data.csv", contentType: "text/csv", format: "csv", evidence: "Evidence" },
] as const;

describe("local anydoc document conversion", () => {
	for (const fixture of fixtures) {
		it(`converts ${fixture.format} through web_fetch`, async () => {
			const bytes = await readFile(join(fixtureRoot, fixture.file));
			const request: FetchRequest = { url: `https://example.test${fixture.path}` };
			const result = await fetchContent(request, undefined, {
				lookup: publicLookup,
				transport: transportFor(bytes, fixture.contentType),
			});
			expect(result).toMatchObject({
				extraction: "document",
				documentFormat: fixture.format,
				outputFormat: "markdown",
				contentTrust: "untrusted",
			});
			expect(result.content).toContain(fixture.evidence);
		});
	}

	it("preserves direct HTML even when a URL has a document extension", async () => {
		const html = "<html><head><title>Article</title></head><body><article><p>HTML evidence.</p></article></body></html>";
		const result = await fetchContent({ url: "https://example.test/article.docx" }, undefined, {
			lookup: publicLookup,
			transport: transportFor(new TextEncoder().encode(html), "text/html"),
		});
		expect(result).toMatchObject({ extraction: "readability", outputFormat: "markdown" });
		expect(result.content).toContain("HTML evidence.");
	});

	it("converts a document delivered as an octet stream instead of treating it as a PDF", async () => {
		const bytes = await readFile(join(fixtureRoot, "sample.docx"));
		const result = await fetchContent({ url: "https://example.test/download" }, undefined, {
			lookup: publicLookup,
			transport: transportFor(bytes, "application/octet-stream"),
		});
		expect(result).toMatchObject({ extraction: "document", documentFormat: "docx" });
	});

	it("maps AnyDoc format failures without hiding the converter code", async () => {
		const bytes = new TextEncoder().encode("not a supported document");
		await expect(
			fetchContent({ url: "https://example.test/download.bin" }, undefined, {
				lookup: publicLookup,
				transport: transportFor(bytes, "application/octet-stream"),
			}),
		).rejects.toMatchObject({ kind: "unsupportedContentType" });
		await expect(
			fetchContent({ url: "https://example.test/download.bin" }, undefined, {
				lookup: publicLookup,
				transport: transportFor(bytes, "application/octet-stream"),
			}),
		).rejects.toThrow("AnyDoc unsupported");
	});

	it("preserves timeout cancellation while conversion runs outside the event loop", async () => {
		const converter: DocumentConverter = async (_bytes, _formatHint, signal) => new Promise((_, reject) => {
			signal.addEventListener("abort", () => reject(new SafeFetchError({ kind: "canceled", message: "conversion canceled" })), { once: true });
		});
		const bytes = new TextEncoder().encode("{\\rtf1 test}");
		await expect(
			fetchContent({ url: "https://example.test/notes.rtf" }, undefined, {
				lookup: publicLookup,
				transport: transportFor(bytes, "application/rtf"),
				documentConverter: converter,
				timeoutMs: 5,
			}),
		).rejects.toMatchObject({ kind: "timeout" });
	});
});
