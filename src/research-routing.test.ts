import { expect, spyOn, test } from "bun:test";
import type { Provider, SearchPlan } from "./contracts";
import { createProviderError } from "./errors";
import { executeResearch, renderResearchResponse } from "./research-tool";
import { createSearchRouter } from "./router";
import { createDeepSeekProvider } from "./deepseek";

const budget = { maxSteps: 4, maxProviderCalls: 4, maxFetches: 0, timeoutMs: 1000, maxOutputChars: 20000 };
function adapter(id: string, search: Provider["search"], estimatedCostUsd?: number): Provider {
	return { id, profile: { auth: "none", costModel: "unknown", estimatedCostUsd }, capabilities: {}, search };
}
const unavailable = (id: string) => createProviderError({ provider: id, kind: "auth", fallbackSafe: true, message: "missing credential", retryable: false });
const response = (provider: string, query: string) => ({ provider, query, results: [{ provider, url: `https://example.com/${query}`, searchQuery: query }], warnings: [], appliedOptions: [] });

test("batch fallback counts every attempt, releases proven-unbilled reservations, and retires the rejected prefix", async () => {
	const calls: string[] = [];
	const plan: SearchPlan = { providers: [
		adapter("openai", async () => { calls.push("openai"); throw unavailable("openai"); }, 0.005),
		adapter("exa", async () => { calls.push("exa"); throw createProviderError({ provider: "exa", kind: "rateLimit", status: 429, message: "quota", retryable: true }); }, 0.005),
		adapter("deepseek", async request => { calls.push("deepseek"); return { ...response("deepseek", request.query), usage: { costUsd: 0.004 } }; }, 0.005),
	] };
	const result = await executeResearch({ question: "q", queries: ["one", "two"], budget: { ...budget, maxEstimatedCostUsd: 0.01 } }, () => plan, {} as never);
	expect(result).toMatchObject({ provider: "deepseek", stepsCompleted: 4, providerCalls: 4, stopReason: "completed", attemptedProviders: ["openai", "exa", "deepseek", "deepseek"] });
	expect(result.attemptedProviders).toEqual(calls);
	expect(result.results.map(result => result.searchQuery)).toEqual(["one", "two"]);
	expect(result.usage?.costUsd).toBeCloseTo(0.008);
	expect(result.estimatedCostUsd).toBeCloseTo(0.008);
});

test("fallback cannot bypass a batch call/step budget", async () => {
	let dispatches = 0;
	const plan: SearchPlan = { providers: [
		adapter("openai", async () => { dispatches++; throw unavailable("openai"); }),
		adapter("exa", async () => { dispatches++; throw unavailable("exa"); }),
		adapter("deepseek", async request => { dispatches++; return response("deepseek", request.query); }),
	] };
	for (const limit of [{ maxProviderCalls: 2 }, { maxSteps: 2 }]) {
		dispatches = 0;
		const result = await executeResearch({ question: "q", budget: { ...budget, ...limit } }, () => plan, {} as never);
		expect(result).toMatchObject({ stopReason: "budget", providerCalls: 2, stepsCompleted: 2, attemptedProviders: ["openai", "exa"] });
		expect(dispatches).toBe(2);
		expect(result.results).toHaveLength(0);
	}
});

test("a batch spending threshold never authorizes an unknown-cost fallback", async () => {
	let unestimated = 0;
	const plan: SearchPlan = { providers: [
		adapter("exa", async () => { throw unavailable("exa"); }, 0.005),
		adapter("gemini", async request => { unestimated++; return response("gemini", request.query); }),
	] };
	const result = await executeResearch({ question: "q", budget: { ...budget, maxEstimatedCostUsd: 0.01 } }, () => plan, {} as never);
	expect(result).toMatchObject({ stopReason: "budget", providerCalls: 1, attemptedProviders: ["exa"] });
	expect(unestimated).toBe(0);
	expect(result.usage).toBeUndefined();
});

test("mixed-backend results keep provenance and clear stale summary metadata; partial estimates are disclosed", async () => {
	let preferredCalls = 0;
	const plan: SearchPlan = { providers: [
		adapter("openai", async request => {
			if (++preferredCalls === 2) throw unavailable("openai");
			return { ...response("openai", request.query), executionModel: "api-model", upstreamProvider: "upstream", warnings: Array.from({ length: 10 }, () => ({ code: "partial-results" as const, message: "Other warning" })), usage: { billedUnits: 2, billedUnit: "credits", rateLimits: { windows: [{ remaining: 10 }] } } };
		}, 0.003),
		adapter("gemini", async request => ({ ...response("gemini", request.query), usage: { billedUnits: 4, billedUnit: "credits" } })),
	] };
	const result = await executeResearch({ question: "q", queries: ["one", "two"], budget }, () => plan, {} as never);
	expect(result.provider).toBe("gemini");
	expect(result.executionModel).toBeUndefined();
	expect(result.upstreamProvider).toBeUndefined();
	expect(result.results.map(result => result.provider)).toEqual(["openai", "gemini"]);
	expect(result.usage?.billedUnits).toBeUndefined();
	expect(result.usage?.billedUnit).toBeUndefined();
	expect(result.usage?.rateLimits).toBeUndefined();
	expect(renderResearchResponse(result)).toContain("   Provider: openai");
	expect(renderResearchResponse(result)).toContain("   Provider: gemini");
	expect(result.estimatedCostUsd).toBeCloseTo(0.003);
	expect(result.warnings).toHaveLength(8);
	expect(result.unknownCostProviders).toEqual(["gemini"]);
	expect(renderResearchResponse(result)).toContain("Estimated spending (partial; not a billing cap)");
	expect(renderResearchResponse(result)).toContain("Cost unknown for: gemini");
});

test("each batch query gets its own pure preflight without retiring backends skipped only for query length", async () => {
	for (const queries of [["q".repeat(129), "short"], ["short", "q".repeat(129)]]) {
		const calls: string[] = [];
		const deepseek = createDeepSeekProvider({ apiKey: "test", fetchImpl: async (_url, init) => {
			calls.push("deepseek");
			expect(JSON.parse(String(init?.body)).query).toBe("short");
			return Response.json({ results: [{ url: "https://example.com/short", snippet: "Evidence" }] });
		} });
		const exa = adapter("exa", async request => { calls.push("exa"); return response("exa", request.query); });
		const route = createSearchRouter({ providers: [deepseek, exa], fallbacks: ["deepseek", "exa"] });
		const result = await executeResearch({ question: "q", queries, budget: { ...budget, maxProviderCalls: 2, maxSteps: 2 } }, route, {} as never);
		expect(result).toMatchObject({ providerCalls: 2, stepsCompleted: 2, stopReason: "completed" });
		expect(calls).toEqual(queries.map(query => query === "short" ? "deepseek" : "exa"));
		expect(result.results).toHaveLength(2);
	}
});

test("a deadline between safe attempts never reserves cost or records an invocation for the next backend", async () => {
	let time = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => time);
	let fallbacks = 0;
	try {
		const plan: SearchPlan = { providers: [
			adapter("exa", async () => { time += 1001; throw unavailable("exa"); }, 0.01),
			adapter("deepseek", async request => { fallbacks++; return response("deepseek", request.query); }, 0.01),
		] };
		const result = await executeResearch({ question: "q", budget }, () => plan, {} as never);
		expect(result).toMatchObject({ stopReason: "deadline", providerCalls: 1, stepsCompleted: 1, attemptedProviders: ["exa"], estimatedCostUsd: 0 });
		expect(fallbacks).toBe(0);
		expect(result.usage).toBeUndefined();
		expect(result.warnings.some(item => item.message.includes("retained the failed call"))).toBe(false);
	} finally { clock.mockRestore(); }
});
