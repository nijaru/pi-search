import { describe, expect, it } from "bun:test";
import type { SearchResponse } from "../src/contracts";
import { evaluateProviderResponse, summarizeProviderEvaluations } from "./provider-eval";

function response(provider: SearchResponse["provider"], results: SearchResponse["results"], usage?: SearchResponse["usage"]): SearchResponse {
	return {
		query: "q",
		results,
		provider,
		appliedOptions: [],
		warnings: [],
		...(usage === undefined ? {} : { usage }),
	};
}

describe("provider evaluation metrics", () => {
	it("measures evidence and hard-constraint compliance without scoring relevance", () => {
		const metrics = evaluateProviderResponse({
			case: { id: "official", role: "keyword", minResults: 2, includeDomains: ["example.com"], requireExcerpt: true },
			response: response("brave", [
				{ url: "https://docs.example.com/a", title: "A", excerpt: "A", provider: "brave", searchQuery: "q" },
				{ url: "https://example.com/b", title: "B", excerpt: "B", provider: "brave", searchQuery: "q" },
			]),
		});
		expect(metrics).toMatchObject({
			resultCount: 2,
			uniqueResultCount: 2,
			inspectableUrlRate: 1,
			excerptCoverage: 1,
			provenanceCoverage: 1,
			hardConstraintCompliance: 1,
			passes: true,
		});
	});

	it("fails social and date requirements when evidence does not provide them", () => {
		const metrics = evaluateProviderResponse({
			case: { id: "social", role: "social", requireSocial: true, requirePublishedAt: true },
			response: response("brave", [{ url: "https://example.com/a", provider: "brave", searchQuery: "q" }]),
		});
		expect(metrics).toMatchObject({ socialResultRate: 0, publishedDateCoverage: 0, passes: false });
	});

	it("aggregates providers separately and sums reported usage", () => {
		const observations = [
			{
				case: { id: "a", role: "keyword" },
				response: response("brave", [{ url: "https://example.com/a", provider: "brave", searchQuery: "q" }], { costUsd: 0.01, totalTokens: 2 }),
			},
			{
				case: { id: "b", role: "keyword" },
				response: response("exa", [{ url: "https://example.com/b", provider: "exa", searchQuery: "q" }], { costUsd: 0.02, totalTokens: 3 }),
			},
		];
		const summary = summarizeProviderEvaluations(observations);
		expect(summary).toHaveLength(2);
		expect(summary.find((item) => item.provider === "brave")).toMatchObject({ cases: 1, usage: { costUsd: 0.01, totalTokens: 2 } });
		expect(summary.find((item) => item.provider === "exa")).toMatchObject({ cases: 1, usage: { costUsd: 0.02, totalTokens: 3 } });
	});
});
