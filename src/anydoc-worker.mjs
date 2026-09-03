import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("AnyDoc worker requires a parent port");

const anydoc = createRequire(import.meta.url)("@firecrawl/anydoc");
const errorCodes = new Set(["unsupported", "needsOcr", "malformed", "encrypted", "resourceLimit", "missingPart", "io"]);

parentPort.on("message", async (message) => {
	try {
		const bytes = message.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(message.bytes);
		const detected = anydoc.formatFromBytes(bytes);
		const hinted = message.formatHint === undefined ? null : anydoc.formatFromExtension(message.formatHint);
		const format = detected ?? hinted;
		if (format === null) throw conversionError("unsupported", "AnyDoc could not identify a supported document format");
		const content = await anydoc.toMarkdownBytes(bytes, format);
		if (typeof content !== "string") throw conversionError("malformed", "AnyDoc returned an invalid Markdown result");
		parentPort.postMessage({ ok: true, result: { content, documentFormat: format } });
	} catch (error) {
		const code = errorCodes.has(error?.code) ? error.code : "malformed";
		parentPort.postMessage({
			ok: false,
			error: {
				code,
				message: typeof error?.message === "string" ? error.message.slice(0, 1_000) : "Local document conversion failed",
			},
		});
	}
});

function conversionError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
