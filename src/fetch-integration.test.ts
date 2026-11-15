import { expect, test } from "bun:test";
import type { Provider } from "./contracts";
import type { DirectTransport } from "./direct-transport";
import { createFetchSnapshots } from "./fetch-snapshots";
import { createWebFetchTool } from "./fetch-tool";
import { createWebSearchTool } from "./search-tool";
import { executeResearch } from "./research-tool";

const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const sourceText = (url: string) => `Source ${url}: ${"evidence ".repeat(150)}`;
const transport: DirectTransport = async target => ({ status: 200, statusText: "OK", headers: new Headers({ "content-type": "text/plain" }), body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(sourceText(target.url.href)); } } });
function provider(count: number): Provider {
	return { id: "exa", profile: { auth: "none", costModel: "unknown" }, capabilities: {}, search: async request => ({ query: request.query, provider: "exa", results: Array.from({ length: count }, (_, i) => ({ url: `https://example.test/${i}`, provider: "exa", searchQuery: request.query })), warnings: [], appliedOptions: [] }) };
}

test("search enrichment shares immutable paging with fetch and never advertises already evicted IDs", async () => {
	const snapshots = createFetchSnapshots();
	const fetcherOptions = { snapshots, lookup, transport };
	const search = createWebSearchTool(provider(9), { fetcherOptions });
	const result = await search.execute("search", { query: "q", fetch: { maxResults: 9, maxLength: 100 } }, undefined, undefined, {} as never);
	const pages = result.details!.sourceContents!;
	expect(pages).toHaveLength(9);
	expect(pages.filter(page => page.snapshotId !== undefined)).toHaveLength(8);
	expect(pages[0]!.snapshotId).toBeUndefined();
	const fetch = createWebFetchTool({ snapshots, lookup: async () => { throw new Error("Snapshot paging must not resolve DNS"); } });
	for (const page of pages.slice(1)) {
		const next = await fetch.execute("page", { url: page.sourceUrl ?? page.url, snapshotId: page.snapshotId!, offset: 100, maxLength: 100 }, undefined, undefined, {} as never);
		expect(next.details!.content).toBe(sourceText(page.url).slice(100, 200));
	}
	snapshots.close();
	await expect(fetch.execute("closed", { url: pages[1]!.url, snapshotId: pages[1]!.snapshotId! }, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "WEB_FETCH_SNAPSHOT_UNAVAILABLE" });
});

test("optional batches finalize snapshot ownership and expose only readable retained IDs", async () => {
	const snapshots = createFetchSnapshots();
	const response = await executeResearch({ question: "q", fetchResults: 10, budget: { maxSteps: 11, maxProviderCalls: 1, maxFetches: 10, timeoutMs: 1000, maxOutputChars: 45000 } }, () => provider(10), {} as never, { snapshots, lookup, transport });
	expect(response.fetched).toHaveLength(10);
	expect(response.fetched.filter(page => page.snapshotId !== undefined)).toHaveLength(8);
	const fetch = createWebFetchTool({ snapshots });
	for (const page of response.fetched.filter(page => page.snapshotId !== undefined)) {
		const next = await fetch.execute("page", { url: page.url, snapshotId: page.snapshotId!, offset: 10 }, undefined, undefined, {} as never);
		expect(next.details!.content).toBe(sourceText(page.url).slice(10));
	}
});

test("output-bound enrichment discards hidden snapshots rather than crowding the shared store", async () => {
	const store = createFetchSnapshots();
	const ids: string[] = [];
	const snapshots = { ...store, retain: (...args: Parameters<typeof store.retain>) => { const id = store.retain(...args); if (id) ids.push(id); return id; } };
	const search = createWebSearchTool(provider(2), { fetcherOptions: { snapshots, lookup, transport: async () => ({ status: 200, statusText: "OK", headers: new Headers({ "content-type": "text/plain" }), body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode("x".repeat(32000)); } } }) } });
	const result = await search.execute("search", { query: "q", fetch: { maxResults: 2, maxLength: 32000 } }, undefined, undefined, {} as never);
	const shown = new Set(result.details!.sourceContents?.map(page => page.snapshotId));
	expect(ids).toHaveLength(2);
	expect(result.details!.sourceContents).toHaveLength(1);
	for (const id of ids) expect(store.has(id)).toBe(shown.has(id));
});
