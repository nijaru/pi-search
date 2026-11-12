import { createRequire } from "node:module";

// One document per process. Limits come from the supervisor; stdin is raw
// document bytes, stdout is a JSON header + newline + raw UTF-8 Markdown.
const [formatHint, inputLimitArg, outputLimitArg] = process.argv.slice(2);
const inputLimit = Number(inputLimitArg);
const outputLimit = Number(outputLimitArg);
const errorCodes = new Set(["unsupported", "needsOcr", "malformed", "encrypted", "resourceLimit", "missingPart", "io"]);

try {
	if (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || !Number.isSafeInteger(outputLimit) || outputLimit < 1) {
		throw conversionError("resourceLimit", "Invalid local document conversion limits");
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of process.stdin) {
		length += chunk.length;
		if (length > inputLimit) throw conversionError("resourceLimit", "Document input exceeds its byte limit");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks, length);
	// Resolve relative to this shipped source file, not the caller's cwd. Never
	// opt into hosted OCR, even when Firecrawl credentials are in the environment.
	const anydoc = createRequire(import.meta.url)("@firecrawl/anydoc");
	const detected = anydoc.formatFromBytes(bytes);
	const hinted = !formatHint ? null : anydoc.formatFromExtension(formatHint);
	const format = detected ?? hinted;
	if (format === null) throw conversionError("unsupported", "AnyDoc could not identify a supported document format");
	const content = await anydoc.toMarkdownBytes(bytes, format, { ocr: "reject" });
	if (typeof content !== "string") throw conversionError("malformed", "AnyDoc returned an invalid Markdown result");
	// This check bounds IPC, not native conversion memory. AnyDoc materializes
	// the entire string first, but only in this killable, disposable subprocess.
	if (Buffer.byteLength(content, "utf8") > outputLimit) {
		throw conversionError("resourceLimit", "Document Markdown exceeds the 2 MiB limit");
	}
	await write(`${JSON.stringify({ ok: true, documentFormat: format })}\n`);
	await write(content);
} catch (error) {
	await write(`${JSON.stringify({
		ok: false,
		error: {
			code: errorCodes.has(error?.code) ? error.code : "malformed",
			// Keep even a multibyte error inside the 4096-byte protocol header.
			message: typeof error?.message === "string" ? error.message.slice(0, 500) : "Local document conversion failed",
		},
	})}\n`);
}
// All writes have completed. Do not leave native library handles keeping the
// subprocess alive after the result is delivered.
process.exit(0);

function write(value) {
	return new Promise((resolve, reject) => {
		process.stdout.write(value, (error) => error ? reject(error) : resolve());
	});
}

function conversionError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
