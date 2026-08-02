import { describe, expect, it } from "bun:test";
import { createParallelProvider, type ParallelAdapterOptions } from "./parallel";

const payload = {
	search_id: "search-1",
	results: [{ url: "https://example.com/page", title: "Example", publish_date: "2026-01-02", excerpts: ["First excerpt.", "Second excerpt."] }],
};

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function provider(options: Partial<ParallelAdapterOptions> = {}) {
	return createParallelProvider({ apiKey: "parallel-test", endpoint: "https://parallel.test/v1/search", ...options });
}

describe("ParallelProvider", () => {
	it("sends an objective and normalizes bounded excerpts", async () => {
		let seenBody: Record<string, unknown> | undefined;
		const result = await provider({ fetchImpl: async (_input, init) => {
			seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return response(payload);
		} }).search({ query: "latest TypeScript release", maxResults: 1 }, new AbortController().signal, {});
		expect(seenBody).toMatchObject({ objective: "latest TypeScript release", search_queries: ["latest TypeScript release"], mode: "advanced" });
		expect(result).toMatchObject({ provider: "parallel", requestId: "search-1", appliedOptions: ["maxResults", "mode"] });
		expect(result.results[0]).toMatchObject({ url: "https://example.com/page", excerpt: "First excerpt.\nSecond excerpt." });
	});

	it("rejects hard domain constraints before network access", async () => {
		let calls = 0;
		const configured = provider({ fetchImpl: async () => { calls += 1; return response(payload); } });
		await expect(configured.search({ query: "q", domains: { include: ["example.com"] } }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "parallel", kind: "unsupported" });
		await expect(configured.search({ query: "q", dateRange: { from: "2026-01-01" } }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "parallel", kind: "unsupported" });
		expect(calls).toBe(0);
	});

	it("does not report success when every result URL is malformed", async () => {
		const malformed = provider({ fetchImpl: async () => response({ search_id: "bad", results: [{ url: "not-a-url" }] }) });
		await expect(malformed.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "parallel", kind: "malformed" });
	});

	it("requires an explicit API key", async () => {
		const missing = createParallelProvider({ endpoint: "https://parallel.test/v1/search", fetchImpl: async () => response(payload) });
		await expect(missing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "parallel", kind: "auth" });
	});
});
