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

function context(providerName?: string, api?: string): never {
	return {
		model: providerName === undefined
			? undefined
			: { provider: providerName, id: "test", api: api ?? (providerName === "openai" ? "openai-responses" : providerName === "openai-codex" ? "openai-codex-responses" : "test"), baseUrl: "https://example.test" },
	} as never;
}

describe("search provider router", () => {
	const nativeOpenAI = provider("openai", { keyword: true, freshness: true, domainFilter: true });
	const nativeCodex = provider("openai-codex", { keyword: true, freshness: true, domainFilter: true });
	const nativeGemini = provider("gemini", { freshness: true, semantic: true });
	const nativeXAI = provider("xai", { freshness: true, semantic: true, domainFilter: true });
	const exa = provider("exa", { keyword: true, freshness: true, semantic: true, domainFilter: true });
	const parallel = provider("parallel", { keyword: true, freshness: true, semantic: true });
	const brave = provider("brave", { keyword: true, freshness: true, domainFilter: true });

	it("keeps native OpenAI/Codex selection strict and first", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, openaiCodex: nativeCodex, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", mode: "keyword" }, context("openai")).id).toBe("openai");
		expect(route({ query: "q" }, context("openai-codex")).id).toBe("openai-codex");
	});

	it("uses configured Brave for free-capacity general search", () => {
		const route = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", mode: "fresh" }, context("anthropic")).id).toBe("brave");
	});

	it("selects active Gemini and xAI grounding before Brave", () => {
		const route = createSearchRouter({ gemini: nativeGemini, xai: nativeXAI, brave, braveConfigured: true, braveFreeCapacityConfigured: true, billingPolicy: "allow-configured-metered" });
		expect(route({ query: "q" }, context("google", "google-generative-ai")).id).toBe("gemini");
		expect(route({ query: "q", providerHint: "native" }, context("google", "google-generative-ai")).id).toBe("gemini");
		expect(route({ query: "q" }, context("xai", "openai-responses")).id).toBe("xai");
		expect(route({ query: "q", mode: "keyword", providerHint: "gemini" }, context("google", "google-generative-ai")).id).toBe("gemini");
		expect(route({ query: "q", mode: "keyword", providerHint: "xai" }, context("xai", "openai-responses")).id).toBe("xai");
	});

	it("does not allow metered native grounding through the native alias", () => {
		const route = createSearchRouter({ gemini: nativeGemini, xai: nativeXAI });
		expect(() => route({ query: "q", providerHint: "native" }, context("google", "google-generative-ai"))).toThrow(/Native grounding is metered/);
		expect(() => route({ query: "q", providerHint: "native" }, context("xai", "openai-responses"))).toThrow(/Native grounding is metered/);
	});

	it("does not select Brave from a key alone or after known quota exhaustion", () => {
		const unasserted = createSearchRouter({ brave, braveConfigured: true });
		expect(() => unasserted({ query: "q" }, context("anthropic"))).toThrow(/free capacity/);
		const capacity = { canAttempt: () => false, observe: () => {}, snapshot: () => ({ windows: [{ remaining: 0, resetAfterMs: 1000 }] }) };
		const exhausted = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true, braveCapacity: capacity });
		expect(() => exhausted({ query: "q" }, context("anthropic"))).toThrow("Brave quota window is exhausted");
	});

	it("honors strict provider hints without hidden fallback", () => {
		const route = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(route({ query: "q", providerHint: "brave" }, context("anthropic")).id).toBe("brave");
		expect(() => route({ query: "q", providerHint: "native" }, context("anthropic"))).toThrow(/active supported grounded model/);
		expect(() => route({ query: "q", providerHint: "unknown" }, context("anthropic"))).toThrow(/not configured/);
	});

	it("does not route OpenAI completions models to the Responses search adapter", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		expect(() => route({ query: "q" }, context("openai", "openai-completions"))).toThrow(/does not use the OpenAI Responses API/);
	});

	it("requires metered opt-in for explicit Exa and Parallel selection", () => {
		const freeRoute = createSearchRouter({ exa, parallel, exaConfigured: true, parallelConfigured: true });
		expect(() => freeRoute({ query: "q", providerHint: "exa" }, context("local"))).toThrow(/metered/);
		expect(() => freeRoute({ query: "q", providerHint: "parallel" }, context("local"))).toThrow(/metered/);
		const meteredRoute = createSearchRouter({ exa, parallel, exaConfigured: true, parallelConfigured: true, billingPolicy: "allow-configured-metered" });
		expect(meteredRoute({ query: "q", providerHint: "exa" }, context("local")).id).toBe("exa");
		expect(meteredRoute({ query: "q", providerHint: "parallel" }, context("local")).id).toBe("parallel");
	});
});
