import { describe, expect, it } from "bun:test";
import { buildDeepSeekRequest, createDeepSeekProvider, DEEPSEEK_MAX_QUERY_LENGTH, type DeepSeekAdapterOptions } from "./deepseek";

const payload = {
	results: [{ url: "https://example.com/page", title: "Example", snippet: "Short snippet.", summary: "A model-oriented summary.", date: "2026-01-02T00:00:00+00:00", rerank_score: 2.4 }],
};

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function provider(options: Partial<DeepSeekAdapterOptions> = {}) {
	return createDeepSeekProvider({ apiKey: "deepseek-test", endpoint: "https://deepseek.test/v1/tools/search", ...options });
}

describe("DeepSeekProvider", () => {
	it("maps domains and inclusive dates onto documented query operators", async () => {
		let seenBody: Record<string, unknown> | undefined;
		let seenAuth: string | undefined;
		const configured = provider({ fetchImpl: async (_input, init) => {
			seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			seenAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
			return response(payload);
		} });
		const result = await configured.search({
			query: "latest TypeScript release",
			maxResults: 3,
			domains: { include: ["a.example.com", "b.example.com"], exclude: ["c.example.com"] },
			dateRange: { from: "2026-01-01", to: "2026-01-02" },
		}, new AbortController().signal, {});
		expect(seenAuth).toBe("Bearer deepseek-test");
		expect(seenBody).toEqual({
			query: "latest TypeScript release site:a.example.com OR site:b.example.com -site:c.example.com after:2025-12-31 before:2026-01-03",
			count: 3,
			need_content: false,
		});
		expect(result).toMatchObject({ provider: "deepseek", appliedOptions: ["maxResults", "mode", "domains", "dateRange"] });
		expect(result.warnings).toEqual([]);
		expect(result.results[0]).toMatchObject({
			url: "https://example.com/page",
			domain: "example.com",
			title: "Example",
			excerpt: "A model-oriented summary.",
			publishedAt: "2026-01-02T00:00:00+00:00",
			provider: "deepseek",
			searchQuery: "latest TypeScript release",
		});
		expect(result.results[0]?.score).toBeCloseTo(0.8, 6);
	});

	it("warns when date operators cannot express time-of-day bounds", async () => {
		const result = await provider({ fetchImpl: async () => response(payload) }).search(
			{ query: "q", dateRange: { from: "2026-01-01T12:00:00Z" } },
			new AbortController().signal,
			{},
		);
		expect(result.appliedOptions).toContain("dateRange");
		expect(result.warnings).toEqual([
			{ code: "unsupported-option", option: "dateRange", message: "DeepSeek date operators have day granularity; time-of-day bounds are enforced locally on results that report a date" },
		]);
	});

	it("enforces the inclusive date range on results with known dates", async () => {
		const result = await provider({ fetchImpl: async () => response({ results: [
			{ url: "https://example.com/before", date: "2025-12-31T23:59:59Z" },
			{ url: "https://example.com/inside", date: "2026-01-02T23:59:59Z" },
			{ url: "https://example.com/after", date: "2026-01-03T00:00:00Z" },
			{ url: "https://example.com/undated" },
		] }) }).search({ query: "q", dateRange: { from: "2026-01-01", to: "2026-01-02" } }, new AbortController().signal, {});
		expect(result.results.map((item) => item.url)).toEqual(["https://example.com/inside", "https://example.com/undated"]);
		expect(result.warnings).toEqual([
			{ code: "partial-results", message: "DeepSeek removed 2 result entries outside the requested date range" },
			{ code: "partial-results", message: "DeepSeek could not verify the publication date of 1 result entry against the requested date range" },
		]);
	});

	it("uses exact instants when the date range includes a time", async () => {
		const result = await provider({ fetchImpl: async () => response({ results: [
			{ url: "https://example.com/early", date: "2026-01-02T11:30:00Z" },
			{ url: "https://example.com/late", date: "2026-01-02T12:30:00Z" },
		] }) }).search({ query: "q", dateRange: { to: "2026-01-02T12:00:00Z" } }, new AbortController().signal, {});
		expect(result.results.map((item) => item.url)).toEqual(["https://example.com/early"]);
		expect(result.warnings).toContainEqual({ code: "partial-results", message: "DeepSeek removed 1 result entry outside the requested date range" });
	});

	it("maps an end-only date range without inventing a start bound", () => {
		const plan = buildDeepSeekRequest({ query: "q", dateRange: { to: "2026-01-02" } });
		expect(plan.body.query).toBe("q before:2026-01-03");
		expect(plan.appliedOptions).toContain("dateRange");
	});

	it("derives operator days from UTC instants", () => {
		// Both instants are 2026-01-02T04:00Z, so the provider window must cover Jan 2 even though the written date is Jan 1.
		const plan = buildDeepSeekRequest({ query: "q", dateRange: { from: "2026-01-01T23:00:00-05:00", to: "2026-01-01T23:00:00-05:00" } });
		expect(plan.body.query).toBe("q after:2026-01-01 before:2026-01-03");
	});

	it("names the image-result control before the generic content-type rejection", async () => {
		await expect(provider().search({ query: "q", searchContentTypes: ["image"], imageSettings: { caption: true } }, new AbortController().signal, {})).rejects.toThrow(/image result settings/);
	});

	it("warns when ranking modes are not guaranteed", async () => {
		const keyword = await provider({ fetchImpl: async () => response(payload) }).search({ query: "q", mode: "keyword" }, new AbortController().signal, {});
		expect(keyword.warnings[0]).toMatchObject({ code: "unsupported-option", option: "mode" });
		const fresh = await provider({ fetchImpl: async () => response(payload) }).search({ query: "q", mode: "fresh" }, new AbortController().signal, {});
		expect(fresh.warnings[0]?.message).toContain("recent-date floor");
		const bounded = await provider({ fetchImpl: async () => response(payload) }).search(
			{ query: "q", mode: "fresh", dateRange: { from: "2026-01-01" } },
			new AbortController().signal,
			{},
		);
		expect(bounded.warnings).toEqual([]);
	});

	it("rejects unsupported request controls before network access", async () => {
		let calls = 0;
		const configured = provider({ fetchImpl: async () => { calls += 1; return response(payload); } });
		const signal = new AbortController().signal;
		for (const request of [
			{ query: "q", social: { includeHandles: ["xai"] } },
			{ query: "q", executionModel: "deepseek-v4-pro" },
			{ query: "q", searchContextSize: "low" as const },
			{ query: "q", returnTokenBudget: "default" as const },
			{ query: "q", externalWebAccess: true },
			{ query: "q", userLocation: { type: "approximate" as const, country: "US" } },
			{ query: "q", searchContentTypes: ["text" as const] },
			{ query: "q", searchContentTypes: ["image" as const], imageSettings: { caption: true } },
		]) {
			await expect(configured.search(request, signal, {})).rejects.toMatchObject({ provider: "deepseek", kind: "unsupported" });
		}
		expect(calls).toBe(0);
	});

	it("rejects a composed query over the provider limit without dispatching", async () => {
		let calls = 0;
		const configured = provider({ fetchImpl: async () => { calls += 1; return response(payload); } });
		const query = "x".repeat(DEEPSEEK_MAX_QUERY_LENGTH);
		await expect(configured.search({ query, domains: { include: ["example.com"] } }, new AbortController().signal, {})).rejects.toMatchObject({
			provider: "deepseek",
			kind: "unsupported",
			fallbackSafe: true,
		});
		expect(calls).toBe(0);
	});

	it("counts the query limit in Unicode code points", async () => {
		const configured = provider({ fetchImpl: async () => response(payload) });
		const query = "🧭".repeat(DEEPSEEK_MAX_QUERY_LENGTH);
		expect([...query].length).toBe(DEEPSEEK_MAX_QUERY_LENGTH);
		await expect(configured.search({ query }, new AbortController().signal, {})).resolves.toMatchObject({ provider: "deepseek" });
	});

	it("keeps valid results when another result is malformed", async () => {
		const result = await provider({ fetchImpl: async () => response({ results: [
			null,
			{ url: "not-a-url" },
			{ url: "https://example.com/valid", snippet: "Snippet excerpt." },
		] }) }).search({ query: "q" }, new AbortController().signal, {});
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({ url: "https://example.com/valid", excerpt: "Snippet excerpt." });
		expect(result.warnings).toEqual([{ code: "partial-results", message: "DeepSeek discarded 2 malformed result entries" }]);
	});

	it("prefers the model-oriented summary and ignores invalid optional fields", async () => {
		const result = await provider({ fetchImpl: async () => response({ results: [
			{ url: "https://example.com/summary", summary: "Summary text.", snippet: "Snippet text.", rerank_score: "high", date: "not-a-date" },
			{ url: "https://example.com/snippet", snippet: "Only snippet.", rerank_score: 9 },
		] }) }).search({ query: "q", maxResults: 2 }, new AbortController().signal, {});
		expect(result.results.map((item) => item.excerpt)).toEqual(["Summary text.", "Only snippet."]);
		expect(result.results[0]).toMatchObject({ score: undefined, publishedAt: undefined });
		expect(result.results[1]?.score).toBe(1);
	});

	it("requires an API key before network access", async () => {
		let calls = 0;
		const missing = createDeepSeekProvider({ endpoint: "https://deepseek.test/v1/tools/search", fetchImpl: async () => { calls += 1; return response(payload); } });
		await expect(missing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "deepseek", kind: "auth" });
		expect(calls).toBe(0);
	});

	it("does not report success when every result URL is malformed", async () => {
		const malformed = provider({ fetchImpl: async () => response({ results: [{ url: "not-a-url" }] }) });
		await expect(malformed.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "deepseek", kind: "malformed" });
	});

	it("surfaces HTTP retry metadata without retrying", async () => {
		let calls = 0;
		const failing = provider({ fetchImpl: async () => { calls += 1; return response({ error: "busy" }, 429, { "retry-after": "3", "x-request-id": "deepseek-429" }); } });
		await expect(failing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "deepseek", kind: "rateLimit", requestId: "deepseek-429", retryAfterMs: 3_000 });
		expect(calls).toBe(1);
	});

	it("publishes the per-request estimate without inventing reported cost", async () => {
		const configured = provider({ fetchImpl: async () => response(payload) });
		expect(configured.profile).toMatchObject({ costModel: "per-request", estimatedCostUsd: 0.00075 });
		const result = await configured.search({ query: "q" }, new AbortController().signal, {});
		expect(result.usage).toBeUndefined();
	});
});
