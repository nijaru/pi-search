import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { extractXDom } from "./x-dom.mjs";

const target = { url: "https://x.com/alice/status/123", postId: "123" };
const post = (author: string, id: string, text: string) => `<article data-testid="tweet"><a href="/${author}/status/${id}"><time datetime="2026-01-01">date</time></a><div data-testid="tweetText">${text}</div></article>`;

describe("fixed X DOM extraction", () => {
	it("selects the focal post rather than its ancestors or replies and bounds author continuation", () => {
		const { document } = parseHTML(`<html><body>${post("bob", "111", "ancestor")}${post("alice", "123", "selected")}${post("alice", "124", "continuation")}${post("bob", "125", "reply")}${post("alice", "126", "later reply")}</body></html>`);
		const result = extractXDom(document, target)!;
		expect(result.postCount).toBe(2);
		expect(result.html).toContain("selected");
		expect(result.html).toContain("continuation");
		expect(result.html).not.toContain("ancestor");
		expect(result.html).not.toContain("later reply");
	});
	it("preserves a photo-only focal post and never substitutes a follow-up", () => {
		const photo = '<article data-testid="tweet"><a href="/alice/status/123"><time>date</time></a><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/example.jpg" alt="Evidence photo"></div></article>';
		const { document } = parseHTML(`<html><body>${photo}${post("alice", "124", "follow-up")}</body></html>`);
		const result = extractXDom(document, target)!;
		expect(result.postCount).toBe(2);
		expect(result.html).toContain("/status/123");
		expect(result.html).toContain("Evidence photo");
		const unsupported = photo.replace(/<div data-testid="tweetPhoto">[\s\S]*<\/div>/, "");
		expect(extractXDom(parseHTML(`<html><body>${unsupported}${post("alice", "124", "follow-up")}</body></html>`).document, target)).toBeNull();
	});

	it("reports collapsed long posts rather than treating their previews as full text", () => {
		const { document } = parseHTML(`<html><body>${post("alice", "123", 'Preview<span data-testid="tweet-text-show-more-link">Show more</span>')}</body></html>`);
		expect(extractXDom(document, target)?.collapsedPostIds).toEqual(["123"]);
	});

	it("keeps Article code but strips active HTML and unsafe links", () => {
		const { document } = parseHTML('<html><body><div hidden><h1>Title</h1><div class="x-article-body"><pre><code>answer(42)</code></pre><p onclick="evil()">text<a href="javascript:evil()">unsafe</a><a href="/alice/status/123">source</a></p><script>evil()</script></div></div></body></html>');
		const articleTarget = { url: "https://x.com/alice/article/123", postId: "123" };
		const result = extractXDom(document, articleTarget)!;
		expect(result.title).toBe("Title");
		expect(result.html).toContain("<pre><code>answer(42)</code></pre>");
		expect(result.html).toContain('href="https://x.com/alice/status/123"');
		expect(result.html).not.toContain("evil()");
		expect(result.html).not.toContain("onclick");
		expect(() => extractXDom(document, articleTarget, 10)).toThrow("limit");
		expect(extractXDom(document, target)).toBeNull();
	});
	it("rejects login chrome, unrelated posts, and ambiguous Article bodies", () => {
		for (const html of ["<p>Sign in to X</p>", post("alice", "124", "unrelated"), '<div class="x-article-body">one</div><div class="x-article-body">two</div>']) {
			expect(extractXDom(parseHTML(html).document, target)).toBeNull();
		}
	});
});
