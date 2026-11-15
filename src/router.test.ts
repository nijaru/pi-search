import { describe, expect, it } from "bun:test";
import type { Provider, ProviderContext, SearchRequest, SearchResponse } from "./contracts";
import { createSearchRouter } from "./router";
import { executeSearchPlan } from "./search";
import { executeResearch } from "./research-tool";
import { createProviderError } from "./errors";
import { createDeepSeekProvider } from "./deepseek";
import { createParallelProvider } from "./parallel";
import { createCloudflareProvider } from "./cloudflare";

function provider(id: Provider["id"], capabilities: Provider["capabilities"] = {}, native = false): Provider {
	return { id, capabilities, profile: { auth: native ? "modelRegistry" : "direct", costModel: "unknown" },
		search: async () => ({ query: "q", results: [], provider: id, appliedOptions: [], warnings: [] }) };
}
function model(provider: string, api: string, id = "search-model") {
	return { provider, api, id, baseUrl: "https://example.test" };
}
const codexModel = model("openai-codex", "openai-codex-responses");
const openaiModel = model("openai", "openai-responses");
const googleModel = model("google", "google-generative-ai");
const xaiModel = model("xai", "openai-responses");
function context(active?: ReturnType<typeof model>, available = [codexModel, openaiModel, googleModel, xaiModel]): any {
	return { model: active, modelRegistry: { getAvailable: () => available } };
}
const codex = provider("openai-codex", { freshness: true, domainFilter: true }, true);
const openai = provider("openai", { freshness: true, domainFilter: true }, true);
const gemini = provider("gemini", { freshness: true }, true);
const xai = provider("xai", { domainFilter: true }, true);
const xaiX = provider("xai-x", { social: true, dateFilter: true, handleFilter: true, mediaUnderstanding: true }, true);
const exa = provider("exa", { semantic: true, domainFilter: true, dateFilter: true });
const deepseek = provider("deepseek", { domainFilter: true, dateFilter: true });
const brave = provider("brave", { domainFilter: true });

describe("search backend policy", () => {
	it("matches the active provider and authentication before ordered approved alternatives", () => {
		const route = createSearchRouter({ providers: [codex, openai, gemini, exa, brave], billingPolicy: "allow-configured-metered", braveFreeCapacityConfigured: true });
		for (const [active, expected] of [[codexModel, "openai-codex"], [openaiModel, "openai"], [googleModel, "gemini"], [undefined, "exa"], [model("local", "openai-completions"), "exa"]] as const) {
			const result = route({ query: "q" }, context(active));
			expect(result.providers[0].id).toBe(expected);
			expect(result.providers.map(provider => provider.id)).toEqual([expected, ...["exa", "brave", "openai-codex", "openai", "gemini"].filter(id => id !== expected)]);
		}
	});
	it("keeps configured primary selection independent of the active chat model", () => {
		const route = createSearchRouter({ providers: [codex, gemini], primary: "gemini" });
		for (const active of [undefined, codexModel, googleModel]) expect(route({ query: "q" }, context(active)).providers[0].id).toBe("gemini");
	});
	it("does not borrow the active chat execution model or lose registry services", async () => {
		let received: SearchRequest | undefined;
		let execution: ProviderContext | undefined;
		const adapter: Provider = { ...codex, search: async (request, _signal, ctx) => {
			received = request; execution = ctx;
			return { query: "q", results: [], provider: "openai-codex", appliedOptions: [], warnings: [] };
		} };
		const registry = { getApiKeyAndHeaders: async () => ({ ok: true as const, baseUrl: "https://route.example", headers: { authorization: null } }) };
		const route = createSearchRouter({ providers: [adapter], primary: "openai-codex", executionModel: codexModel.id });
		await route({ query: "q" }, context(codexModel)).providers[0].search({ query: "q" }, new AbortController().signal, { model: codexModel, modelRegistry: registry });
		expect(received?.executionModel).toBe(codexModel.id);
		expect(execution?.model).toBeUndefined();
		expect(execution?.modelRegistry).toBe(registry);
	});
	it("admits the active authentication but does not turn other cached keys or logins into spending consent", () => {
		const route = createSearchRouter({ providers: [codex, openai, gemini, exa, brave], braveFreeCapacityConfigured: true });
		expect(route({ query: "q" }, context(openaiModel)).providers.map(p => p.id)).toEqual(["openai", "brave"]);
		expect(route({ query: "q" }, context(googleModel)).providers.map(p => p.id)).toEqual(["gemini", "brave"]);
		expect(route({ query: "q" }, context(codexModel)).providers.map(p => p.id)).toEqual(["openai-codex", "brave"]);
		expect(route({ query: "q" }, context(model("local", "openai-completions"))).providers.map(p => p.id)).toEqual(["brave"]);
		expect(() => createSearchRouter({ providers: [codex, openai, exa] })({ query: "q" }, context())).toThrow(/No eligible/);
	});
	it("uses dedicated search before off-provider model calls under metered admission", () => {
		const options = { billingPolicy: "allow-configured-metered" as const };
		expect(createSearchRouter({ ...options, providers: [openai, exa, deepseek] })({ query: "q" }, context()).providers[0].id).toBe("exa");
		expect(createSearchRouter({ ...options, providers: [exa, deepseek] })({ query: "q" }, context()).providers[0].id).toBe("exa");
		expect(createSearchRouter({ ...options, providers: [deepseek] })({ query: "q" }, context()).providers[0].id).toBe("deepseek");
	});
	it("orders admitted Brave before API-key fallbacks in prefer-free mode", () => {
		const route = createSearchRouter({ providers: [openai, exa, brave], billingPolicy: "prefer-free", braveFreeCapacityConfigured: true });
		expect(route({ query: "q" }, context()).providers.map(p => p.id)).toEqual(["brave", "exa", "openai"]);
	});
	it("uses an explicit ordered allowlist, skips missing adapters, deduplicates the preferred provider, and keeps hints strict", () => {
		const route = createSearchRouter({ providers: [codex, exa, deepseek], fallbacks: ["deepseek", "parallel", "exa", "openai-codex"] });
		expect(route({ query: "q" }, context(codexModel)).providers.map(p => p.id)).toEqual(["openai-codex", "deepseek", "exa"]);
		expect(route({ query: "q", providerHint: "deepseek" }, context()).providers.map(p => p.id)).toEqual(["deepseek"]);
		expect(route({ query: "q", providerHint: "openai-codex", executionModel: codexModel.id }, context()).providers.map(p => p.id)).toEqual(["openai-codex"]);
		expect(createSearchRouter({ providers: [codex, exa], fallbacks: [] })({ query: "q" }, context(codexModel)).providers.map(p => p.id)).toEqual(["openai-codex"]);
	});
	it("never lets unused fallback constraints, missing models, or exhausted quota block the primary or batch", async () => {
		let dispatches = 0;
		const primary: Provider = { ...exa, search: async request => {
			dispatches++;
			return { query: request.query, provider: "exa", results: [{ url: "https://example.com/", provider: "exa", searchQuery: request.query }], warnings: [], appliedOptions: [] };
		} };
		for (const fallback of ["brave", "gemini"] as const) {
			const route = createSearchRouter({ providers: [primary, brave, gemini], primary: "exa", fallbacks: [fallback], braveFreeCapacityConfigured: true, braveCapacity: { canAttempt: () => false, observe() {}, snapshot: () => undefined } });
			for (const request of [{ query: "q" }, { query: "q", dateRange: { from: "2026-01-01" } }]) {
				const ctx = context(undefined, []);
				expect((await executeSearchPlan(route(request, ctx), request)).provider).toBe("exa");
				expect((await executeResearch({ question: "q", ...request, budget: { maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 1000, maxOutputChars: 1000 } }, route, ctx)).provider).toBe("exa");
			}
		}
		expect(dispatches).toBe(8);
	});
	it("skips incapable fallback providers rather than dispatching requests with missing constraints", async () => {
		const primary: Provider = { ...exa, search: async () => { throw createProviderError({ provider: "exa", kind: "auth", fallbackSafe: true, message: "primary rejected", retryable: false }); } };
		const route = createSearchRouter({ providers: [primary, brave], primary: "exa", fallbacks: ["brave"], braveFreeCapacityConfigured: true });
		const request = { query: "q", dateRange: { from: "2026-01-01" } };
		await expect(executeSearchPlan(route(request, context()), request)).rejects.toMatchObject({ provider: "exa", message: expect.stringContaining("primary rejected") });
	});
	it("shares OpenAI automatic model eligibility with the adapter while retaining explicit model pins", () => {
		const ctx = context(undefined, [model("openai", "openai-responses", "gpt-5-pro")]);
		const route = createSearchRouter({ providers: [openai, exa], billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q" }, ctx).providers[0].id).toBe("exa");
		expect(() => route({ query: "q", providerHint: "openai" }, ctx)).toThrow(/No available openai/);
		expect(route({ query: "q", providerHint: "openai", executionModel: "gpt-5-pro" }, ctx).providers[0].id).toBe("openai");
		for (const id of ["gpt-5-pro", "gpt-5-ultra"]) {
			const active = model("openai", "openai-responses", id);
			expect(route({ query: "q" }, context(active, [active])).providers[0].id).toBe("exa");
			expect(route({ query: "q" }, context(active, [active, openaiModel])).providers[0].id).toBe("openai");
		}
		const missingActive = model("openai", "openai-responses", "missing-active");
		expect(createSearchRouter({ providers: [openai], fallbacks: ["openai"] })({ query: "q" }, context(missingActive, [openaiModel])).providers[0].id).toBe("openai");
	});
	it("does not apply a configured primary model to another explicit backend or its fallback", async () => {
		const seen: (string | undefined)[] = [];
		const adapter: Provider = { ...openai, search: async request => {
			seen.push(request.executionModel);
			return { query: "q", results: [], provider: "openai", appliedOptions: [], warnings: [] };
		} };
		const route = createSearchRouter({ providers: [codex, adapter], primary: "openai-codex", executionModel: codexModel.id, fallbacks: ["openai"] });
		const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) } };
		await route({ query: "q" }, context()).providers[1]!.search({ query: "q" }, new AbortController().signal, ctx);
		await route({ query: "q", providerHint: "openai", executionModel: openaiModel.id }, context()).providers[0].search({ query: "q" }, new AbortController().signal, ctx);
		expect(seen).toEqual([undefined, openaiModel.id]);
	});
	it("routes around unsupported filters before automatic dispatch without dropping them", () => {
		const route = createSearchRouter({ providers: [codex, xaiX, exa], billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q", dateRange: { from: "2026-01-01" } }, context(xaiModel)).providers[0].id).toBe("exa");
		const strict = createSearchRouter({ providers: [codex, exa], primary: "openai-codex" });
		expect(() => strict({ query: "q", dateRange: { from: "2026-01-01" } }, context())).toThrow(/date range/);
		expect(() => route({ query: "q", providerHint: "openai-codex", dateRange: { from: "2026-01-01" } }, context())).toThrow(/date range/);
	});
	it("does not silently change web search into X search", () => {
		const route = createSearchRouter({ providers: [xai, xaiX], primary: "xai" });
		expect(() => route({ query: "q", dateRange: { from: "2026-01-01" } }, context())).toThrow(/date range/);
		expect(() => route({ query: "q", social: { includeHandles: ["one"] } }, context())).toThrow(/social\/X/);
		expect(route({ query: "q", providerHint: "xai-x", social: { includeHandles: ["one"] } }, context()).providers[0].id).toBe("xai-x");
	});
	it("enforces combined domain, handle, and media capabilities", () => {
		const limited = provider("anthropic", { domainFilter: true, combinedDomainFilters: false }, true);
		const models = [model("anthropic", "anthropic-messages")];
		const route = createSearchRouter({ providers: [limited, xaiX] });
		expect(() => route({ query: "q", providerHint: "anthropic", domains: { include: ["a.com"], exclude: ["b.com"] } }, context(undefined, models))).toThrow(/domain filters/);
		expect(() => route({ query: "q", providerHint: "xai-x", social: { includeHandles: ["one"], excludeHandles: ["two"] } }, context())).toThrow(/social\/X/);
		const supported = provider("x", { social: true, handleFilter: true, combinedHandleFilters: true });
		expect(createSearchRouter({ providers: [supported] })({ query: "q", providerHint: "x", social: { includeHandles: ["one"], excludeHandles: ["two"] } }, context()).providers[0].id).toBe("x");
		expect(() => createSearchRouter({ providers: [supported] })({ query: "q", providerHint: "x", social: { understandImages: true } }, context())).toThrow(/social\/X/);
	});
	it.each(["searchContextSize", "returnTokenBudget", "externalWebAccess", "userLocation", "searchContentTypes", "imageSettings"] as const)("does not drop %s", field => {
		const values = { searchContextSize: "low", returnTokenBudget: "default", externalWebAccess: false, userLocation: { type: "approximate", country: "US" }, searchContentTypes: ["image"], imageSettings: { caption: true } };
		const request = { query: "q", providerHint: "exa", [field]: values[field], ...(field === "imageSettings" ? { searchContentTypes: ["image"] } : {}) } as SearchRequest;
		expect(() => createSearchRouter({ providers: [exa] })(request, context())).toThrow(/cannot satisfy/);
	});
	it("preflights real adapter limits that coarse capability flags cannot express", () => {
		const route = createSearchRouter({ providers: [
			createParallelProvider({ apiKey: "test" }), createDeepSeekProvider({ apiKey: "test" }),
			createCloudflareProvider({ upstream: "exa", accountId: "test", apiToken: "test" }), exa,
		], fallbacks: ["parallel", "deepseek", "cloudflare", "exa"] });
		const filtered = { query: "q".repeat(129), dateRange: { from: "2026-01-01", to: "2026-02-01" } };
		expect(route(filtered, context()).providers.map(p => p.id)).toEqual(["exa"]);
		expect(route({ query: "q".repeat(1025) }, context()).providers.map(p => p.id)).toEqual(["parallel", "exa"]);
		expect(() => route({ ...filtered, providerHint: "parallel" }, context())).toThrow(/upper date bound/);
	});
	it("normalizes empty filters before checking capability", () => {
		expect(createSearchRouter({ providers: [brave], braveFreeCapacityConfigured: true })({ query: "q", social: { understandImages: false }, dateRange: {} }, context()).providers[0].id).toBe("brave");
	});
	it("honors Brave admission and observed quota for explicit and automatic routing", () => {
		expect(() => createSearchRouter({ providers: [brave] })({ query: "q" }, context())).toThrow(/admission/);
		const capacity = { canAttempt: () => false, observe: () => {}, snapshot: () => ({ windows: [{ remaining: 0 }] }) };
		const options = { providers: [brave, exa], braveFreeCapacityConfigured: true, braveCapacity: capacity };
		expect(() => createSearchRouter(options)({ query: "q", providerHint: "brave" }, context())).toThrow(/quota window/);
		expect(() => createSearchRouter(options)({ query: "q" }, context())).toThrow(/quota window/);
		expect(createSearchRouter({ ...options, billingPolicy: "prefer-free" })({ query: "q" }, context()).providers[0].id).toBe("exa");
	});
	it("includes dedicated retrieval and authenticated native fallbacks, but not answer-synthesis or unsolicited X search", () => {
		const providers = [provider("cloudflare"), provider("parallel"), provider("x"), provider("parallel-responses"), provider("brave-answers"), gemini];
		const route = createSearchRouter({ providers, billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q" }, context()).providers.map(p => p.id)).toEqual(["parallel", "cloudflare", "gemini"]);
		for (const adapter of providers) expect(route({ query: "q", providerHint: adapter.id }, context()).providers[0].id).toBe(adapter.id);
		expect(() => createSearchRouter({ providers: [] })({ query: "q", providerHint: "parallel-responses" }, context())).toThrow(/not configured or enabled/);
	});
	it("keeps the native override active-only without fallback", () => {
		const route = createSearchRouter({ providers: [gemini, xai, xaiX] });
		expect(route({ query: "q", providerHint: "native" }, context(googleModel)).providers[0].id).toBe("gemini");
		expect(route({ query: "q", providerHint: "native", social: { includeHandles: ["one"] } }, context(xaiModel)).providers[0].id).toBe("xai-x");
		expect(() => route({ query: "q", providerHint: "native" }, context())).toThrow(/active supported/);
	});
	it("rejects unavailable models, unqualified model overrides, duplicates and invalid configuration", () => {
		const route = createSearchRouter({ providers: [codex] });
		expect(() => route({ query: "q", providerHint: "openai-codex", executionModel: "missing" }, context())).toThrow(/matching missing/);
		expect(() => route({ query: "q", executionModel: "search-model" }, context())).toThrow(/explicit model-mediated/);
		expect(() => route({ query: "q", providerHint: "native", executionModel: "search-model" }, context(codexModel))).toThrow(/explicit model-mediated/);
		expect(() => route({ query: "q" }, context(undefined, []))).toThrow(/No eligible/);
		expect(() => createSearchRouter({ providers: [codex, codex] })).toThrow(/unique/);
		expect(() => createSearchRouter({ providers: [codex], primary: "exa" })).toThrow(/not configured/);
		expect(createSearchRouter({ providers: [codex], fallbacks: ["exa"] })({ query: "q" }, context(codexModel)).providers).toHaveLength(1);
		expect(() => createSearchRouter({ providers: [exa], primary: "exa", executionModel: "model" })).toThrow(/model-mediated/);
	});
});
