import { parentPort } from "node:worker_threads";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { extractXDom } from "./x-dom.mjs";

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
	if (isMarkdownContentType(mimeType)) {
		return { content: sourceText, outputFormat: "markdown", extraction: "markdown" };
	}
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

	const sourceUrl = new URL(request.url);
	if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(sourceUrl.hostname) && /\/(?:status|article)\//.test(sourceUrl.pathname)) {
		const selected = extractXDom(document, { url: request.url, postId: sourceUrl.pathname.match(/\/status\/(\d+)/)?.[1] });
		if (!selected) throw extractionError("X returned no readable post or Article body; login pages and previews are not evidence");
		if (selected.collapsedPostIds?.length) throw extractionError("X returned collapsed post previews, not full text");
		if (request.format === "html") return { content: selected.html, outputFormat: "html", extraction: "x-article", title: selected.title };
		if (request.format === "text") {
			const { document: selectedDocument } = parseHTML(`<html><body>${selected.html}</body></html>`);
			return { content: selectedDocument.documentElement.textContent.trim(), outputFormat: "text", extraction: "x-article", title: selected.title };
		}
		return { content: turndown.turndown(selected.html), outputFormat: "markdown", extraction: "x-article", title: selected.title };
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

function isMarkdownContentType(mimeType) {
	return mimeType === "text/markdown" || mimeType === "text/x-markdown";
}

function isHtmlContentType(mimeType) {
	return mimeType === "text/html" || mimeType === "application/xhtml+xml";
}
