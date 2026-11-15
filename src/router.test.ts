import { describe, expect, it } from "bun:test";
import type { Provider, ProviderContext, SearchRequest, SearchResponse } from "./contracts";
import { createSearchRouter } from "./router";
import { executeSearchSelection } from "./search";
import { executeResearch } from "./research-tool";
import { createProviderError } from "./errors";

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
	it("chooses Codex regardless of the active chat model, and has no implicit fallback", () => {
		const route = createSearchRouter({ providers: [codex, openai, gemini, exa, brave], billingPolicy: "allow-configured-metered", braveFreeCapacityConfigured: true });
		for (const active of [undefined, codexModel, openaiModel, googleModel, model("local", "openai-completions")]) {
			const result = route({ query: "q" }, context(active));
			expect(result.provider.id).toBe("openai-codex");
			expect(result.fallbacks).toEqual([]);
		}
	});
	it("keeps configured primary selection independent of the active chat model", () => {
		const route = createSearchRouter({ providers: [codex, gemini], primary: "gemini" });
		for (const active of [undefined, codexModel, googleModel]) expect(route({ query: "q" }, context(active)).provider.id).toBe("gemini");
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
		await route({ query: "q" }, context(codexModel)).provider.search({ query: "q" }, new AbortController().signal, { model: codexModel, modelRegistry: registry });
		expect(received?.executionModel).toBe(codexModel.id);
		expect(execution?.model).toBeUndefined();
		expect(execution?.modelRegistry).toBe(registry);
	});
	it("never admits API-key search merely because its chat model is active", () => {
		const route = createSearchRouter({ providers: [openai, gemini, exa, brave], braveFreeCapacityConfigured: true });
		expect(route({ query: "q" }, context(openaiModel)).provider.id).toBe("brave");
		expect(route({ query: "q" }, context(googleModel)).provider.id).toBe("brave");
		expect(() => createSearchRouter({ providers: [openai, exa] })({ query: "q" }, context(openaiModel))).toThrow(/PI_SEARCH_ALLOW_METERED/);
	});
	it("uses OpenAI, Exa, then DeepSeek only under automatic metered admission", () => {
		const options = { billingPolicy: "allow-configured-metered" as const };
		expect(createSearchRouter({ ...options, providers: [openai, exa, deepseek] })({ query: "q" }, context()).provider.id).toBe("openai");
		expect(createSearchRouter({ ...options, providers: [exa, deepseek] })({ query: "q" }, context()).provider.id).toBe("exa");
		expect(createSearchRouter({ ...options, providers: [deepseek] })({ query: "q" }, context()).provider.id).toBe("deepseek");
	});
	it("prefers admitted Brave before API-key backends without creating an implicit fallback", () => {
		const route = createSearchRouter({ providers: [openai, exa, brave], billingPolicy: "prefer-free", braveFreeCapacityConfigured: true });
		expect(route({ query: "q" }, context())).toMatchObject({ provider: { id: "brave" }, fallbacks: [] });
	});
	it("uses a named fallback only for automatic requests; explicit hints are strict", () => {
		const route = createSearchRouter({ providers: [codex, exa, deepseek], fallback: "exa" });
		expect(route({ query: "q" }, context())).toMatchObject({ automatic: true, fallbacks: [{ id: "exa" }] });
		expect(route({ query: "q", providerHint: "deepseek" }, context())).toEqual({ provider: deepseek, automatic: false, fallbacks: [] });
		expect(route({ query: "q", providerHint: "openai-codex", executionModel: codexModel.id }, context())).toMatchObject({ automatic: false, fallbacks: [] });
	});
	it("never lets unused fallback constraints, missing models, or exhausted quota block the primary or batch", async () => {
		let dispatches = 0;
		const primary: Provider = { ...exa, search: async request => {
			dispatches++;
			return { query: request.query, provider: "exa", results: [{ url: "https://example.com/", provider: "exa", searchQuery: request.query }], warnings: [], appliedOptions: [] };
		} };
		for (const fallback of ["brave", "gemini"] as const) {
			const route = createSearchRouter({ providers: [primary, brave, gemini], primary: "exa", fallback, braveFreeCapacityConfigured: true, braveCapacity: { canAttempt: () => false, observe() {}, snapshot: () => undefined } });
			for (const request of [{ query: "q" }, { query: "q", dateRange: { from: "2026-01-01" } }]) {
				const ctx = context(undefined, []);
				expect((await executeSearchSelection(route(request, ctx), request)).provider).toBe("exa");
				expect((await executeResearch({ question: "q", ...request, budget: { maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 1000, maxOutputChars: 1000 } }, route, ctx)).provider).toBe("exa");
			}
		}
		expect(dispatches).toBe(8);
	});
	it("reports unusable fallback admission only when a safe primary failure actually needs it", async () => {
		const primary: Provider = { ...exa, search: async () => { throw createProviderError({ provider: "exa", kind: "auth", fallbackSafe: true, message: "primary rejected", retryable: false }); } };
		const route = createSearchRouter({ providers: [primary, brave], primary: "exa", fallback: "brave", braveFreeCapacityConfigured: true });
		const request = { query: "q", dateRange: { from: "2026-01-01" } };
		await expect(executeSearchSelection(route(request, context()), request)).rejects.toMatchObject({ provider: "brave", message: expect.stringContaining("primary rejected") });
	});
	it("shares OpenAI automatic model eligibility with the adapter while retaining explicit model pins", () => {
		const ctx = context(undefined, [model("openai", "openai-responses", "gpt-5-pro")]);
		const route = createSearchRouter({ providers: [openai, exa], billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q" }, ctx).provider.id).toBe("exa");
		expect(() => route({ query: "q", providerHint: "openai" }, ctx)).toThrow(/No available openai/);
		expect(route({ query: "q", providerHint: "openai", executionModel: "gpt-5-pro" }, ctx).provider.id).toBe("openai");
	});
	it("does not apply a configured primary model to another explicit backend or its fallback", async () => {
		const seen: (string | undefined)[] = [];
		const adapter: Provider = { ...openai, search: async request => {
			seen.push(request.executionModel);
			return { query: "q", results: [], provider: "openai", appliedOptions: [], warnings: [] };
		} };
		const route = createSearchRouter({ providers: [codex, adapter], primary: "openai-codex", executionModel: codexModel.id, fallback: "openai" });
		const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) } };
		await route({ query: "q" }, context()).fallbacks[0]!.search({ query: "q" }, new AbortController().signal, ctx);
		await route({ query: "q", providerHint: "openai", executionModel: openaiModel.id }, context()).provider.search({ query: "q" }, new AbortController().signal, ctx);
		expect(seen).toEqual([undefined, openaiModel.id]);
	});
	it("routes around unsupported filters before automatic dispatch without dropping them", () => {
		const route = createSearchRouter({ providers: [codex, xaiX, exa], billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q", dateRange: { from: "2026-01-01" } }, context(xaiModel)).provider.id).toBe("exa");
		const strict = createSearchRouter({ providers: [codex, exa], primary: "openai-codex" });
		expect(() => strict({ query: "q", dateRange: { from: "2026-01-01" } }, context())).toThrow(/date range/);
		expect(() => route({ query: "q", providerHint: "openai-codex", dateRange: { from: "2026-01-01" } }, context())).toThrow(/date range/);
	});
	it("does not silently change web search into X search", () => {
		const route = createSearchRouter({ providers: [xai, xaiX], primary: "xai" });
		expect(() => route({ query: "q", dateRange: { from: "2026-01-01" } }, context())).toThrow(/date range/);
		expect(() => route({ query: "q", social: { includeHandles: ["one"] } }, context())).toThrow(/social\/X/);
		expect(route({ query: "q", providerHint: "xai-x", social: { includeHandles: ["one"] } }, context()).provider.id).toBe("xai-x");
	});
	it("enforces combined domain, handle, and media capabilities", () => {
		const limited = provider("anthropic", { domainFilter: true, combinedDomainFilters: false }, true);
		const models = [model("anthropic", "anthropic-messages")];
		const route = createSearchRouter({ providers: [limited, xaiX] });
		expect(() => route({ query: "q", providerHint: "anthropic", domains: { include: ["a.com"], exclude: ["b.com"] } }, context(undefined, models))).toThrow(/domain filters/);
		expect(() => route({ query: "q", providerHint: "xai-x", social: { includeHandles: ["one"], excludeHandles: ["two"] } }, context())).toThrow(/social\/X/);
		const supported = provider("x", { social: true, handleFilter: true, combinedHandleFilters: true });
		expect(createSearchRouter({ providers: [supported] })({ query: "q", providerHint: "x", social: { includeHandles: ["one"], excludeHandles: ["two"] } }, context()).provider.id).toBe("x");
		expect(() => createSearchRouter({ providers: [supported] })({ query: "q", providerHint: "x", social: { understandImages: true } }, context())).toThrow(/social\/X/);
	});
	it.each(["searchContextSize", "returnTokenBudget", "externalWebAccess", "userLocation", "searchContentTypes", "imageSettings"] as const)("does not drop %s", field => {
		const values = { searchContextSize: "low", returnTokenBudget: "default", externalWebAccess: false, userLocation: { type: "approximate", country: "US" }, searchContentTypes: ["image"], imageSettings: { caption: true } };
		const request = { query: "q", providerHint: "exa", [field]: values[field], ...(field === "imageSettings" ? { searchContentTypes: ["image"] } : {}) } as SearchRequest;
		expect(() => createSearchRouter({ providers: [exa] })(request, context())).toThrow(/cannot satisfy/);
	});
	it("normalizes empty filters before checking capability", () => {
		expect(createSearchRouter({ providers: [brave], braveFreeCapacityConfigured: true })({ query: "q", social: { understandImages: false }, dateRange: {} }, context()).provider.id).toBe("brave");
	});
	it("honors Brave admission and observed quota for explicit and automatic routing", () => {
		expect(() => createSearchRouter({ providers: [brave] })({ query: "q" }, context())).toThrow(/admission/);
		const capacity = { canAttempt: () => false, observe: () => {}, snapshot: () => ({ windows: [{ remaining: 0 }] }) };
		const options = { providers: [brave, exa], braveFreeCapacityConfigured: true, braveCapacity: capacity };
		expect(() => createSearchRouter(options)({ query: "q", providerHint: "brave" }, context())).toThrow(/quota window/);
		expect(() => createSearchRouter(options)({ query: "q" }, context())).toThrow(/quota window/);
		expect(createSearchRouter({ ...options, billingPolicy: "prefer-free" })({ query: "q" }, context()).provider.id).toBe("exa");
	});
	it("keeps specialty and answer backends out of automatic routing", () => {
		const providers = [provider("cloudflare"), provider("parallel"), provider("x"), provider("parallel-responses"), provider("brave-answers"), gemini];
		const route = createSearchRouter({ providers, billingPolicy: "allow-configured-metered" });
		expect(() => route({ query: "q" }, context())).toThrow(/No eligible/);
		for (const adapter of providers) expect(route({ query: "q", providerHint: adapter.id }, context()).provider.id).toBe(adapter.id);
		expect(() => createSearchRouter({ providers: [] })({ query: "q", providerHint: "parallel-responses" }, context())).toThrow(/not configured or enabled/);
	});
	it("keeps following the active model an explicit native-only escape hatch", () => {
		const route = createSearchRouter({ providers: [gemini, xai, xaiX] });
		expect(route({ query: "q", providerHint: "native" }, context(googleModel)).provider.id).toBe("gemini");
		expect(route({ query: "q", providerHint: "native", social: { includeHandles: ["one"] } }, context(xaiModel)).provider.id).toBe("xai-x");
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
		expect(() => createSearchRouter({ providers: [codex], fallback: "exa" })).toThrow(/not configured/);
		expect(() => createSearchRouter({ providers: [codex], primary: "openai-codex", fallback: "openai-codex" })).toThrow(/must differ/);
		expect(() => createSearchRouter({ providers: [exa], primary: "exa", executionModel: "model" })).toThrow(/model-mediated/);
	});
});
