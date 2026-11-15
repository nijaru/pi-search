import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import type { Provider, SearchRequest } from "./contracts";
import { createWebSearchTool, WebSearchParameters } from "./search-tool";
import { WebResearchParameters } from "./research-tool";

function evidenceProvider(search: Provider["search"]): Provider {
	return { id: "openai", profile: { auth: "none", costModel: "unknown" }, capabilities: {}, search };
}
const result = (request: SearchRequest) => ({
	query: request.query, provider: "openai" as const, appliedOptions: [], warnings: [],
	results: [{ url: "https://example.com/", provider: "openai" as const, searchQuery: request.query }],
	answer: { text: "Generated answer", contentTrust: "untrusted" as const, provider: "openai" as const, citations: [{ url: "https://example.com/" }] },
});

test("ordinary search schema exposes task controls and keeps backend controls under advanced", () => {
	expect(Object.keys(WebSearchParameters.properties)).toEqual(["query", "maxResults", "domains", "dateRange", "userLocation", "fetch", "advanced"]);
	expect(Check(WebSearchParameters, { query: "q" })).toBe(true);
	expect(Check(WebSearchParameters, { query: "q", advanced: { provider: "openai", executionModel: "search-model" }, fetch: { maxResults: 2, maxLength: 1000 } })).toBe(true);
	for (const legacy of [{ provider: "openai" }, { executionModel: "model" }, { includeContent: true }, { contentResults: 2 }, { answerMode: "auto" }]) {
		expect(Check(WebSearchParameters, { query: "q", ...legacy })).toBe(false);
	}
	expect(Check(WebSearchParameters, { query: "q", advanced: { unsupported: true } })).toBe(false);
});

test("grouped arguments forward specialized controls without changing their meaning", async () => {
	let received: SearchRequest | undefined;
	const tool = createWebSearchTool(evidenceProvider(async request => { received = request; return result(request); }));
	await tool.execute("call", {
		query: "q", maxResults: 3, domains: { include: ["example.com"] }, userLocation: { type: "approximate", country: "US" },
		advanced: { provider: "openai", executionModel: "search-model", mode: "keyword", answerMode: "auto", searchContextSize: "low", externalWebAccess: false, returnTokenBudget: "unlimited", searchContentTypes: ["image"], imageSettings: { caption: true } },
	}, undefined, undefined, {} as never);
	expect(received).toMatchObject({ query: "q", maxResults: 3, domains: { include: ["example.com"] }, userLocation: { type: "approximate", country: "US" }, providerHint: "openai", executionModel: "search-model", mode: "keyword", answerMode: "auto", searchContextSize: "low", externalWebAccess: false, returnTokenBudget: "unlimited", searchContentTypes: ["image"], imageSettings: { caption: true } });
});

test("normal search drops backend answers by default, and labels an explicitly requested summary", async () => {
	const modes: (string | undefined)[] = [];
	const tool = createWebSearchTool(evidenceProvider(async request => { modes.push(request.answerMode); return result(request); }));
	const ordinary = await tool.execute("call", { query: "q" }, undefined, undefined, {} as never);
	expect(ordinary.details?.answer).toBeUndefined();
	expect(ordinary.content[0]).not.toMatchObject({ text: expect.stringContaining("Generated answer") });
	const explicit = await tool.execute("call", { query: "q", advanced: { answerMode: "auto" } }, undefined, undefined, {} as never);
	expect(explicit.details?.answer?.text).toBe("Generated answer");
	expect(explicit.content[0]).toMatchObject({ text: expect.stringContaining("Provider summary (untrusted; verify claims against sources)") });
	expect(modes).toEqual(["evidence", "auto"]);
});

test("search output preserves and labels all excerpt provenance kinds", async () => {
	const kinds = ["provider-excerpt", "provider-summary", "provider-text"] as const;
	const tool = createWebSearchTool(evidenceProvider(async request => ({ ...result(request), results: kinds.map((excerptKind, i) => ({ url: `https://example.com/${i}`, provider: "openai", searchQuery: request.query, excerpt: "Untrusted text", excerptKind })) })));
	const response = await tool.execute("call", { query: "q" }, undefined, undefined, {} as never);
	expect(response.details?.results.map(source => source.excerptKind)).toEqual([...kinds]);
	const content = response.content[0];
	if (content.type !== "text") throw new Error("Expected text evidence");
	for (const label of ["Provider excerpt (not page-verified)", "Provider summary:", "Provider text (origin unspecified)"]) expect(content.text).toContain(label);
});

test("source-fetch controls validate before search dispatch and never leak into backend requests", async () => {
	let dispatches = 0;
	const provider = evidenceProvider(async request => {
		dispatches++;
		expect(request).not.toHaveProperty("fetch");
		expect(request).not.toHaveProperty("includeContent");
		return result(request);
	});
	const tool = createWebSearchTool(provider, { fetcher: async () => ({ url: "https://example.com/", content: "Page text", contentTrust: "untrusted", outputFormat: "markdown", extraction: "markdown", status: 200, redirectCount: 0, bytesRead: 9, fetchedAt: "2026-01-01T00:00:00Z", offset: 0, truncated: false, warnings: [] }) });
	for (const fetch of [false, [], { maxResults: 21 }, { maxResults: 0 }, { maxLength: 32001 }, { maxLength: 0 }]) {
		await expect(tool.execute("call", { query: "q", fetch } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "WEB_SEARCH_INVALID_REQUEST" });
	}
	expect(dispatches).toBe(0);
	const response = await tool.execute("call", { query: "q", fetch: { maxResults: 5, maxLength: 20000 } }, undefined, undefined, {} as never);
	expect(dispatches).toBe(1);
	expect(response.details?.sourceContents?.[0]?.content).toBe("Page text");
});

test("batch schema groups execution overrides and does not promise a billing cap", () => {
	const budget = { maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 1000, maxOutputChars: 1000 };
	expect(Check(WebResearchParameters, { question: "q", advanced: { provider: "exa" }, budget: { ...budget, maxEstimatedCostUsd: 0.1 } })).toBe(true);
	expect(Check(WebResearchParameters, { question: "q", provider: "exa", budget })).toBe(false);
	expect(Check(WebResearchParameters, { question: "q", budget: { ...budget, maxCostUsd: 0.1 } })).toBe(false);
});
