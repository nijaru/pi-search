import { describe, expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import { SafeFetchError } from "./fetch-errors";
import { MAX_X_CONVERSATION_PAGES, parseXUrl, readFxTwitter } from "./x-public";

const target = parseXUrl("https://x.com/writer/status/100")!;
function post(id = "100", parent?: string, text = `Post ${id}`, author = "42") {
	return { type: "status", id, text, author: { id: author, screen_name: author === "42" ? "writer" : "reader" }, replying_to: parent ? { status: parent } : null };
}
const reply = (id: string, parent = "100", text = `Comment ${id}`) => post(id, parent, text, "43");
function page(replies: unknown[] | null = null, bottom: string | null = null, thread: unknown[] = []) {
	return { code: 200, status: post(), thread, replies, cursor: { bottom } };
}
function response(body: unknown) {
	return { bytes: new TextEncoder().encode(JSON.stringify(body)), url: "https://api.fxtwitter.com/", status: 200, redirectCount: 0 };
}
function reader(...pages: unknown[]) {
	const calls: string[] = [];
	return { calls, read: async (url: string) => {
		calls.push(url);
		if (!pages.length) throw new Error("Unexpected extra request");
		return response(pages.shift());
	} };
}

describe("public X conversation pagination", () => {
	it("follows public conversation cursors by default, deduplicates, and resolves parents across pages", async () => {
		const first = page([reply("201", "200"), reply("202")], "a+/=&?", [post("101", "100")]);
		const fixture = reader(first, page([
			reply("200"), reply("202"), reply("204", "101"), reply("205", "999"), reply("206", "207"), reply("207", "206"),
		], "next"), page([post("102", "101")]));
		const result = await readFxTwitter(target, fixture.read);
		expect(fixture.calls).toEqual([
			"https://api.fxtwitter.com/2/conversation/100?ranking_mode=likes",
			"https://api.fxtwitter.com/2/conversation/100?ranking_mode=likes&cursor=a%2B%2F%3D%26%3F",
			"https://api.fxtwitter.com/2/conversation/100?ranking_mode=likes&cursor=next",
		]);
		expect(result.conversation).toEqual({ pagesRead: 3, replyCount: 4, threadPostCount: 3, paginationExhausted: true, stopReason: "exhausted" });
		expect(result.content.match(/Comment 202/g)).toHaveLength(1);
		expect(result.content.indexOf("Comment 200")).toBeLessThan(result.content.indexOf("Comment 201"));
		expect(result.content).toContain("[Reply to](<https://x.com/i/web/status/200>)");
		for (const id of ["205", "206", "207"]) expect(result.content).not.toContain(`Comment ${id}`);
		expect(result.warnings.join(" ")).toContain("missing or cyclic parent");
		expect(result.warnings.join(" ")).toContain("coverage is unknown");
	});

	it("distinguishes exhausted upstream pages from locally capped replies", async () => {
		for (const extra of [false, true]) {
			const fixture = reader(page([reply("200"), reply("201"), ...(extra ? [reply("202")] : [])]));
			const result = await readFxTwitter(target, fixture.read, { maxReplies: 2 });
			expect(result.conversation).toMatchObject({ pagesRead: 1, replyCount: 2, paginationExhausted: true, stopReason: extra ? "reply-limit" : "exhausted" });
			expect(fixture.calls).toHaveLength(1);
		}
	});

	it("bounds requests even when every new cursor returns duplicate evidence", async () => {
		const fixture = reader(...Array.from({ length: MAX_X_CONVERSATION_PAGES }, (_, index) => page([reply("200")], String(index))));
		const result = await readFxTwitter(target, fixture.read);
		expect(fixture.calls).toHaveLength(MAX_X_CONVERSATION_PAGES);
		expect(result.conversation).toMatchObject({ replyCount: 1, pagesRead: MAX_X_CONVERSATION_PAGES, paginationExhausted: false, stopReason: "page-limit" });
	});

	it("stops repeated and cyclic cursors without requesting them twice", async () => {
		const fixture = reader(page([], "a"), page([], "b"), page([], "a"));
		const result = await readFxTwitter(target, fixture.read);
		expect(fixture.calls).toHaveLength(3);
		expect(result.conversation).toMatchObject({ stopReason: "cursor-loop", paginationExhausted: false });
	});

	it("does not mistake missing or malformed cursors for exhausted pagination", async () => {
		for (const cursor of [undefined, {}, { bottom: "" }, { bottom: 42 }, { bottom: "x".repeat(2049) }, { bottom: "\n" }, { bottom: "\ud800" }]) {
			const fixture = reader({ ...page([reply("200")]), cursor });
			const result = await readFxTwitter(target, fixture.read);
			expect(result.conversation).toMatchObject({ replyCount: 1, paginationExhausted: false, stopReason: "invalid-cursor" });
			expect(fixture.calls).toHaveLength(1);
		}
	});

	it("retains earlier evidence on a later upstream or byte-limit failure without retrying", async () => {
		for (const error of [new SafeFetchError({ kind: "http", status: 429, message: "rate limited" }), new SafeFetchError({ kind: "responseTooLarge", message: "byte limit" })]) {
			let calls = 0;
			const result = await readFxTwitter(target, async () => {
				if (++calls === 1) return response(page([reply("200")], "next"));
				throw error;
			});
			expect(calls).toBe(2);
			expect(result.conversation).toMatchObject({ pagesRead: 1, replyCount: 1, paginationExhausted: false, stopReason: error.kind === "http" ? "upstream-error" : "byte-limit" });
			expect(result.content).toContain("Comment 200");
		}
	});

	it("rejects a wrong focal post on a later page instead of admitting its evidence", async () => {
		const fixture = reader(page([reply("200")], "next"), { ...page([reply("201")]), status: post("999") });
		const result = await readFxTwitter(target, fixture.read);
		expect(result.conversation).toMatchObject({ pagesRead: 1, stopReason: "upstream-error" });
		expect(result.content).not.toContain("Comment 201");
	});

	it("does not let a later cyclic author-thread page corrupt earlier evidence", async () => {
		const fixture = reader({ ...page([reply("200")], "next"), status: post("100", "101") }, page([], null, [post("101", "100")]));
		const result = await readFxTwitter(target, fixture.read);
		expect(result.conversation).toMatchObject({ pagesRead: 1, replyCount: 1, stopReason: "upstream-error" });
		expect(result.content).toContain("Comment 200");
		expect(result.content).not.toContain("Post 101");
		expect(result.warnings.join(" ")).toContain("invalid thread relationships");
	});

	it("does not downgrade SSRF or caller cancellation into a partial success", async () => {
		for (const kind of ["ssrf", "canceled"] as const) {
			let calls = 0;
			await expect(readFxTwitter(target, async () => {
				if (++calls === 1) return response(page([reply("200")], "next"));
				throw new SafeFetchError({ kind, message: "stop" });
			})).rejects.toMatchObject({ kind });
			expect(calls).toBe(2);
		}
		const controller = new AbortController();
		let calls = 0;
		await expect(readFxTwitter(target, async () => {
			calls++;
			controller.abort();
			return response(page());
		}, { signal: controller.signal })).rejects.toMatchObject({ kind: "canceled" });
		expect(calls).toBe(1);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		await expect(readFxTwitter(target, async () => { throw new Error("must not run"); }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: "canceled" });
	});

	it("aborts the active read at its own deadline and retains only previously validated pages", async () => {
		for (const firstPage of [false, true]) {
			let calls = 0;
			let activeSignal: AbortSignal | undefined;
			const pending = readFxTwitter(target, async (_url, signal) => {
				if (++calls === 1 && firstPage) return response(page([reply("200")], "next"));
				activeSignal = signal;
				return new Promise<ReturnType<typeof response>>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new SafeFetchError({ kind: "canceled", message: "aborted" })), { once: true }));
			}, { timeoutMs: 10 });
			if (firstPage) expect((await pending).conversation).toMatchObject({ pagesRead: 1, replyCount: 1, stopReason: "timeout", paginationExhausted: false });
			else await expect(pending).rejects.toMatchObject({ kind: "timeout" });
			expect(activeSignal?.aborted).toBe(true);
			expect(getEventListeners(activeSignal!, "abort")).toHaveLength(0);
		}
	});

	it("bounds retained graph candidates even if no supplied reply can be connected", async () => {
		const fixture = reader(page(Array.from({ length: 1_001 }, (_, index) => reply(String(1000 + index), "999")), "next"));
		const result = await readFxTwitter(target, fixture.read);
		expect(result.conversation).toMatchObject({ replyCount: 0, stopReason: "candidate-limit", paginationExhausted: false });
		expect(fixture.calls).toHaveLength(1);
	});

	it("bounds assembled content and always reserves the requested focal post", async () => {
		const huge = "x".repeat(1_600_000);
		const fixture = reader(page([reply("200", "100", huge), reply("201", "100", huge)], "next"));
		const result = await readFxTwitter(target, fixture.read);
		expect(result.conversation).toMatchObject({ replyCount: 1, stopReason: "content-limit" });
		expect(result.content.length).toBeLessThanOrEqual(3_000_000);
		const ancestor = reader({ ...page([], "next", [post("90", undefined, "x".repeat(3_000_000))]), status: post("100", "90", "Selected evidence") });
		const selected = await readFxTwitter(target, ancestor.read);
		expect(selected.content).toContain("Selected evidence");
		expect(selected.conversation).toMatchObject({ threadPostCount: 1, stopReason: "content-limit" });
		await expect(readFxTwitter(target, reader({ ...page(), status: post("100", undefined, "x".repeat(3_000_000)) }).read)).rejects.toMatchObject({ kind: "responseTooLarge" });
	});

	it("keeps searching for readable replies when an earlier candidate cannot be rendered", async () => {
		const fixture = reader(page([{ ...reply("200"), article: { preview_text: "not the body" } }], "next"), page([reply("201")]));
		const result = await readFxTwitter(target, fixture.read, { maxReplies: 1 });
		expect(result.conversation).toMatchObject({ pagesRead: 2, replyCount: 1, stopReason: "exhausted" });
		expect(result.content).toContain("Comment 201");
		expect(result.warnings.join(" ")).toContain("unrenderable post");
	});
});
