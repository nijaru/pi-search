import { describe, expect, it } from "bun:test";
import { createExaProvider, type ExaAdapterOptions } from "./exa";

const payload = {
	requestId: "exa-1",
	results: [{ id: "result-1", url: "https://example.com/page", title: "Example", publishedDate: "2026-01-02T00:00:00Z", highlights: ["A useful excerpt."] }],
	costDollars: { total: 0.007 },
};

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function provider(options: Partial<ExaAdapterOptions> = {}) {
	return createExaProvider({ apiKey: "exa-test", endpoint: "https://exa.test/search", ...options });
}

describe("ExaProvider", () => {
	it("requests semantic evidence with domain filters and reports provider cost", async () => {
		let seenBody: Record<string, unknown> | undefined;
		const configured = provider({ fetchImpl: async (_input, init) => {
			seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return response(payload, 200, { "content-type": "application/json", "x-request-id": "exa-header", "x-ratelimit-limit": "10", "x-ratelimit-remaining": "7", "x-ratelimit-reset": "60" });
		} });
		const result = await configured.search({ query: "latest TypeScript release", maxResults: 1, domains: { include: ["example.com"] } }, new AbortController().signal, {});
		expect(configured.profile.estimatedCostUsd).toBe(0.007);
		expect(seenBody).toMatchObject({ query: "latest TypeScript release", numResults: 1, includeDomains: ["example.com"], contents: { highlights: true } });
		expect(result).toMatchObject({ provider: "exa", requestId: "exa-header", usage: { costUsd: 0.007, rateLimits: { windows: [{ limit: 10, remaining: 7, resetAfterMs: 60_000 }] } }, appliedOptions: ["maxResults", "mode", "domains"] });
		expect(result.results[0]).toMatchObject({ url: "https://example.com/page", excerpt: "A useful excerpt.", sourceId: "result-1" });
	});

	it("keeps valid results when another result is malformed", async () => {
		const result = await provider({ fetchImpl: async () => response({ results: [null, { url: "not-a-url" }, { url: "https://example.com/valid", text: "Fallback page text." }] }) }).search(
			{ query: "q" },
			new AbortController().signal,
			{},
		);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({ url: "https://example.com/valid", excerpt: "Fallback page text." });
		expect(result.warnings).toEqual([{ code: "partial-results", message: "Exa discarded 2 malformed result entries" }]);
	});

	it("falls back from empty highlights to text and summary", async () => {
		const result = await provider({ fetchImpl: async () => response({ results: [
			{ url: "https://example.com/text", highlights: ["", "  "], text: "Text excerpt." },
			{ url: "https://example.com/summary", highlights: [], summary: "Summary excerpt." },
		] }) }).search({ query: "q", maxResults: 2 }, new AbortController().signal, {});
		expect(result.results.map((item) => item.excerpt)).toEqual(["Text excerpt.", "Summary excerpt."]);
	});

	it("ignores malformed optional billing metadata", async () => {
		const result = await provider({ fetchImpl: async () => response({ costDollars: "unknown", results: [{ url: "https://example.com/valid" }] }) }).search(
			{ query: "q" },
			new AbortController().signal,
			{},
		);
		expect(result.usage).toBeUndefined();
	});

	it("requires an API key before network access", async () => {
		let calls = 0;
		const missing = createExaProvider({ endpoint: "https://exa.test/search", fetchImpl: async () => { calls += 1; return response(payload); } });
		await expect(missing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "exa", kind: "auth" });
		expect(calls).toBe(0);
	});

	it("preserves the body request ID when the HTTP header is absent", async () => {
		const result = await provider({ fetchImpl: async () => response(payload) }).search({ query: "q" }, new AbortController().signal, {});
		expect(result.requestId).toBe("exa-1");
	});

	it("does not report success when every result URL is malformed", async () => {
		const malformed = provider({ fetchImpl: async () => response({ results: [{ url: "not-a-url" }] }) });
		await expect(malformed.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "exa", kind: "malformed" });
	});

	it("surfaces HTTP retry metadata without retrying", async () => {
		const failing = provider({ fetchImpl: async () => response({ error: "busy" }, 429, { "retry-after": "3", "x-request-id": "exa-429" }) });
		await expect(failing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "exa", kind: "rateLimit", requestId: "exa-429", retryAfterMs: 3_000 });
	});
});
