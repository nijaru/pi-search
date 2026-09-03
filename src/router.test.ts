import { describe, expect, it } from "bun:test";
import type { Provider, SearchResponse } from "./contracts";
import { createSearchRouter } from "./router";

function provider(id: Provider["id"], capabilities: Provider["capabilities"] = {}, auth: "none" | "modelRegistry" = "none"): Provider {
	const response: SearchResponse = { query: "q", results: [], provider: id, appliedOptions: [], warnings: [] };
	return {
		id,
		capabilities,
		profile: { auth, costModel: "free" },
		search: async () => response,
	};
}

function context(providerName?: string, api?: string, available: readonly Record<string, string>[] = []): any {
	return {
		model: providerName === undefined
			? undefined
			: { provider: providerName, id: "test", api: api ?? (providerName === "openai" ? "openai-responses" : providerName === "openai-codex" ? "openai-codex-responses" : "test"), baseUrl: "https://example.test" },
		modelRegistry: { getAvailable: () => available },
	};
}

function availableModel(provider: string, api: string, id = "gpt-5.5"): Record<string, string> {
	return { provider, api, id, baseUrl: "https://example.test" };
}

describe("search provider router", () => {
	const nativeOpenAI = provider("openai", { keyword: true, freshness: true, domainFilter: true }, "modelRegistry");
	const nativeCodex = provider("openai-codex", { keyword: true, freshness: true, domainFilter: true });
	const nativeGemini = provider("gemini", { freshness: true, semantic: true }, "modelRegistry");
	const nativeXAI = provider("xai", { freshness: true, semantic: true, domainFilter: true }, "modelRegistry");
	const exa = provider("exa", { keyword: true, freshness: true, semantic: true, domainFilter: true, dateFilter: true });
	const parallel = provider("parallel", { keyword: true, freshness: true, semantic: true });
	const x = provider("x", { keyword: true, freshness: true, excerpts: true, social: true });
	const brave = provider("brave", { keyword: true, freshness: true, domainFilter: true });

	it("keeps native OpenAI/Codex selection strict and first", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, openaiCodex: nativeCodex, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", mode: "keyword" }, context("openai")).provider.id).toBe("openai");
		expect(route({ query: "q" }, context("openai-codex")).provider.id).toBe("openai-codex");
	});

	it("uses an authenticated registry OpenAI model before direct search", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, exa, exaConfigured: true, billingPolicy: "allow-configured-metered" });
		const selected = route({ query: "q" }, context("openrouter", "openai-completions", [availableModel("openai", "openai-responses")]));
		expect(selected.provider.id).toBe("openai");
		expect(selected.automatic).toBe(true);
		expect(selected.fallbacks.map((item) => item.id)).toEqual(["exa"]);
	});

	it("uses configured Exa before Brave for non-native search", () => {
		const route = createSearchRouter({ exa, exaConfigured: true, brave, braveConfigured: true, braveFreeCapacityConfigured: true, billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q", mode: "fresh" }, context("anthropic")).provider.id).toBe("exa");
		expect(route({ query: "q" }, context("openrouter", "openai-completions")).provider.id).toBe("exa");
	});

	it("uses configured Brave when Exa is absent", () => {
		const route = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", mode: "fresh" }, context("anthropic")).provider.id).toBe("brave");
		expect(route({ query: "q" }, context("openrouter", "openai-completions")).provider.id).toBe("brave");
	});

	it("does not automatically spend configured Exa in free-only mode", () => {
		const route = createSearchRouter({ exa, exaConfigured: true });
		expect(() => route({ query: "q" }, context("anthropic"))).toThrow(/No eligible search provider/);
	});

	it("prefers admitted Brave over metered Exa", () => {
		const route = createSearchRouter({ exa, exaConfigured: true, brave, braveConfigured: true, braveFreeCapacityConfigured: true, billingPolicy: "prefer-free" });
		expect(route({ query: "q" }, context("anthropic")).provider.id).toBe("brave");
	});

	it("selects configured native grounding before Brave without an extra opt-in", () => {
		const route = createSearchRouter({ gemini: nativeGemini, xai: nativeXAI, xaiX: provider("xai-x", { social: true, dateFilter: true, handleFilter: true, mediaUnderstanding: true }, "modelRegistry"), brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q" }, context("google", "google-generative-ai")).provider.id).toBe("gemini");
		expect(route({ query: "q", providerHint: "native" }, context("google", "google-generative-ai")).provider.id).toBe("gemini");
		expect(route({ query: "q", mode: "keyword", providerHint: "gemini" }, context("google", "google-generative-ai")).provider.id).toBe("gemini");
		expect(route({ query: "q", mode: "keyword", providerHint: "xai" }, context("xai", "openai-responses")).provider.id).toBe("xai");
		expect(route({ query: "q", social: { includeHandles: ["xai"] } }, context("xai", "openai-responses")).provider.id).toBe("xai-x");
	});

	it("does not dispatch active Gemini when it cannot honor a hard domain filter", () => {
		const route = createSearchRouter({ gemini: nativeGemini, exa, exaConfigured: true, billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q", domains: { include: ["example.com"] } }, context("google", "google-generative-ai")).provider.id).toBe("exa");
	});

	it("does not silently drop hard date constraints on native OpenAI", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, exa, exaConfigured: true, billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q", dateRange: { from: "2026-01-01" } }, context("openai", "openai-responses")).provider.id).toBe("exa");
	});

	it("allows an explicit same-provider execution model from the registry", () => {
		const route = createSearchRouter({ openai: nativeOpenAI });
		expect(route({ query: "q", providerHint: "openai", executionModel: "gpt-5.6" }, context("openai", "openai-responses", [availableModel("openai", "openai-responses", "gpt-5.6")])).provider.id).toBe("openai");
	});

	it("allows explicit registry-backed Gemini and xAI execution", () => {
		const route = createSearchRouter({ gemini: nativeGemini, xaiX: provider("xai-x", { social: true, dateFilter: true, handleFilter: true, mediaUnderstanding: true }, "modelRegistry") });
		expect(route({ query: "q", providerHint: "gemini", executionModel: "gemini-flash-lite-latest" }, context("openrouter", "openai-completions", [availableModel("google", "google-generative-ai", "gemini-flash-lite-latest")])).provider.id).toBe("gemini");
		expect(route({ query: "q", providerHint: "xai-x", executionModel: "grok-4.5" }, context("openrouter", "openai-completions", [availableModel("xai", "openai-responses", "grok-4.5")])).provider.id).toBe("xai-x");
	});

	it("requires an explicit provider for an execution model", () => {
		const route = createSearchRouter({ exa, exaConfigured: true });
		expect(() => route({ query: "q", executionModel: "gemini-flash-lite-latest" }, context("openrouter"))).toThrow(/explicit model-mediated provider hint/);
	});

	it("allows the explicit native alias for configured grounded models", () => {
		const route = createSearchRouter({ gemini: nativeGemini, xai: nativeXAI });
		expect(route({ query: "q", providerHint: "native" }, context("google", "google-generative-ai")).provider.id).toBe("gemini");
		expect(route({ query: "q", providerHint: "native" }, context("xai", "openai-responses")).provider.id).toBe("xai");
	});

	it("requires free-mode admission to be supplied by the construction boundary", () => {
		const disabled = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: false });
		expect(() => disabled({ query: "q" }, context("anthropic"))).toThrow(/free-mode admission/);
		const capacity = { canAttempt: () => false, observe: () => {}, snapshot: () => ({ windows: [{ remaining: 0, resetAfterMs: 1000 }] }) };
		const exhausted = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true, braveCapacity: capacity });
		expect(() => exhausted({ query: "q" }, context("anthropic"))).toThrow("Brave quota window is exhausted");
	});

	it("honors strict provider hints without hidden fallback", () => {
		const route = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", providerHint: "brave" }, context("anthropic")).provider.id).toBe("brave");
		expect(() => route({ query: "q", providerHint: "native" }, context("anthropic"))).toThrow(/active supported grounded model/);
		expect(() => route({ query: "q", providerHint: "unknown" }, context("anthropic"))).toThrow(/not configured/);
	});

	it("routes OpenAI completions models through the normal automatic path", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		const selected = route({ query: "q" }, context("openai", "openai-completions"));
		expect(selected.provider.id).toBe("brave");
		expect(selected.automatic).toBe(true);
	});

	it("selects active Anthropic and Meta grounding automatically", () => {
		const nativeAnthropic = provider("anthropic", { freshness: true, semantic: true }, "modelRegistry");
		const nativeMeta = provider("meta", { freshness: true, semantic: true }, "modelRegistry");
		const route = createSearchRouter({ anthropic: nativeAnthropic, meta: nativeMeta, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q" }, context("anthropic", "anthropic-messages")).provider.id).toBe("anthropic");
		expect(route({ query: "q", providerHint: "native" }, context("anthropic", "anthropic-messages")).provider.id).toBe("anthropic");
		expect(route({ query: "q" }, context("meta", "openai-responses")).provider.id).toBe("meta");
		expect(route({ query: "q", providerHint: "native" }, context("meta", "openai-responses")).provider.id).toBe("meta");
	});

	it("allows explicit registry-backed Anthropic and Meta execution", () => {
		const nativeAnthropic = provider("anthropic", { freshness: true, semantic: true }, "modelRegistry");
		const nativeMeta = provider("meta", { freshness: true, semantic: true }, "modelRegistry");
		const route = createSearchRouter({ anthropic: nativeAnthropic, meta: nativeMeta });
		expect(route({ query: "q", providerHint: "anthropic", executionModel: "claude-opus-5" }, context("openrouter", "openai-completions", [availableModel("anthropic", "anthropic-messages", "claude-opus-5")])).provider.id).toBe("anthropic");
		expect(route({ query: "q", providerHint: "meta", executionModel: "muse-spark-1.3" }, context("openrouter", "openai-completions", [availableModel("meta", "openai-responses", "muse-spark-1.3")])).provider.id).toBe("meta");
		expect(() => route({ query: "q", providerHint: "anthropic" }, context("openrouter", "openai-completions", []))).toThrow(/explicit executionModel/);
	});

	it("falls through when the active native model cannot honor a hard filter", () => {
		const nativeAnthropic = provider("anthropic", { freshness: true, semantic: true }, "modelRegistry");
		const nativeMeta = provider("meta", { freshness: true, semantic: true }, "modelRegistry");
		const route = createSearchRouter({ anthropic: nativeAnthropic, meta: nativeMeta, exa, exaConfigured: true, billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q", dateRange: { from: "2026-01-01" } }, context("anthropic", "anthropic-messages")).provider.id).toBe("exa");
		expect(route({ query: "q", domains: { include: ["example.com"] } }, context("meta", "openai-responses")).provider.id).toBe("exa");
	});

	it("uses explicitly selected direct providers when configured", () => {
		const route = createSearchRouter({ exa, parallel, x, exaConfigured: true, parallelConfigured: true, xConfigured: true });
		expect(route({ query: "q", providerHint: "exa" }, context("local")).provider.id).toBe("exa");
		expect(route({ query: "q", providerHint: "parallel" }, context("local")).provider.id).toBe("parallel");
		expect(route({ query: "q", providerHint: "x" }, context("local")).provider.id).toBe("x");
		expect(() => createSearchRouter({ exa })({ query: "q", providerHint: "exa" }, context("local"))).toThrow(/not configured/);
	});
});
