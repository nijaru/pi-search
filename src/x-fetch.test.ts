import { describe, expect, it } from "bun:test";
import { fetchContent } from "./fetcher";
import { SafeFetchError } from "./fetch-errors";
import type { DirectTransport } from "./direct-transport";
import type { XBrowserReader, XBrowserSelection } from "./x-browser";

const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const url = "https://x.com/alice/status/123";
const post = { type: "status", id: "123", text: "Long public evidence ".repeat(80), author: { id: "42", screen_name: "alice" } };
function transport(payload: unknown, calls: string[], status = 200): DirectTransport {
	return async (target) => {
		calls.push(target.url.href);
		return { status, statusText: "OK", headers: new Headers({ "content-type": "application/json" }), body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(JSON.stringify(payload)); } } };
	};
}
function reader(read: XBrowserSelection["read"] = async () => ({ html: "<p>Private browser evidence</p>", title: "Private post", postCount: 1, bytesRead: 100 }), mode: XBrowserSelection["mode"] = "auto"): XBrowserReader {
	return { async select() { return { mode, read }; } };
}
const browser = reader();

describe("X fetch routing and bounds", () => {
	it("uses free FxTwitter with no configuration and keeps common paging/provenance", async () => {
		const calls: string[] = [];
		const options = { lookup, transport: transport({ code: 200, status: post }, calls) };
		const first = await fetchContent({ url, maxLength: 120 }, undefined, options);
		expect(calls).toEqual(["https://api.fxtwitter.com/2/thread/123"]);
		expect(first).toMatchObject({ url, extraction: "fxtwitter", outputFormat: "markdown", truncated: true, nextOffset: 120, contentTrust: "untrusted" });
		const next = await fetchContent({ url, offset: first.nextOffset, maxLength: 120 }, undefined, options);
		expect(next.offset).toBe(120);
		expect(next.content.length).toBe(120);
		expect(first.warnings.some((w) => w.code === "partial")).toBe(true);
	});

	it("prefers only an authorized browser and never leaks a failed authenticated target to the proxy", async () => {
		const calls: string[] = [];
		const options = { lookup, transport: transport({ code: 200, status: post }, calls), xBrowser: browser };
		const result = await fetchContent({ url }, undefined, options);
		expect(result.extraction).toBe("x-browser");
		expect(result.content).toContain("Private browser evidence");
		expect(result.warnings.some((w) => w.code === "authenticated")).toBe(true);
		expect(calls).toEqual([]);
		await expect(fetchContent({ url }, undefined, { ...options, xBrowser: reader(async () => { throw new SafeFetchError({ kind: "extraction", message: "login expired" }); }) })).rejects.toMatchObject({ kind: "extraction" });
		expect(calls).toEqual([]);
	});

	it("makes explicit modes strict and falls back only when browser access was never enabled", async () => {
		const calls: string[] = [];
		const options = { lookup, transport: transport({ code: 200, status: post }, calls), xBrowser: reader(async () => undefined) };
		await expect(fetchContent({ url, xMode: "browser" }, undefined, options)).rejects.toThrow("not authorized");
		expect(calls).toEqual([]);
		expect((await fetchContent({ url }, undefined, options)).extraction).toBe("fxtwitter");
		expect((await fetchContent({ url, xMode: "public" }, undefined, { ...options, xBrowser: browser })).extraction).toBe("fxtwitter");
		expect(calls).toHaveLength(2);
	});

	it("does not let tool arguments override a persistent direct-only user policy", async () => {
		const calls: string[] = [];
		const result = await fetchContent({ url, xMode: "public" }, undefined, {
			lookup, transport: transport({ direct: true }, calls),
			xBrowser: reader(async () => { throw new Error("must not use the browser"); }, "direct"),
		});
		expect(calls).toEqual([url]);
		expect(result.extraction).toBe("plain-text");
	});

	it("counts bytes across both public thread requests", async () => {
		const second = { ...post, id: "124", text: "continued", replying_to: { status: "123" } };
		const payload = { code: 200, status: post, thread: [post, second] };
		const bytes = new TextEncoder().encode(JSON.stringify(payload));
		let calls = 0;
		await expect(fetchContent({ url }, undefined, {
			lookup, maxResponseBytes: bytes.byteLength + 10,
			transport: async () => { calls++; return { status: 200, statusText: "OK", headers: new Headers(), body: { async *[Symbol.asyncIterator]() { yield bytes; } } }; },
		})).rejects.toMatchObject({ kind: "responseTooLarge" });
		expect(calls).toBe(2);
	});

	it("enforces aggregate bytes, upstream errors, SSRF, and cancellation on the proxy path", async () => {
		const calls: string[] = [];
		const options = { lookup, transport: transport({ code: 200, status: post }, calls) };
		await expect(fetchContent({ url }, undefined, { ...options, maxResponseBytes: 100 })).rejects.toMatchObject({ kind: "responseTooLarge" });
		await expect(fetchContent({ url }, undefined, { ...options, transport: transport({}, calls, 429) })).rejects.toMatchObject({ kind: "http", status: 429 });
		await expect(fetchContent({ url }, undefined, { ...options, lookup: async () => [{ address: "127.0.0.1", family: 4 }] })).rejects.toMatchObject({ kind: "ssrf" });
		const controller = new AbortController(); controller.abort();
		await expect(fetchContent({ url }, controller.signal, options)).rejects.toMatchObject({ kind: "canceled" });
	});

	it("keeps every direct-thread post in text output and rejects collapsed previews", async () => {
		let html = '<html><body><article data-testid="tweet"><a href="/alice/status/123"><time>date</time></a><div data-testid="tweetText">First evidence</div></article><article data-testid="tweet"><a href="/alice/status/124"><time>date</time></a><div data-testid="tweetText">Second evidence</div></article></body></html>';
		const source: DirectTransport = async () => ({ status: 200, statusText: "OK", headers: new Headers({ "content-type": "text/html" }), body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(html); } } });
		const result = await fetchContent({ url, xMode: "direct", format: "text" }, undefined, { lookup, transport: source });
		expect(result.content).toContain("First evidence");
		expect(result.content).toContain("Second evidence");
		html = html.replace("First evidence", 'Preview<span data-testid="tweet-text-show-more-link">Show more</span>');
		await expect(fetchContent({ url, xMode: "direct" }, undefined, { lookup, transport: source })).rejects.toMatchObject({ kind: "extraction" });
	});

	it("extracts full server-rendered Articles even inside hidden streaming containers", async () => {
		const articleUrl = "https://x.com/i/article/456";
		const documents = [
			'<html><head><title>Full article</title></head><body><div hidden id="S:0"><h1>Title</h1><div class="x-article-body"><h2>Heading</h2><p>Article evidence</p><pre><code>const answer = 42;</code></pre></div></div></body></html>',
			'<html><body><h1>Unrelated heading</h1><div data-testid="twitter-article-title">Title</div><div data-testid="twitterArticleRichTextView"><h2><div><span>Heading</span></div></h2><p>Article evidence</p><pre><code>const answer = 42;</code></pre></div></body></html>',
		];
		let html = documents[0]!;
		const calls: string[] = [];
		const source: DirectTransport = async (target) => {
			calls.push(target.url.href);
			return { status: 200, statusText: "OK", headers: new Headers({ "content-type": "text/html" }), body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(html); } } };
		};
		for (html of documents) {
			const result = await fetchContent({ url: articleUrl }, undefined, { lookup, transport: source });
			expect(result).toMatchObject({ extraction: "x-article", title: "Title", truncated: false });
			expect(result.content).toContain("## Heading");
			expect(result.content).toContain("```\nconst answer = 42;\n```");
		}
		expect(calls).toEqual([articleUrl, articleUrl]);
		const loginPage: DirectTransport = async () => ({ status: 200, statusText: "OK", headers: new Headers({ "content-type": "text/html" }), body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode("<html><body><h1>Log in to X</h1><p>Not the Article body.</p></body></html>"); } } });
		for (const xMode of [undefined, "direct"] as const) {
			await expect(fetchContent({ url: articleUrl, xMode }, undefined, { lookup, transport: loginPage })).rejects.toMatchObject({ kind: "extraction" });
		}
	});
});
