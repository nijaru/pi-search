import { describe, expect, it } from "bun:test";
import type { Provider, SearchResponse } from "./contracts";
import { createSearchRouter } from "./router";

function provider(id: Provider["id"], capabilities: Provider["capabilities"] = {}): Provider {
	const response: SearchResponse = { query: "q", results: [], provider: id, appliedOptions: [], warnings: [] };
	return {
		id,
		capabilities,
		profile: { auth: "none", costModel: "free" },
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
	const nativeOpenAI = provider("openai", { keyword: true, freshness: true, domainFilter: true });
	const nativeCodex = provider("openai-codex", { keyword: true, freshness: true, domainFilter: true });
	const nativeGemini = provider("gemini", { freshness: true, semantic: true });
	const nativeXAI = provider("xai", { freshness: true, semantic: true, domainFilter: true });
	const exa = provider("exa", { keyword: true, freshness: true, semantic: true, domainFilter: true });
	const parallel = provider("parallel", { keyword: true, freshness: true, semantic: true });
	const x = provider("x", { keyword: true, freshness: true, excerpts: true, social: true });
	const brave = provider("brave", { keyword: true, freshness: true, domainFilter: true });

	it("keeps native OpenAI/Codex selection strict and first", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, openaiCodex: nativeCodex, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", mode: "keyword" }, context("openai")).provider.id).toBe("openai");
		expect(route({ query: "q" }, context("openai-codex")).provider.id).toBe("openai-codex");
	});

	it("uses an authenticated registry OpenAI model before direct search", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, exa, exaConfigured: true });
		const selected = route({ query: "q" }, context("openrouter", "openai-completions", [availableModel("openai", "openai-responses")]));
		expect(selected.provider.id).toBe("openai");
		expect(selected.automatic).toBe(true);
		expect(selected.fallbacks.map((item) => item.id)).toEqual(["exa"]);
	});

	it("uses configured Exa before Brave for non-native search", () => {
		const route = createSearchRouter({ exa, exaConfigured: true, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", mode: "fresh" }, context("anthropic")).provider.id).toBe("exa");
		expect(route({ query: "q" }, context("openrouter", "openai-completions")).provider.id).toBe("exa");
	});

	it("uses configured Brave when Exa is absent", () => {
		const route = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", mode: "fresh" }, context("anthropic")).provider.id).toBe("brave");
		expect(route({ query: "q" }, context("openrouter", "openai-completions")).provider.id).toBe("brave");
	});

	it("selects configured native grounding before Brave without an extra opt-in", () => {
		const route = createSearchRouter({ gemini: nativeGemini, xai: nativeXAI, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q" }, context("google", "google-generative-ai")).provider.id).toBe("gemini");
		expect(route({ query: "q", providerHint: "native" }, context("google", "google-generative-ai")).provider.id).toBe("gemini");
		expect(route({ query: "q", mode: "keyword", providerHint: "gemini" }, context("google", "google-generative-ai")).provider.id).toBe("gemini");
		expect(route({ query: "q", mode: "keyword", providerHint: "xai" }, context("xai", "openai-responses")).provider.id).toBe("xai");
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

	it("uses explicitly selected direct providers when configured", () => {
		const route = createSearchRouter({ exa, parallel, x, exaConfigured: true, parallelConfigured: true, xConfigured: true });
		expect(route({ query: "q", providerHint: "exa" }, context("local")).provider.id).toBe("exa");
		expect(route({ query: "q", providerHint: "parallel" }, context("local")).provider.id).toBe("parallel");
		expect(route({ query: "q", providerHint: "x" }, context("local")).provider.id).toBe("x");
		expect(() => createSearchRouter({ exa })({ query: "q", providerHint: "exa" }, context("local"))).toThrow(/not configured/);
	});
});
