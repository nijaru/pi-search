import { describe, expect, it } from "bun:test";
import type { Provider, SearchResponse } from "./contracts";
import { SearchToolError } from "./errors";
import { createWebResearchTool, executeResearch, renderResearchResponse } from "./research-tool";

function context(): never {
	return { model: { provider: "openai", id: "gpt-test", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }) } } as never;
}

function provider(fail = false, estimatedCostUsd?: number, resultUrls = ["https://example.com/1"], responseWarnings: SearchResponse["warnings"] = []): Provider {
	let calls = 0;
	return {
		id: "openai",
		capabilities: { keyword: true, freshness: true },
		profile: { auth: "modelRegistry", costModel: "unknown", ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) },
		search: async (request): Promise<SearchResponse> => {
			calls += 1;
			if (fail) throw new SearchToolError("WEB_SEARCH_RATE_LIMIT", "native rate limit");
			return {
				query: request.query,
				results: [{ url: resultUrls[(calls - 1) % resultUrls.length]!, provider: "openai", searchQuery: request.query }],
				provider: "openai",
				appliedOptions: ["maxResults"],
				warnings: responseWarnings,
			};
		},
	};
}

const budget = { maxSteps: 3, maxProviderCalls: 2, maxFetches: 0, timeoutMs: 5_000, maxOutputChars: 20_000 };

describe("web_research", () => {
	it("runs only caller-supplied queries under one provider and explicit bounds", async () => {
		const result = await executeResearch({ question: "main", queries: ["one", "two"], budget }, () => provider(), context());
		expect(result).toMatchObject({ question: "main", providerCalls: 2, stepsCompleted: 2, fetchesCompleted: 0, fetchAttempts: 0, stopReason: "completed" });
		expect(result.results.map((item) => item.searchQuery)).toEqual(["one", "two"]);
	});

	it("propagates an explicit execution model through every research query", async () => {
		const seenModels: string[] = [];
		const selected: Provider = {
			...provider(),
			id: "gemini",
			search: async (request) => {
				seenModels.push(request.executionModel ?? "missing");
				return {
					query: request.query,
					results: [{ url: "https://example.com/1", provider: "gemini", searchQuery: request.query }],
					provider: "gemini",
					executionModel: request.executionModel,
					usage: { billedUnits: 2, billedUnit: "requests", costUsd: 0.1 },
					appliedOptions: [],
					warnings: [],
				};
			},
		};
		const result = await executeResearch({ question: "main", queries: ["one", "two"], provider: "gemini", executionModel: "gemini-3.5-flash", budget }, () => selected, context());
		expect(seenModels).toEqual(["gemini-3.5-flash", "gemini-3.5-flash"]);
		expect(result.executionModel).toBe("gemini-3.5-flash");
		expect(result.usage).toMatchObject({ costUsd: 0.2, billedUnits: 4, billedUnit: "requests" });
	});

	it("returns a bounded partial result on provider failure", async () => {
		const result = await executeResearch({ question: "main", budget }, () => provider(true), context());
		expect(result.stopReason).toBe("provider-error");
		expect(result.providerCalls).toBe(1);
		expect(result.warnings[0]?.message).toContain("rate limit");
	});

	it("preserves warnings returned by each provider call", async () => {
		const result = await executeResearch({ question: "main", budget }, () => provider(false, undefined, ["https://example.com/1"], [{ code: "unsupported-option", option: "mode", message: "freshness is approximate" }]), context());
		expect(result.warnings).toContainEqual({ code: "unsupported-option", option: "mode", message: "freshness is approximate" });
	});

	it("rejects invalid budgets before provider selection effects", async () => {
		let selected = false;
		await expect(executeResearch({ question: "main", budget: { ...budget, maxSteps: 0 } }, () => { selected = true; return provider(); }, context())).rejects.toMatchObject({ code: "WEB_RESEARCH_BUDGET" });
		expect(selected).toBe(false);
	});

	it("reserves estimated cost before each provider call", async () => {
		const result = await executeResearch({ question: "main", queries: ["one", "two"], budget: { ...budget, maxCostUsd: 1 } }, () => provider(false, 0.6), context());
		expect(result).toMatchObject({ providerCalls: 1, stopReason: "budget", usage: { costUsd: 0.6 } });
	});

	it("counts fetch attempts separately from successful fetches", async () => {
		const result = await executeResearch({ question: "main", fetchResults: 2, budget: { ...budget, maxFetches: 1 } }, () => provider(false, undefined, ["http://127.0.0.1/blocked", "http://127.0.0.1/blocked-2"]), context());
		expect(result.fetchAttempts).toBe(1);
		expect(result.fetchesCompleted).toBe(0);
	});

	it("renders readable evidence instead of raw JSON", () => {
		const response = {
			question: "main",
			provider: "openai" as const,
			results: [{ url: "https://example.com/1", title: "Example", excerpt: "A useful source", provider: "openai", searchQuery: "main" }],
			fetched: [],
			stepsCompleted: 1,
			providerCalls: 1,
			fetchesCompleted: 0,
			fetchAttempts: 0,
			stopReason: "completed" as const,
			warnings: [],
		};
		const rendered = renderResearchResponse(response);
		expect(rendered).toContain("Question: main");
		expect(rendered).toContain("Search evidence:");
		expect(rendered).toContain("URL: https://example.com/1");
		expect(rendered).not.toContain('"results"');
	});

	it("keeps the complete model-visible research result within its budget", async () => {
		const tool = createWebResearchTool(() => provider());
		const result = await tool.execute("call-1", { question: "q".repeat(2_000), budget: { ...budget, maxOutputChars: 1_000 } }, undefined, undefined, context());
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") expect(new TextEncoder().encode(text.text).byteLength).toBeLessThanOrEqual(1_000);
	});

	it("bounds the serialized research response", async () => {
		const result = await executeResearch({ question: "q".repeat(2_000), budget: { ...budget, maxOutputChars: 1_000 } }, () => provider(), context());
		expect(new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength).toBeLessThanOrEqual(850);
	});

	it("rejects a cost ceiling when the selected provider has no estimate", async () => {
		await expect(executeResearch({ question: "main", budget: { ...budget, maxCostUsd: 0 } }, () => provider(), context())).rejects.toMatchObject({ code: "WEB_RESEARCH_BUDGET" });
	});
});
