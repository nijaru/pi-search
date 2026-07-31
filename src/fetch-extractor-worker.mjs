import { parentPort } from "node:worker_threads";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

if (!parentPort) throw new Error("Fetch extractor worker requires a parent port");

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

parentPort.on("message", (message) => {
	try {
		parentPort.postMessage({ ok: true, result: extractContent(message.sourceText, message.mimeType, message.request) });
	} catch (error) {
		parentPort.postMessage({
			ok: false,
			error: {
				kind: error?.kind === "extraction" ? "extraction" : "unknown",
				message: error?.kind === "extraction" ? error.message : "Local content extraction failed",
			},
		});
	}
});

function extractContent(sourceText, mimeType, request) {
	if (!isHtmlContentType(mimeType)) {
		return { content: sourceText, outputFormat: "text", extraction: "plain-text" };
	}

	const { document } = parseHTML(sourceText);
	const documentTitle = document.querySelector("title")?.textContent?.trim() || undefined;
	if (!request.readable) {
		if (request.format === "html") return { content: sourceText, outputFormat: "html", extraction: "raw", title: documentTitle };
		if (request.format === "text") {
			return { content: document.documentElement?.textContent?.trim() ?? "", outputFormat: "text", extraction: "plain-text", title: documentTitle };
		}
		return { content: turndown.turndown(sourceText), outputFormat: "markdown", extraction: "raw", title: documentTitle };
	}

	let article;
	try {
		article = new Readability(document).parse();
	} catch (error) {
		if (!request.allowRawHtmlFallback) throw extractionError("Readable HTML extraction failed", error);
		return rawFallback(sourceText, documentTitle);
	}
	if (!article || typeof article.content !== "string") {
		if (!request.allowRawHtmlFallback) throw extractionError("Readable HTML extraction returned no article");
		return rawFallback(sourceText, documentTitle);
	}
	const title = article.title?.trim() || documentTitle;
	if (request.format === "html") {
		return { content: article.content, outputFormat: "html", extraction: "readability", ...(title ? { title } : {}) };
	}
	if (request.format === "text") {
		return { content: article.textContent?.trim() ?? "", outputFormat: "text", extraction: "readability", ...(title ? { title } : {}) };
	}
	return { content: turndown.turndown(article.content), outputFormat: "markdown", extraction: "readability", ...(title ? { title } : {}) };
}

function extractionError(message, cause) {
	const error = new Error(message, { cause });
	error.kind = "extraction";
	return error;
}

function rawFallback(sourceText, title) {
	return {
		content: sourceText,
		outputFormat: "html",
		extraction: "raw",
		...(title ? { title } : {}),
		fellBackToRaw: true,
	};
}

function isHtmlContentType(mimeType) {
	return mimeType === "text/html" || mimeType === "application/xhtml+xml";
}
