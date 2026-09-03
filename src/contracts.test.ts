import { describe, expect, it } from "bun:test";
import {
	validateResearchBudget,
	type Provider,
	type ProviderContext,
	type SearchRequest,
	type SearchResult,
	type SearchResponse,
} from "./contracts";

function makeResult(over: Partial<SearchResult> = {}): SearchResult {
	return {
		url: "https://example.com/a",
		provider: "brave",
		searchQuery: "query",
		...over,
	};
}

function makeProvider(over: Partial<Provider> = {}): Provider {
	return {
		id: "brave",
		capabilities: { keyword: true, excerpts: true },
		profile: { auth: "environment", costModel: "per-request", estimatedCostUsd: 0.01 },
		async search(_req: SearchRequest, _signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
			return {
				query: "query",
				results: [makeResult()],
				provider: "brave",
				appliedOptions: [],
				warnings: [],
			};
		},
		...over,
	};
}

	describe("contracts", () => {
	it("SearchRequest requires a query and leaves everything else optional", () => {
		const req: SearchRequest = { query: "react vs vue" };
		expect(req.query).toBe("react vs vue");
		expect(req.mode).toBeUndefined();
		expect(req.maxResults).toBeUndefined();
	});

	it("SearchResult preserves the evidence-first fields", () => {
		const r = makeResult({ title: "t", excerpt: "e", publishedAt: "2026-01-01" });
		expect(r.url).toBe("https://example.com/a");
		expect(r.provider).toBe("brave");
		expect(r.searchQuery).toBe("query");
		expect(r.excerpt).toBe("e");
	});

	it("SearchResponse contains evidence metadata", async () => {
		const res = await makeProvider().search({ query: "q" }, new AbortController().signal, {});
		expect(res).toMatchObject({ appliedOptions: [], warnings: [], provider: "brave" });
	});

	it("ProviderId allows forward-compatible string ids", () => {
		const p = makeProvider({ id: "future-provider" });
		expect(p.id).toBe("future-provider");
	});

	it("Provider.fetch is optional", () => {
		const p = makeProvider();
		expect(p.fetch).toBeUndefined();
	});

	it("research budgets reject unbounded or invalid values", () => {
		validateResearchBudget({ maxSteps: 3, maxProviderCalls: 4, maxFetches: 1, timeoutMs: 10_000, maxOutputChars: 10_000, maxCostUsd: 1 });
		expect(() => validateResearchBudget({ maxSteps: 0, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 10_000, maxOutputChars: 10_000 })).toThrow(
			"maxSteps",
		);
		expect(() => validateResearchBudget({ maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 10_000, maxOutputChars: 10_000 })).not.toThrow();
		expect(() => validateResearchBudget({ maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 0, maxOutputChars: 10_000 })).toThrow(
			"timeoutMs",
		);
	});
});
