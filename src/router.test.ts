import { describe, expect, it } from "bun:test";
import type { Provider, SearchResponse } from "./contracts";
import { createSearchRouter } from "./router";

function provider(id: Provider["id"], capabilities: Provider["capabilities"] = {}): Provider {
	const response: SearchResponse = {
		query: "q",
		results: [],
		provider: id,
		appliedOptions: [],
		warnings: [],
	};
	return {
		id,
		capabilities,
		profile: { auth: "none", costModel: id === "exa" ? "usage-based" : "free" },
		search: async () => response,
	};
}

function context(providerName?: string): never {
	return { model: providerName === undefined ? undefined : { provider: providerName, id: "test", api: "test", baseUrl: "https://example.test" } } as never;
}

describe("search provider router", () => {
	const nativeOpenAI = provider("openai", { keyword: true });
	const nativeCodex = provider("openai-codex", { keyword: true });
	const brave = provider("brave", { keyword: true, freshness: true, domainFilter: true });
	const exa = provider("exa", { semantic: true, keyword: true, domainFilter: true, dateFilter: true });

	it("keeps native OpenAI/Codex selection strict and first", () => {
		const route = createSearchRouter({ openai: nativeOpenAI, openaiCodex: nativeCodex, brave, exa, braveConfigured: true, braveFreeCapacityConfigured: true, exaConfigured: true });
		expect(route({ query: "q", mode: "semantic" }, context("openai")).id).toBe("openai");
		expect(route({ query: "q", publishedAfter: "2025-01-01" }, context("openai")).id).toBe("openai");
		expect(route({ query: "q" }, context("openai-codex")).id).toBe("openai-codex");
	});

	it("uses configured Brave for free-capacity general search", () => {
		const route = createSearchRouter({ brave, exa, braveConfigured: true, braveFreeCapacityConfigured: true, exaConfigured: true });
		expect(route({ query: "q", mode: "fresh" }, context("anthropic")).id).toBe("brave");
	});

	it("does not select Exa by default or after a known Brave quota exhaustion", () => {
		const routeWithoutBrave = createSearchRouter({ exa, exaConfigured: true });
		expect(() => routeWithoutBrave({ query: "q" }, context("anthropic"))).toThrow(/No free search provider/);
		const capacity = {
			canAttempt: () => false,
			observe: () => {},
			snapshot: () => ({ windows: [{ remaining: 0, resetAfterMs: 1000 }] }),
		};
		const routeWithExaAllowed = createSearchRouter({ brave, exa, braveConfigured: true, exaConfigured: true, braveCapacity: capacity, billingPolicy: "allow-configured-metered" });
		expect(() => routeWithExaAllowed({ query: "q" }, context("anthropic"))).toThrow("Brave quota window is exhausted");
	});

	it("requires explicit metered policy for semantic Exa search", () => {
		const freeRoute = createSearchRouter({ brave, exa, braveConfigured: true, braveFreeCapacityConfigured: true, exaConfigured: true });
		expect(() => freeRoute({ query: "q", mode: "semantic" }, context("anthropic"))).toThrow(/Brave cannot satisfy/);
		const meteredRoute = createSearchRouter({ brave, exa, braveConfigured: true, exaConfigured: true, billingPolicy: "allow-configured-metered" });
		expect(meteredRoute({ query: "q", mode: "semantic" }, context("anthropic")).id).toBe("exa");
	});

	it("honors strict provider hints without hidden fallback", () => {
		const route = createSearchRouter({ brave, exa, braveConfigured: true, braveFreeCapacityConfigured: true, exaConfigured: true, billingPolicy: "free-only" });
		expect(route({ query: "q", providerHint: "brave" }, context("anthropic")).id).toBe("brave");
		expect(() => route({ query: "q", providerHint: "exa" }, context("anthropic"))).toThrow(/metered/);
		expect(() => route({ query: "q", providerHint: "unknown" }, context("anthropic"))).toThrow(/not configured/);
	});
});
