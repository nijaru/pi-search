import { describe, expect, it } from "bun:test";
import {
	SearchMode,
	hasCapability,
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
		provider: "exa",
		searchQuery: "query",
		...over,
	};
}

function makeProvider(over: Partial<Provider> = {}): Provider {
	return {
		id: "exa",
		capabilities: { semantic: true, excerpts: true },
		profile: { auth: "environment", costModel: "per-request", estimatedCostUsd: 0.01 },
		async search(_req: SearchRequest, _signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
			return {
				query: "query",
				results: [makeResult()],
				provider: "exa",
				appliedOptions: [],
				warnings: [],
			};
		},
		...over,
	};
}

describe("contracts", () => {
	it("SearchMode exposes the expected routing axes", () => {
		expect(SearchMode.semantic).toBe("semantic");
		expect(SearchMode.keyword).toBe("keyword");
		expect(SearchMode.fresh).toBe("fresh");
		expect(SearchMode.multiHop).toBe("multiHop");
		expect(SearchMode.social).toBe("social");
		expect(SearchMode.auto).toBe("auto");
	});

	it("SearchRequest requires a query and leaves everything else optional", () => {
		const req: SearchRequest = { query: "react vs vue" };
		expect(req.query).toBe("react vs vue");
		expect(req.mode).toBeUndefined();
		expect(req.maxResults).toBeUndefined();
	});

	it("SearchResult preserves the evidence-first fields", () => {
		const r = makeResult({ title: "t", excerpt: "e", publishedAt: "2026-01-01" });
		expect(r.url).toBe("https://example.com/a");
		expect(r.provider).toBe("exa");
		expect(r.searchQuery).toBe("query");
		expect(r.excerpt).toBe("e");
	});

	it("SearchResponse defaults to no synthesized answer", async () => {
		const res = await makeProvider().search({ query: "q" }, new AbortController().signal, {});
		expect(res).toMatchObject({ appliedOptions: [], warnings: [] });
		expect(res.answer).toBeUndefined();
	});

	it("hasCapability reflects declared capabilities", () => {
		const p = makeProvider();
		expect(hasCapability(p, "semantic")).toBe(true);
		expect(hasCapability(p, "freshness")).toBe(false);
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
		validateResearchBudget({ maxSteps: 3, maxProviderCalls: 4, timeoutMs: 10_000, maxCostUsd: 1 });
		expect(() => validateResearchBudget({ maxSteps: 0, maxProviderCalls: 1, timeoutMs: 10_000 })).toThrow(
			"maxSteps",
		);
		expect(() => validateResearchBudget({ maxSteps: 1, maxProviderCalls: 1, timeoutMs: 0 })).toThrow(
			"timeoutMs",
		);
	});
});
