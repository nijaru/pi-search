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

function context(providerName?: string): never {
	return { model: providerName === undefined ? undefined : { provider: providerName, id: "test", api: "test", baseUrl: "https://example.test" } } as never;
}

describe("search provider router", () => {
	const nativeOpenAI = provider("openai", { keyword: true, freshness: true, domainFilter: true });
	const nativeCodex = provider("openai-codex", { keyword: true, freshness: true, domainFilter: true });
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
		expect(() => route({ query: "q", providerHint: "native" }, context("anthropic"))).toThrow(/active OpenAI/);
		expect(() => route({ query: "q", providerHint: "unknown" }, context("anthropic"))).toThrow(/not configured/);
	});
});
