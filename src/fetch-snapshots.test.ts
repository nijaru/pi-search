import { describe, expect, it } from "bun:test";
import type { FetchedContent } from "./contracts";
import { createFetchSnapshots, finalizeFetchSnapshots } from "./fetch-snapshots";

const request = { url: "https://example.test/", format: "text" as const, readable: true, allowRawHtmlFallback: true, captionLanguage: "en" };
function result(content = "evidence"): FetchedContent {
	return {
		url: request.url, content, contentTrust: "untrusted", outputFormat: "text", extraction: "plain-text",
		fetchedAt: "2026-01-01T00:00:00.000Z", status: 200, redirectCount: 0, bytesRead: content.length,
		truncated: false, offset: 0, totalCharacters: content.length,
		warnings: [{ code: "partial", message: "original warning" }],
		xConversation: { pagesRead: 1, replyCount: 0, threadPostCount: 1, paginationExhausted: true, stopReason: "exhausted" },
	};
}

describe("fetch snapshot ownership and bounds", () => {
	it("expires at the original TTL even when read repeatedly", () => {
		let time = 0;
		const snapshots = createFetchSnapshots({ ttlMs: 100, now: () => time });
		const id = snapshots.retain(request, result())!;
		time = 99;
		expect(snapshots.read(id, request).content).toBe("evidence");
		time = 100;
		expect(() => snapshots.read(id, request)).toThrow("expired");
	});

	it("evicts by count in insertion order, not read order", () => {
		const snapshots = createFetchSnapshots({ maxCount: 2 });
		const first = snapshots.retain(request, result("first"))!;
		const second = snapshots.retain(request, result("second"))!;
		snapshots.read(first, request);
		const third = snapshots.retain(request, result("third"))!;
		expect(() => snapshots.read(first, request)).toThrow("evicted");
		expect(snapshots.read(second, request).content).toBe("second");
		expect(snapshots.read(third, request).content).toBe("third");
	});

	it("bounds aggregate bytes and does not evict useful entries for an oversized result", () => {
		const snapshots = createFetchSnapshots({ maxBytes: 5_000 });
		const first = snapshots.retain(request, result("a".repeat(1_000)))!;
		expect(first).toBeString();
		const second = snapshots.retain(request, result("b".repeat(1_000)))!;
		expect(() => snapshots.read(first, request)).toThrow("evicted");
		expect(snapshots.retain(request, result("x".repeat(5_000)))).toBeUndefined();
		expect(snapshots.read(second, request).content).toBe("b".repeat(1_000));
	});

	it("isolates instances and clones both sides of the retention boundary", () => {
		const snapshots = createFetchSnapshots();
		const original = result();
		const id = snapshots.retain(request, original)!;
		Object.assign(original, { content: "poison" });
		Object.assign(original.warnings[0]!, { message: "poison" });
		const read = snapshots.read(id, request);
		Object.assign(read.xConversation!, { replyCount: 999 });
		Object.assign(read, { content: "poison again" });
		expect(snapshots.read(id, request)).toMatchObject({ content: "evidence", warnings: [{ message: "original warning" }], xConversation: { replyCount: 0 } });
		expect(() => createFetchSnapshots().read(id, request)).toThrow("unknown");
	});

	it("clears entries and closes permanently and idempotently", () => {
		const snapshots = createFetchSnapshots();
		const first = snapshots.retain(request, result())!;
		snapshots.clear();
		expect(() => snapshots.read(first, request)).toThrow("unknown");
		const second = snapshots.retain(request, result())!;
		snapshots.close();
		snapshots.close();
		expect(() => snapshots.read(second, request)).toThrow("closed");
		expect(snapshots.retain(request, result())).toBeUndefined();
	});

	it("matches canonical original URLs, inherits controls, and checks explicit controls", () => {
		const snapshots = createFetchSnapshots();
		const original = { ...request, url: "https://Example.test:443/é#section", readable: false, format: "html" as const };
		const id = snapshots.retain(original, result())!;
		expect(snapshots.read(id, { url: "https://example.test/%C3%A9" }).content).toBe("evidence");
		expect(snapshots.read(id, { ...original, url: "https://example.test/é#different" }).content).toBe("evidence");
		expect(() => snapshots.read(id, { url: original.url, readable: true })).toThrow("Explicit extraction controls");
		expect(() => snapshots.read(id, { url: "https://example.test/other" })).toThrow("original requested URL");
	});

	it("normalizes the effective default reply limit for explicit public X reads", () => {
		const snapshots = createFetchSnapshots();
		const original = { ...request, url: "https://x.com/alice/status/123", xMode: "public" as const };
		const id = snapshots.retain(original, result())!;
		expect(snapshots.read(id, { ...original, xReplies: 200 }).content).toBe("evidence");
		expect(() => snapshots.read(id, { ...original, xReplies: 0 })).toThrow("controls");
	});

	it("omits evicted IDs and releases retained pages that cannot be shown", () => {
		const snapshots = createFetchSnapshots({ maxCount: 2 });
		const pages = [1, 2, 3].map(i => ({ ...result(String(i)), snapshotId: snapshots.retain(request, result(String(i)))! }));
		const visible = finalizeFetchSnapshots(pages, pages.slice(0, 2), snapshots);
		expect(visible.map(page => page.snapshotId)).toEqual([undefined, pages[1]!.snapshotId]);
		expect(snapshots.has(pages[2]!.snapshotId)).toBe(false);
		expect(snapshots.has(pages[1]!.snapshotId)).toBe(true);
		snapshots.discard(pages[1]!.snapshotId);
		expect(snapshots.has(pages[1]!.snapshotId)).toBe(false);
	});

	it("rejects invalid store bounds", () => {
		for (const options of [{ maxCount: 0 }, { maxBytes: -1 }, { ttlMs: Infinity }, { maxCount: 1.5 }]) {
			expect(() => createFetchSnapshots(options)).toThrow("positive safe integer");
		}
	});
});
