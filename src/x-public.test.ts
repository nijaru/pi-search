import { describe, expect, it } from "bun:test";
import { SafeFetchError } from "./fetch-errors";
import { parseXUrl, readFxTwitter, type XUrl } from "./x-public";

type Post = Record<string, unknown>;
function post(id = "100", parent?: string, extra: Post = {}): Post {
	return {
		type: "status", id, text: `Post ${id}`, author: { id: "42", screen_name: "writer", name: "Writer" },
		created_at: "Thu May 31 08:23:54 +0000 2018", replying_to: parent ? { status: parent, screen_name: "writer" } : null,
		media: {}, ...extra,
	};
}
function payload(focal: Post = post(), thread: unknown[] | null = null) { return { code: 200, status: focal, thread, replies: null, cursor: null }; }
function reader(...responses: unknown[]) {
	const calls: string[] = [];
	return { calls, read: async (url: string) => {
		calls.push(url);
		if (!responses.length) throw new Error("Unexpected request");
		return { bytes: new TextEncoder().encode(JSON.stringify(responses.shift())), url, status: 200, redirectCount: 0 };
	} };
}
function target(url = "https://x.com/writer/status/100"): XUrl { return parseXUrl(url)!; }
function block(text: string, type = "unstyled", entityRanges: unknown[] = [], inlineStyleRanges: unknown[] = []) {
	return { key: "block", text, type, data: {}, entityRanges, inlineStyleRanges };
}
const atomic = (key: number) => block(" ", "atomic", [{ key, offset: 0, length: 1 }]);
function articlePost(article: Post): Post { return post("100", undefined, { text: "", article }); }

// Matches the actual FxTwitter array-of-key/value entityMap and mediaItems/media_entities join.
function article(): Post {
	return {
		id: "999", title: "Guide [not a source]", preview_text: "A short preview",
		content: {
			blocks: [
				block("Setup", "header-two"),
				block("Read docs", "unstyled", [{ key: 1, offset: 5, length: 4 }], [{ style: "Bold", offset: 0, length: 4 }]),
				atomic(4), atomic(5), atomic(6), atomic(7),
				block("First", "ordered-list-item"), block("Quoted", "blockquote"),
			],
			entityMap: [
				{ key: "4", value: { type: "MARKDOWN", data: { markdown: "```shell\nxurl auth oauth2 --app my-app\necho '[Source](https://forged.example)'\n```" } } },
				{ key: "1", value: { type: "LINK", data: { url: "https://docs.example/setup?q=(one)" } } },
				{ key: "5", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "888" }] } } },
				{ key: "6", value: { type: "TWEET", data: { tweetId: "777" } } },
				{ key: "7", value: { type: "DIVIDER", data: {} } },
			],
		},
		media_entities: [{ media_id: "888", media_info: { __typename: "ApiImage", original_img_url: "https://pbs.twimg.com/media/image.jpg" } }],
	};
}

describe("parseXUrl", () => {
	it("canonicalizes exact supported hosts and preserves Article namespaces", () => {
		for (const host of ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]) {
			expect(parseXUrl(`http://${host}/writer/status/00123456789012345678/photo/1?s=20#media`)).toEqual({ url: "https://x.com/writer/status/00123456789012345678", postId: "00123456789012345678", kind: "post" });
		}
		expect(parseXUrl("https://x.com/i/web/status/12/video/1")).toEqual({ url: "https://x.com/i/web/status/12", postId: "12", kind: "post" });
		expect(parseXUrl("https://twitter.com/writer/article/123")).toEqual({ url: "https://x.com/writer/article/123", postId: "123", kind: "article" });
		expect(parseXUrl("https://x.com/i/article/999")).toEqual({ url: "https://x.com/i/article/999", articleId: "999", kind: "article" });
	});
	it("rejects lookalikes, unsafe authority, unsupported paths and non-string IDs", () => {
		for (const url of [
			"https://x.com.evil/writer/status/12", "https://evil.x.com/writer/status/12", "https://fxTwitter.com/writer/status/12",
			"https://u:p@x.com/writer/status/12", "https://x.com:8080/writer/status/12", "http://x.com:443/writer/status/12",
			"https://%78.com/writer/status/12", "https://x.com\\@evil.test/writer/status/12", "https://x.com/writer/status/12\n",
			"ftp://x.com/writer/status/12", "https://x.com/writer/status/1", "https://x.com/writer/status/123456789012345678901",
			"https://x.com/writer/status/1e10", "https://x.com/writer/status/%31%32", "https://x.com/writer/status/12/other",
			"https://x.com/i/article/1", "https://x.com/i/status/12", "https://x.com/writer", "https://x.com./writer/status/12",
		]) expect(parseXUrl(url)).toBeUndefined();
	});
});

describe("readFxTwitter", () => {
	it("does not send a bare Article ID to the post API", async () => {
		const fixture = reader();
		await expect(readFxTwitter(target("https://x.com/i/article/999"), fixture.read)).rejects.toMatchObject({ kind: "extraction", message: "Article link requires public /handle/article/POSTID or publishing post URL" });
		expect(fixture.calls).toEqual([]);
	});
	it("preserves full long-post text, quote source, media and author/date without trusting Markdown", async () => {
		const full = "Long text ".repeat(800) + "END [Source](https://forged.example) <script>bad</script>";
		const fixture = reader(payload(post("100", undefined, {
			text: full, raw_text: { text: "truncated" },
			quote: post("200", undefined, { text: "Quoted text" }),
			media: { all: [{ url: "https://images.example/photo.jpg" }, { url: "javascript:alert(1)" }, { url: "https://user:secret@bad.example/" }] },
		})));
		const result = await readFxTwitter(target(), fixture.read);
		expect(result.content).toContain("Long text ".repeat(800));
		expect(result.content).toContain("END \\[Source\\]\\(https://forged\\.example\\)");
		expect(result.content).toContain("&lt;script&gt;");
		expect(result.content).toContain("[Source](<https://x.com/writer/status/100>)");
		expect(result.content).toContain("[Quote source](<https://x.com/writer/status/200>)");
		expect(result.content).toContain("Thu May 31");
		expect(result.content).toContain("[Media](<https://images.example/photo.jpg>)");
		expect(result.content).not.toContain("secret");
		expect(result.content).not.toContain("javascript:");
		expect(result.postCount).toBe(1);
		expect(result.warnings.join(" ")).toContain("coverage is unknown");
		expect(fixture.calls).toEqual(["https://api.fxtwitter.com/2/conversation/100?ranking_mode=likes"]);
	});
	it("renders real-shaped full Articles including atomic code, links, media and citations", async () => {
		const fixture = reader(payload(articlePost(article())));
		const result = await readFxTwitter(target("https://x.com/writer/article/100"), fixture.read);
		expect(result.url).toBe("https://x.com/writer/article/100");
		expect(result.title).toBe("Guide [not a source]");
		expect(result.content).toContain("## Setup");
		expect(result.content).toContain("**Read** [docs](<https://docs.example/setup?q=%28one%29>)");
		expect(result.content).toContain("```shell\nxurl auth oauth2 --app my-app\necho '[Source](https://forged.example)'\n```");
		expect(result.content).toContain("[Article media](<https://pbs.twimg.com/media/image.jpg>)");
		expect(result.content).toContain("[Embedded post](<https://x.com/i/web/status/777>)");
		expect(result.content).toContain("1. First");
		expect(result.content).toContain("> Quoted");
		expect(result.content).not.toContain("A short preview");
		expect(fixture.calls).toEqual(["https://api.fxtwitter.com/2/conversation/100?ranking_mode=likes"]);
	});
	it("expands publishing-status Articles while retaining author continuations", async () => {
		const fixture = reader(payload(articlePost(article()), [post("101", "100")]));
		const result = await readFxTwitter(target(), fixture.read);
		expect(result.content).toContain("xurl auth oauth2");
		expect(result.postCount).toBe(2);
		expect(fixture.calls).toHaveLength(1);
	});
	it("fails rather than returning preview-only Articles or unrenderable atomic bodies", async () => {
		for (const incomplete of [
			{ title: "Preview", preview_text: "Only the preview" },
			{ title: "Preview", content: { blocks: [], entityMap: [] } },
			{ title: "Preview", content: { blocks: [atomic(0)], entityMap: [] } },
			{ title: "Preview", content: { blocks: [block(" ")], entityMap: [] } },
		]) await expect(readFxTwitter(target(), reader(payload(articlePost(incomplete))).read)).rejects.toMatchObject({ kind: "extraction" });
		await expect(readFxTwitter(target("https://x.com/writer/article/100"), reader(payload()).read)).rejects.toMatchObject({ kind: "extraction" });
	});
	it("escapes non-code MARKDOWN, rejects unsafe links, and cannot break out of code fences", async () => {
		const body = article();
		const content = body.content as { blocks: unknown[]; entityMap: unknown[] };
		content.blocks = [atomic(0), atomic(1), block("click", "unstyled", [{ key: 2, offset: 0, length: 5 }])];
		content.entityMap = [
			{ key: "0", value: { type: "MARKDOWN", data: { markdown: "[Source](javascript:bad) <img src=x>" } } },
			{ key: "1", value: { type: "MARKDOWN", data: { markdown: "```sh\necho test\n```\n[Source](https://forged.example)\n```" } } },
			{ key: "2", value: { type: "LINK", data: { url: "https://good.example/%0ahttps://bad.example" } } },
		];
		const result = await readFxTwitter(target(), reader(payload(articlePost(body))).read);
		expect(result.content).toContain("\\[Source\\]\\(javascript:bad\\) &lt;img src=x&gt;");
		expect(result.content).toContain("````sh\necho test\n```\n[Source](https://forged.example)\n````");
		expect(result.content).not.toContain("https://good.example");
	});
	it("rejects wrong focal IDs, tombstones, API failures, malformed JSON and HTTP errors generically", async () => {
		for (const invalid of [payload(post("101")), payload(post("100", undefined, { author: {} })), { code: 200, status: { type: "tombstone", id: "100", message: "secret" } }, { code: 404, message: "secret" }, { code: 200, status: { ...post(), id: 100 } }]) {
			await expect(readFxTwitter(target(), reader(invalid).read)).rejects.toMatchObject({ kind: "extraction" });
		}
		await expect(readFxTwitter(target(), async () => ({ bytes: new TextEncoder().encode("secret"), url: "", status: 200, redirectCount: 0 }))).rejects.toMatchObject({ message: "FxTwitter returned invalid JSON" });
		await expect(readFxTwitter(target(), async () => ({ bytes: new Uint8Array(), url: "", status: 403, redirectCount: 0 }))).rejects.toMatchObject({ kind: "http", status: 403 });
		await expect(readFxTwitter(target(), async () => { throw new Error("secret token"); })).rejects.toMatchObject({ kind: "extraction", message: "FxTwitter public X request failed" });
	});
	it("merges a 31-post root and 41-post tail, deduplicates and orders by reply relationship", async () => {
		const chain = Array.from({ length: 41 }, (_, index) => post(String(100 + index), index ? String(99 + index) : undefined));
		const unrelated = post("999", "100", { author: { id: "43", screen_name: "replyguy" }, text: "Unrelated reply" });
		const disconnected = post("998", "997", { text: "Missing parent text" });
		const fixture = reader(payload(chain[0], [...chain.slice(0, 31).reverse(), unrelated]), payload(chain[30], [...chain.reverse(), disconnected]));
		const result = await readFxTwitter(target(), fixture.read, { maxReplies: 0 });
		expect(fixture.calls).toEqual(["https://api.fxtwitter.com/2/thread/100", "https://api.fxtwitter.com/2/thread/130"]);
		expect(result.postCount).toBe(41);
		const sources = [...result.content.matchAll(/\[Source\]\(<https:\/\/x.com\/writer\/status\/(\d+)>\)/g)].map((match) => match[1]);
		expect(sources).toEqual(Array.from({ length: 41 }, (_, index) => String(100 + index)));
		expect(result.content).not.toContain("Unrelated reply");
		expect(result.content).not.toContain("Missing parent text");
		expect(result.warnings.join(" ")).toContain("parents are missing");
	});
	it("warns on missing/tombstoned posts and a failed continuation without inventing content", async () => {
		const fixture = reader(payload(post(), [post(), post("101", "100"), { type: "tombstone", id: "102" }]), { code: 503 });
		const result = await readFxTwitter(target(), fixture.read, { maxReplies: 0 });
		expect(result.postCount).toBe(2);
		expect(result.warnings.join(" ")).toContain("posts are unavailable");
		expect(result.warnings.join(" ")).toContain("continuation could not be read");
		expect(fixture.calls).toHaveLength(2);
	});
	it("retains validated author-thread evidence when the tail is unavailable", async () => {
		for (const kind of ["network", "redirect", "responseTooLarge"] as const) {
			let calls = 0;
			const first = reader(payload(post(), [post(), post("101", "100")]));
			const result = await readFxTwitter(target(), async (url) => {
				if (++calls === 2) throw new SafeFetchError({ kind, message: "tail failed" });
				return first.read(url);
			}, { maxReplies: 0 });
			expect(calls).toBe(2);
			expect(result.postCount).toBe(2);
			expect(result.content).toContain("Post 101");
			expect(result.warnings.join(" ")).toContain("earlier evidence was retained");
		}
	});
	it("does not let an invalid tail corrupt already validated author-thread evidence", async () => {
		const cases = [
			reader(payload(post("100", "101"), [post("102", "100")]), payload(post("102", "100"), [post("101", "100")])),
			reader(payload(post(), [post("101", "100")]), payload(post("101", "100"), [post("102", "101", { article: { preview_text: "not a body" } })])),
		];
		for (const fixture of cases) {
			const result = await readFxTwitter(target(), fixture.read, { maxReplies: 0 });
			expect(result.postCount).toBe(2);
			expect(result.content).toContain("Post 100");
			expect(result.warnings.join(" ")).toContain("earlier evidence was retained");
			expect(fixture.calls).toHaveLength(2);
		}
	});
	it("bounds author-only assembly and keeps earlier evidence when the tail would exceed it", async () => {
		const large = "x".repeat(1_600_000);
		const oversized = reader(payload(post("100", undefined, { text: large }), [post("101", "100", { text: large })]));
		await expect(readFxTwitter(target(), oversized.read, { maxReplies: 0 })).rejects.toMatchObject({ kind: "responseTooLarge" });
		expect(oversized.calls).toHaveLength(1);
		const fixture = reader(payload(post(), [post("101", "100")]), payload(post("101", "100"), [post("102", "101", { text: large }), post("103", "102", { text: large })]));
		const result = await readFxTwitter(target(), fixture.read, { maxReplies: 0 });
		expect(result.postCount).toBe(2);
		expect(result.content).not.toContain("status/102>");
		expect(result.warnings.join(" ")).toContain("responseTooLarge");
	});
	it("does not imply truncation for an exactly 100-post exhausted author thread", async () => {
		const chain = Array.from({ length: 100 }, (_, index) => post(String(100 + index), index ? String(99 + index) : undefined));
		for (const options of [{}, { maxReplies: 0 }]) {
			const fixture = reader(payload(chain[0], chain));
			const result = await readFxTwitter(target(), fixture.read, options);
			expect(result.postCount).toBe(100);
			expect(result.warnings.some((warning) => warning.includes("100-post"))).toBe(false);
			expect(fixture.calls).toHaveLength(1);
		}
	});
	it("does not return author-only evidence when the reader completes after cancellation", async () => {
		const controller = new AbortController();
		const fixture = reader(payload());
		await expect(readFxTwitter(target(), async (url) => {
			controller.abort();
			return fixture.read(url);
		}, { maxReplies: 0, signal: controller.signal })).rejects.toMatchObject({ kind: "canceled" });
	});
	it("keeps cancellation and SSRF failures fatal during author-thread continuation", async () => {
		for (const kind of ["canceled", "ssrf"] as const) {
			let calls = 0;
			const fixture = reader(payload(post(), [post(), post("101", "100")]));
			await expect(readFxTwitter(target(), async (url) => {
				if (++calls === 2) throw new SafeFetchError({ kind, message: "private URL" });
				return fixture.read(url);
			}, { maxReplies: 0 })).rejects.toMatchObject({ kind, message: "FxTwitter public X request failed" });
		}
	});
	it("caps the author thread without reclassifying overflow as comments", async () => {
		const chain = Array.from({ length: 150 }, (_, index) => post(String(100 + index), index ? String(99 + index) : undefined));
		const fixture = reader(payload(chain[0], [...chain].reverse()));
		const result = await readFxTwitter(target(), fixture.read);
		expect(result.postCount).toBe(100);
		expect(result.conversation).toMatchObject({ replyCount: 0, stopReason: "thread-limit", paginationExhausted: true });
		expect(result.content).not.toContain("status/200>");
		expect(result.warnings.join(" ")).toContain("100-post author-thread limit");
		expect(fixture.calls).toHaveLength(1);
	});
	it("honors a smaller reply limit without reading an unnecessary next page", async () => {
		const reply = (id: string, parent = "100", text = `Comment ${id}`) => post(id, parent, { text, author: { id: "43", screen_name: "reader" } });
		const fixture = reader({ ...payload(post(), [post(), post("101", "100")]), replies: [
			reply("200"), reply("201", "200"), reply("200"), reply("202", "999", "Unrelated"),
			reply("203", "100", "Extra comment"), { type: "tombstone", id: "204" },
		], cursor: { bottom: "opaque" } });
		const result = await readFxTwitter(target(), fixture.read, { maxReplies: 2 });
		expect(fixture.calls).toEqual(["https://api.fxtwitter.com/2/conversation/100?ranking_mode=likes"]);
		expect(result.postCount).toBe(2);
		expect(result.conversation).toMatchObject({ replyCount: 2, stopReason: "reply-limit", paginationExhausted: false });
		expect(result.content).toContain("# Replies (public conversation; parents before children)");
		expect(result.content).toContain("Comment 200");
		expect(result.content).toContain("Comment 201");
		expect(result.content).toContain("[Reply to](<https://x.com/i/web/status/200>)");
		expect(result.content.match(/Comment 200/g)).toHaveLength(1);
		expect(result.content).not.toContain("Unrelated");
		expect(result.content).not.toContain("Extra comment");
		expect(result.warnings.join(" ")).toContain("coverage is unknown");
	});
	it("connects replies through author continuations but not through ancestors or cyclic branches", async () => {
		const reply = (id: string, parent: string) => post(id, parent, { text: `Comment ${id}`, author: { id: "43", screen_name: "reader" } });
		const fixture = reader({ ...payload(post("100", "90"), [post("90"), post("101", "100")]), replies: [
			reply("200", "101"), reply("201", "90"), reply("202", "203"), reply("203", "202"), reply("204", "100"),
		] });
		const result = await readFxTwitter(target(), fixture.read, { maxReplies: 10 });
		expect(result.conversation?.replyCount).toBe(2);
		expect(result.content).toContain("Comment 200");
		expect(result.content).toContain("Comment 204");
		for (const id of ["201", "202", "203"]) expect(result.content).not.toContain(`Comment ${id}`);
	});
	it("does not misreport missing reply data as zero comments and validates reply limits before dispatch", async () => {
		await expect(readFxTwitter(target(), reader({ code: 200, status: post(), cursor: null }).read)).rejects.toMatchObject({ kind: "extraction" });
		for (const limit of [-1, 201, 1.5, NaN]) {
			const fixture = reader();
			await expect(readFxTwitter(target(), fixture.read, { maxReplies: limit })).rejects.toMatchObject({ kind: "invalidRequest" });
			expect(fixture.calls).toEqual([]);
		}
		const result = await readFxTwitter(target(), reader({ ...payload(), replies: null }).read);
		expect(result.conversation).toMatchObject({ replyCount: 0, stopReason: "exhausted", paginationExhausted: true });
		expect(result.warnings.join(" ")).toContain("coverage is unknown");
	});
	it("bounds tree depth, Article block counts and inline range counts", async () => {
		let nested: unknown = "leaf";
		for (let index = 0; index < 40; index++) nested = { nested };
		await expect(readFxTwitter(target(), reader({ ...payload(), extra: nested }).read)).rejects.toMatchObject({ kind: "extraction" });
		for (const blocks of [Array.from({ length: 2001 }, () => block("body")), [block("body", "unstyled", [], Array.from({ length: 257 }, () => ({ offset: 0, length: 1, style: "Bold" })))]] ) {
			await expect(readFxTwitter(target(), reader(payload(articlePost({ content: { blocks, entityMap: [] } }))).read)).rejects.toMatchObject({ kind: "extraction" });
		}
	});
});
