import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { AnyDocConversionError, convertDocumentWithWorker, MAX_DOCUMENT_INPUT_BYTES, MAX_DOCUMENT_TEXT_BYTES, type DocumentConverter } from "./anydoc";
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
	{ file: "sample.pdf", path: "/report.pdf", contentType: "application/pdf", format: "pdf", evidence: "PDF evidence." },
	{ file: "sample.csv", path: "/data.csv", contentType: "text/csv", format: "csv", evidence: "Evidence" },
] as const;

// Only the native binding is replaced for lifecycle fault injection. The real
// subprocess, package loader, worker protocol and supervisor all run unchanged.
async function withNativeStub(operation: string, test: (pidFile: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-search-anydoc-"));
	const pidFile = join(directory, "pid");
	const binding = join(directory, "binding.cjs");
	await writeFile(binding, `
		require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
		module.exports = {
			formatFromBytes: () => "docx",
			formatFromExtension: () => "docx",
			toMarkdownBytes: async () => { ${operation} },
		};
	`);
	const original = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
	process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
	try {
		await test(pidFile);
	} finally {
		if (original === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
		else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = original;
		// Also clean up if an assertion fails before the supervisor is canceled.
		const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
		if (pid > 0) {
			try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
		}
		await rm(directory, { recursive: true, force: true });
	}
}

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const value = await readFile(path, "utf8").catch(() => "");
		if (Number(value) > 0) return Number(value);
		await Bun.sleep(5);
	}
	throw new Error("Document subprocess did not start");
}

function expectReaped(pid: number): void {
	expect(() => process.kill(pid, 0)).toThrow();
}

// A small, deterministic DEFLATE XLSX with high expansion, not a mocked
// converter result. Every entry has real CRCs and a ZIP central directory.
function compressedWorkbook(rows: number): Buffer {
	const cell = "Expansion evidence ".repeat(60);
	const entries: Record<string, string> = {
		"[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		"_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		"xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
		"xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: rows }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${cell}</t></is></c></row>`).join("")}</sheetData></worksheet>`,
	};
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [path, text] of Object.entries(entries)) {
		const name = Buffer.from(path);
		const data = Buffer.from(text);
		const compressed = deflateRawSync(data);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(8, 8);
		header.writeUInt32LE(Bun.hash.crc32(data), 14);
		header.writeUInt32LE(compressed.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, compressed);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		header.copy(entry, 6, 4, 30);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, name);
		offset += header.length + name.length + compressed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(central.length / 2, 8);
	end.writeUInt16LE(central.length / 2, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

const conversionInput = new Uint8Array([1]);
const liveSignal = (): AbortSignal => new AbortController().signal;

describe("AnyDoc subprocess resource and lifecycle boundary", () => {
	it("rejects a real highly compressed XLSX expansion instead of returning oversized Markdown", async () => {
		const small = await convertDocumentWithWorker(compressedWorkbook(10), "xlsx", liveSignal());
		expect(small).toMatchObject({ documentFormat: "xlsx" });
		expect(small.content).toContain("Expansion evidence");
		const expanded = compressedWorkbook(3000);
		expect(expanded.length).toBeLessThan(100_000);
		await expect(convertDocumentWithWorker(expanded, "xlsx", liveSignal())).rejects.toMatchObject({
			code: "resourceLimit", message: "Document Markdown exceeds the 2 MiB limit",
		});
	});

	it("accepts exactly 2 MiB of UTF-8, rejects multibyte overflow before IPC", async () => {
		await withNativeStub(`return "é".repeat(${MAX_DOCUMENT_TEXT_BYTES / 2});`, async (pidFile) => {
			const result = await convertDocumentWithWorker(conversionInput, undefined, liveSignal());
			expect(Buffer.byteLength(result.content)).toBe(MAX_DOCUMENT_TEXT_BYTES);
			expectReaped(await waitForPid(pidFile));
		});
		await withNativeStub(`return "é".repeat(${MAX_DOCUMENT_TEXT_BYTES / 2 + 1});`, async (pidFile) => {
			await expect(convertDocumentWithWorker(conversionInput, undefined, liveSignal())).rejects.toMatchObject({ code: "resourceLimit" });
			expectReaped(await waitForPid(pidFile));
		});
	});

	it("preserves raw Markdown including BOMs, newlines and multibyte text", async () => {
		const content = "\uFEFF# Evidence\n\n\u0000é 😀";
		await withNativeStub(`return ${JSON.stringify(content)};`, async () => {
			expect((await convertDocumentWithWorker(conversionInput, undefined, liveSignal())).content).toBe(content);
		});
	});

	it("enforces the Markdown body limit even inside the total IPC allowance", async () => {
		await withNativeStub(`
			process.stdout.write('{"ok":true,"documentFormat":"docx"}\\n');
			await new Promise((resolve) => process.stdout.write("x".repeat(${MAX_DOCUMENT_TEXT_BYTES + 1}), resolve));
			process.exit(0);
		`, async () => {
			await expect(convertDocumentWithWorker(conversionInput, undefined, liveSignal())).rejects.toMatchObject({ code: "resourceLimit" });
		});
	});

	it("rejects oversized input and pre-cancellation without starting native conversion", async () => {
		await withNativeStub('throw new Error("must not run");', async (pidFile) => {
			await expect(convertDocumentWithWorker(new Uint8Array(MAX_DOCUMENT_INPUT_BYTES + 1), undefined, liveSignal())).rejects.toMatchObject({ code: "resourceLimit" });
			await expect(convertDocumentWithWorker(conversionInput, undefined, AbortSignal.abort())).rejects.toMatchObject({ kind: "canceled" });
			await expect(readFile(pidFile)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("kills and joins a noncooperative converter before cancellation settles", async () => {
		await withNativeStub("while (true) {}", async (pidFile) => {
			const controller = new AbortController();
			const pending = convertDocumentWithWorker(conversionInput, undefined, controller.signal);
			void pending.catch(() => {});
			const pid = await waitForPid(pidFile);
			controller.abort();
			await expect(pending).rejects.toMatchObject({ kind: "canceled" });
			expectReaped(pid);
		});
	});

	for (const stream of ["stdout", "stderr"] as const) {
		it(`kills and joins a converter flooding ${stream}`, async () => {
			const size = stream === "stdout" ? MAX_DOCUMENT_TEXT_BYTES + 65_536 : 65_536;
			await withNativeStub(`process.${stream}.write(Buffer.alloc(${size})); await new Promise(() => setInterval(() => {}, 1000));`, async (pidFile) => {
				await expect(convertDocumentWithWorker(conversionInput, undefined, liveSignal())).rejects.toMatchObject({ code: "resourceLimit" });
				expectReaped(await waitForPid(pidFile));
			});
		});
	}

	for (const operation of ["process.exit(0);", "process.exit(7);", 'process.kill(process.pid, "SIGKILL");', 'process.stdout.write("invalid protocol\\n"); return "body";']) {
		it(`rejects missing/invalid results or native failure: ${operation}`, async () => {
			await withNativeStub(operation, async (pidFile) => {
				await expect(convertDocumentWithWorker(conversionInput, undefined, liveSignal())).rejects.toMatchObject({ code: "malformed" });
				expectReaped(await waitForPid(pidFile));
			});
		});
	}

	for (const code of ["unsupported", "needsOcr", "malformed", "encrypted", "resourceLimit", "missingPart", "io"]) {
		it(`preserves native ${code} errors in a bounded reply`, async () => {
			await withNativeStub(`throw Object.assign(new Error("\\u0000".repeat(100_000)), { code: ${JSON.stringify(code)} });`, async () => {
				await expect(convertDocumentWithWorker(conversionInput, undefined, liveSignal())).rejects.toMatchObject({ code, message: "\u0000".repeat(500) });
			});
		});
	}

	it("resolves the shipped .mjs worker's dependency outside the project cwd under Node", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-search-anydoc-cwd-"));
		try {
			const result = spawnSync("node", [fileURLToPath(new URL("./anydoc-worker.mjs", import.meta.url)), "csv", String(MAX_DOCUMENT_INPUT_BYTES), String(MAX_DOCUMENT_TEXT_BYTES)], {
				cwd: directory,
				input: "Header,Value\nEvidence,42\n",
				maxBuffer: MAX_DOCUMENT_TEXT_BYTES + 4096,
				timeout: 5000,
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout.toString()).toContain('"documentFormat":"csv"');
			expect(result.stdout.toString()).toContain("Evidence");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

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

	it("surfaces AnyDoc needsOcr as an explicit unsupported-content failure", async () => {
		const converter: DocumentConverter = async () => {
			throw new AnyDocConversionError("needsOcr", "PDF pages 1-3 are scanned and need OCR");
		};
		const bytes = new TextEncoder().encode("%PDF-1.4 scanned");
		await expect(
			fetchContent({ url: "https://example.test/scan.pdf" }, undefined, {
				lookup: publicLookup,
				transport: transportFor(bytes, "application/pdf"),
				documentConverter: converter,
			}),
		).rejects.toMatchObject({ kind: "unsupportedContentType" });
		await expect(
			fetchContent({ url: "https://example.test/scan.pdf" }, undefined, {
				lookup: publicLookup,
				transport: transportFor(bytes, "application/pdf"),
				documentConverter: converter,
			}),
		).rejects.toThrow("AnyDoc needsOcr");
	});

	it("maps malformed PDF conversion through the AnyDoc error boundary", async () => {
		const bytes = new TextEncoder().encode("%PDF-1.4\\n");
		await expect(
			fetchContent({ url: "https://example.test/report.pdf" }, undefined, {
				lookup: publicLookup,
				transport: transportFor(bytes, "application/pdf"),
			}),
		).rejects.toThrow("AnyDoc malformed");
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
