import { expect, test } from "bun:test";
import type { Provider } from "./contracts";
import { createProviderError } from "./errors";
import { executeSearchPlan } from "./search";
import { createWebSearchTool } from "./search-tool";

function adapter(id: string, search: Provider["search"]): Provider {
	return { id, capabilities: {}, profile: { auth: "none", costModel: "unknown" }, search };
}
const success: Provider["search"] = async request => ({ query: request.query, provider: "deepseek", results: [{ url: "https://example.com/", provider: "deepseek", searchQuery: request.query }], appliedOptions: [], warnings: [] });

test("ordered search advances through multiple safe rejections, returns visible history, and stops after one success", async () => {
	const calls: string[] = [];
	const providers = [
		adapter("openai", async () => { calls.push("openai"); throw createProviderError({ provider: "openai", kind: "auth", status: 401, message: "rejected", retryable: false }); }),
		adapter("exa", async () => { calls.push("exa"); throw createProviderError({ provider: "exa", kind: "rateLimit", status: 429, message: "quota", retryable: true }); }),
		adapter("deepseek", async (...args) => { calls.push("deepseek"); return success(...args); }),
		adapter("brave", async () => { throw new Error("Must stop after success"); }),
	] as const;
	const response = await executeSearchPlan({ providers }, { query: "q" });
	expect(calls).toEqual(["openai", "exa", "deepseek"]);
	expect(response.attemptedProviders).toEqual(calls);
	expect(response.warnings).toContainEqual(expect.objectContaining({ code: "provider-fallback", message: expect.stringContaining("openai") }));
	expect(response.warnings[0]!.message).toContain("exa");
});

test.each(["network", "timeout", "malformed", "canceled", "http", "unknown"] as const)("an ambiguous %s failure never dispatches an alternative, even if incorrectly marked safe", async kind => {
	let alternatives = 0;
	const primary = adapter("openai", async () => { throw createProviderError({ provider: "openai", kind, fallbackSafe: true, message: "uncertain", retryable: true }); });
	const fallback = adapter("exa", async (...args) => { alternatives++; return success(...args); });
	await expect(executeSearchPlan({ providers: [primary, fallback] }, { query: "q" })).rejects.toMatchObject({ kind });
	expect(alternatives).toBe(0);
});

test("provider-reported usage prevents fallback even after an otherwise safe HTTP rejection", async () => {
	let alternatives = 0;
	const primary = adapter("openai", async () => { throw createProviderError({ provider: "openai", kind: "rateLimit", status: 429, message: "reported", usage: { costUsd: 0 }, retryable: true }); });
	const fallback = adapter("exa", async (...args) => { alternatives++; return success(...args); });
	await expect(executeSearchPlan({ providers: [primary, fallback] }, { query: "q" })).rejects.toMatchObject({ usage: { costUsd: 0 } });
	expect(alternatives).toBe(0);
});

test("tool output keeps complete history when the successful provider follows more than four attempts", async () => {
	const ids = ["openai", "exa", "deepseek", "brave", "gemini"];
	const providers = ids.map((id, index) => adapter(id, async request => {
		if (index < ids.length - 1) throw createProviderError({ provider: id, kind: "auth", fallbackSafe: true, message: "rejected", retryable: false });
		return { query: request.query, provider: id, results: [{ url: "https://example.com/", provider: id, searchQuery: request.query }], warnings: [], appliedOptions: [] };
	}));
	const tool = createWebSearchTool(() => ({ providers: [providers[0]!, ...providers.slice(1)] }));
	const result = await tool.execute("call", { query: "q" }, undefined, undefined, {} as never);
	expect(result.details?.attemptedProviders).toEqual(ids);
	expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`Attempted: ${ids.join(" → ")}`) });
});

test("every candidate receives the same absolute search deadline", async () => {
	const deadlines: (number | undefined)[] = [];
	const primary = adapter("openai", async () => { throw new Error("Custom production attempt owns execution here"); });
	const fallback = adapter("deepseek", success);
	const response = await executeSearchPlan({ providers: [primary, fallback] }, { query: "q" }, { timeoutMs: 1000 }, async (provider, request, options) => {
		deadlines.push(options?.deadline);
		if (provider.id === "openai") throw createProviderError({ provider: "openai", kind: "unavailable", fallbackSafe: true, message: "missing", retryable: false });
		return success(request, new AbortController().signal, {});
	});
	expect(response.provider).toBe("deepseek");
	expect(deadlines[0]).toBeNumber();
	expect(deadlines[1]).toBe(deadlines[0]);
});
