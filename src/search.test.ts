import { describe, expect, it } from "bun:test";
import type { Provider, SearchRequest, SearchResponse } from "./contracts";
import { createProviderError, SearchToolError } from "./errors";
import { createWebSearchTool, registerWebSearch } from "./search-tool";
import { executeSearch, validateSearchRequest } from "./search";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function makeProvider(search: Provider["search"]): Provider {
	return {
		id: "exa",
		capabilities: {},
		profile: { auth: "environment", costModel: "unknown" },
		search,
	};
}

function successResponse(query = "q"): SearchResponse {
	return {
		query,
		results: [
			{
				url: "https://example.com",
				provider: "exa",
				searchQuery: query,
			},
		],
		provider: "exa",
		appliedOptions: ["maxResults"],
		warnings: [],
	};
}

describe("search boundary", () => {
	it("validates queries, result limits, domains, and dates before a call", () => {
		expect(validateSearchRequest({ query: "  q  " })).toMatchObject({ query: "q", maxResults: 10, mode: "auto" });
		expect(() => validateSearchRequest({ query: "   " })).toThrow("must not be empty");
		expect(() => validateSearchRequest({ query: "q", maxResults: 0 })).toThrow("maxResults");
		expect(() => validateSearchRequest({ query: "q", maxResults: 101 })).toThrow("maxResults");
		expect(() => validateSearchRequest({ query: "q", domains: { include: ["example.com"], exclude: ["example.com"] } })).toThrow(
			"both included and excluded",
		);
		expect(() => validateSearchRequest({ query: "q", publishedAfter: "not-a-date" })).toThrow("ISO-8601");
	});

	it("propagates caller cancellation as a stable tool error", async () => {
		const provider = makeProvider(
			async (_request, signal) =>
				new Promise<SearchResponse>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const controller = new AbortController();
		const pending = executeSearch(provider, { query: "q" }, { signal: controller.signal, timeoutMs: 1_000 });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "WEB_SEARCH_CANCELED" });
	});

	it("enforces a bounded timeout and aborts the provider signal", async () => {
		let aborted = false;
		const provider = makeProvider(
			async (_request, signal) =>
				new Promise<SearchResponse>((_resolve, _reject) => {
					signal.addEventListener("abort", () => {
						aborted = true;
					}, { once: true });
				}),
		);
		await expect(executeSearch(provider, { query: "q" }, { timeoutMs: 10 })).rejects.toMatchObject({ code: "WEB_SEARCH_TIMEOUT" });
		expect(aborted).toBe(true);
	});

	it("maps provider failures to stable tool-visible codes and bounded diagnostics", async () => {
		const provider = makeProvider(async () => {
			throw createProviderError({
				provider: "exa",
				kind: "rateLimit",
				message: "Exa rate limit exceeded",
				retryable: true,
				status: 429,
				requestId: "request-1",
				retryAfterMs: 1_000,
				rateLimits: { windows: [{ remaining: 0, resetAfterMs: 1_000 }] },
			});
		});
		await expect(executeSearch(provider, { query: "q" })).rejects.toMatchObject({
			code: "WEB_SEARCH_RATE_LIMIT",
			status: 429,
			requestId: "request-1",
			retryAfterMs: 1_000,
			message: expect.stringContaining('"retryAfterMs":1000'),
		});
	});

	it("registers web_search and returns structured evidence", async () => {
		const provider = makeProvider(async (request) => successResponse(request.query));
		const registered: Array<{ name: string }> = [];
		registerWebSearch(
			{
				registerTool(tool: { name: string }) {
					registered.push({ name: tool.name });
				},
			} as unknown as ExtensionAPI,
			provider,
		);
		expect(registered).toEqual([{ name: "web_search" }]);

		const tool = createWebSearchTool(provider);
		const result = await tool.execute("call-1", { query: "q" }, undefined, undefined, {} as never);
		expect((result as { isError?: boolean }).isError).toBeUndefined();
		expect(result.details).toEqual(successResponse("q"));
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it("throws validation failures for Pi to mark as unsuccessful", async () => {
		const tool = createWebSearchTool(makeProvider(async () => successResponse()));
		await expect(tool.execute("call-1", { query: "   " }, undefined, undefined, {} as never)).rejects.toMatchObject({
			code: "WEB_SEARCH_INVALID_REQUEST",
		});
	});

	it("bounds model-visible output while preserving a truncation warning", async () => {
		const provider = makeProvider(async () => ({
			...successResponse(),
			answer: "x".repeat(100_000),
		}));
		const tool = createWebSearchTool(provider);
		const result = await tool.execute("call-1", { query: "q" }, undefined, undefined, {} as never);
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") expect(text.text.length).toBeLessThanOrEqual(45_000);
		expect(result.details?.warnings.at(-1)).toMatchObject({ code: "partial-results" });
	});

	it("selects a provider per active Pi model and passes model auth context", async () => {
		let selected = false;
		let authResult: unknown;
		const provider = makeProvider(async (_request, _signal, context) => {
			selected = context.model?.provider === "openai";
			authResult = context.modelRegistry === undefined
				? undefined
				: await context.modelRegistry.getApiKeyAndHeaders(context.model!);
			return successResponse();
		});
		const tool = createWebSearchTool(() => provider);
		const context = {
			model: {
				id: "gpt-test",
				provider: "openai",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
			},
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			},
		} as never;
		await tool.execute("call-1", { query: "q" }, undefined, undefined, context);
		expect(selected).toBe(true);
		expect(authResult).toEqual({ ok: true, apiKey: "test-key" });
	});

	it("keeps SearchToolError instances stable when converting results", () => {
		const error = new SearchToolError("WEB_SEARCH_TIMEOUT", "timed out", { provider: "exa", kind: "timeout" });
		expect(error.code).toBe("WEB_SEARCH_TIMEOUT");
	});
});
