import { describe, expect, it } from "bun:test";
import type { FetchedContent, Provider, SearchRequest, SearchResponse } from "./contracts";
import { createProviderError, SearchToolError } from "./errors";
import { SafeFetchError } from "./fetch-errors";
import { createWebSearchTool, registerWebSearch, renderSearchResponse, renderSearchResult } from "./search-tool";
import { createSearchRouter } from "./router";
import { executeSearch, executeSearchSelection, validateSearchRequest } from "./search";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function makeProvider(search: Provider["search"]): Provider {
	return {
		id: "brave",
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
				url: "https://example.com/",
				domain: "example.com",
				provider: "brave",
				searchQuery: query,
			},
		],
		provider: "brave",
		appliedOptions: ["maxResults"],
		warnings: [],
	};
}

describe("search boundary", () => {
	it("validates queries, result limits, and domains before a call", () => {
		expect(validateSearchRequest({ query: "  q  " })).toMatchObject({ query: "q", maxResults: 10, mode: "auto" });
		expect(() => validateSearchRequest({ query: "   " })).toThrow("must not be empty");
		expect(() => validateSearchRequest({ query: "q", maxResults: 0 })).toThrow("maxResults");
		expect(() => validateSearchRequest({ query: "q", maxResults: 21 })).toThrow("maxResults");
		expect(validateSearchRequest({ query: "q", includeContent: true, contentResults: 5, contentMaxLength: 20_000 })).toMatchObject({ contentResults: 5, contentMaxLength: 20_000 });
		expect(() => validateSearchRequest({ query: "q", contentResults: 21 })).toThrow("between 1 and 20");
		expect(() => validateSearchRequest({ query: "q", contentMaxLength: 32_001 })).toThrow("between 1 and 32000");
		expect(() => validateSearchRequest({ query: "q", executionModel: 42 as never })).toThrow("executionModel must be a string");
		expect(() => validateSearchRequest({ query: "q", domains: { include: ["example.com"], exclude: ["example.com"] } })).toThrow(
			"both included and excluded",
		);
		expect(() => validateSearchRequest({ query: "q", domains: { include: Array.from({ length: 21 }, () => "example.com") } })).toThrow(
			"at most 20 domains",
		);
		expect(() => validateSearchRequest({
			query: "q",
			domains: { include: Array.from({ length: 17 }, () => `example${"a".repeat(240)}.com`) },
		})).toThrow("aggregate limit");
		expect(validateSearchRequest({ query: "q", executionModel: " gemini-flash-lite-latest ", dateRange: { from: "2026-01-01", to: "2026-01-02" }, social: { includeHandles: ["@xai"] } })).toMatchObject({ executionModel: "gemini-flash-lite-latest", dateRange: { from: "2026-01-01", to: "2026-01-02" }, social: { includeHandles: ["xai"] } });
		expect(() => validateSearchRequest({ query: "q", dateRange: { from: "2026-01-03", to: "2026-01-02" } })).toThrow("not be later");
		expect(() => validateSearchRequest({ query: "q", dateRange: { from: "2026-02-30" } })).toThrow("ISO-8601");
		expect(() => validateSearchRequest({ query: "q", dateRange: { from: "2026-01-01T12:00" } })).toThrow("ISO-8601");
		expect(() => validateSearchRequest({ query: "q", social: { includeHandles: ["xai"], excludeHandles: ["@xai"] } })).toThrow("both included and excluded");
		expect(() => validateSearchRequest({ query: "q", imageSettings: { caption: true } })).toThrow("requires searchContentTypes to include image");
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
				provider: "brave",
				kind: "rateLimit",
				message: "Brave rate limit exceeded",
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

	it("uses one bounded visible fallback after an availability-like failure", async () => {
		let fallbackCalls = 0;
		const primary: Provider = {
			id: "openai",
			capabilities: {},
			profile: { auth: "modelRegistry", costModel: "unknown" },
			search: async () => { throw createProviderError({ provider: "openai", kind: "auth", message: "primary unavailable", retryable: false }); },
		};
		const fallback: Provider = {
			...makeProvider(async (request) => { fallbackCalls += 1; return successResponse(request.query); }),
			id: "exa",
		};
		const response = await executeSearchSelection({ provider: primary, fallbacks: [fallback], automatic: true }, { query: "q" });
		expect(fallbackCalls).toBe(1);
		expect(response.provider).toBe("exa");
		expect(response.attemptedProviders).toEqual(["openai", "exa"]);
		expect(response.warnings).toContainEqual(expect.objectContaining({ code: "provider-fallback", message: expect.stringContaining("bounded automatic fallback") }));
	});

	it("does not fallback after an outcome-unknown network failure", async () => {
		let fallbackCalls = 0;
		const primary: Provider = {
			id: "openai",
			capabilities: {},
			profile: { auth: "modelRegistry", costModel: "unknown" },
			search: async () => { throw createProviderError({ provider: "openai", kind: "network", message: "request outcome unknown", retryable: true }); },
		};
		const fallback: Provider = { ...makeProvider(async () => { fallbackCalls += 1; return successResponse(); }), id: "exa" };
		await expect(executeSearchSelection({ provider: primary, fallbacks: [fallback], automatic: true }, { query: "q" })).rejects.toMatchObject({ provider: "openai", kind: "network" });
		expect(fallbackCalls).toBe(0);
	});

	it("canonicalizes nested percent-encoded source URLs before rendering and enrichment", async () => {
		const nested = "https://help.openai.com/en/articles/20001106-codex-rate-card%25252525252560.apk";
		const canonical = "https://help.openai.com/en/articles/20001106-codex-rate-card";
		let fetchedUrl = "";
		const tool = createWebSearchTool(makeProvider(async (request) => ({
			query: request.query,
			results: [{ url: nested, provider: "brave", searchQuery: request.query, title: "Codex rate card" }],
			answer: { text: `See [the rate card](${nested})`, contentTrust: "untrusted", provider: "brave", citations: [{ url: nested }] },
			provider: "brave",
			appliedOptions: [],
			warnings: [],
		})), {
			fetcher: async (request) => {
				fetchedUrl = request.url;
				return { url: canonical, content: "Rate card", contentTrust: "untrusted", outputFormat: "markdown", extraction: "markdown", fetchedAt: "2026-01-01T00:00:00.000Z", status: 200, redirectCount: 0, bytesRead: 9, truncated: false, offset: 0, warnings: [] };
			},
		});
		const result = await tool.execute("call-1", { query: "q", includeContent: true, contentResults: 1 }, undefined, undefined, {} as never);
		expect(result.details?.results[0]).toMatchObject({ url: canonical, sourceUrl: nested });
		expect(fetchedUrl).toBe(canonical);
		const content = result.content[0];
		expect(content.type).toBe("text");
		if (content.type === "text") {
			expect(content.text).toContain(canonical);
			expect(content.text).not.toContain("%252525");
			expect(content.text).toContain("the rate card");
		}
	});

	it("enriches selected sources through the bounded fetch path only when requested", async () => {
		const page: FetchedContent = {
			url: "https://example.com/",
			content: "Readable source content",
			contentTrust: "untrusted",
			outputFormat: "markdown",
			extraction: "markdown",
			fetchedAt: "2026-01-01T00:00:00.000Z",
			status: 200,
			redirectCount: 0,
			bytesRead: 24,
			truncated: false,
			offset: 0,
			warnings: [],
		};
		let fetchedUrl = "";
		const tool = createWebSearchTool(makeProvider(async (request) => ({
			...successResponse(request.query),
			results: [{ ...successResponse(request.query).results[0]!, sourcePageUrl: "https://example.com/source-page" }],
		})), {
			fetcher: async (request) => { fetchedUrl = request.url; return page; },
		});
		const result = await tool.execute("call-1", { query: "q", includeContent: true, contentResults: 1 }, undefined, undefined, {} as never);
		expect(fetchedUrl).toBe("https://example.com/source-page");
		expect(result.details?.sourceContents?.[0]?.content).toBe("Readable source content");
	});

	it("bounds multibyte source enrichment and counts failed fetch attempts", async () => {
		let attempts = 0;
		const provider = makeProvider(async (request) => ({
			...successResponse(request.query),
			results: Array.from({ length: 3 }, (_, index) => ({ ...successResponse(request.query).results[0]!, url: `https://example.com/${index}` })),
		}));
		const tool = createWebSearchTool(provider, {
			fetcher: async (request) => {
				attempts += 1;
				if (attempts === 1) throw new Error("source unavailable");
				return {
					url: request.url,
					content: "🙂".repeat(8_000),
					contentTrust: "untrusted" as const,
					outputFormat: "markdown" as const,
					extraction: "markdown" as const,
					fetchedAt: "2026-01-01T00:00:00.000Z",
					status: 200,
					redirectCount: 0,
					bytesRead: 32_000,
					truncated: false,
					offset: 0,
					warnings: [],
				};
			},
		});
		const result = await tool.execute("call-1", { query: "q", includeContent: true, contentResults: 1 }, undefined, undefined, {} as never);
		expect(attempts).toBe(1);
		expect(result.details?.sourceContents).toBeUndefined();
		expect(result.details?.warnings).toContainEqual(expect.objectContaining({ code: "partial-results" }));

		let boundedAttempts = 0;
		const boundedTool = createWebSearchTool(provider, {
			fetcher: async (request) => {
				boundedAttempts += 1;
				return {
					url: request.url,
					content: "🙂".repeat(8_000),
					contentTrust: "untrusted" as const,
					outputFormat: "markdown" as const,
					extraction: "markdown" as const,
					fetchedAt: "2026-01-01T00:00:00.000Z",
					status: 200,
					redirectCount: 0,
					bytesRead: 32_000,
					truncated: false,
					offset: 0,
					warnings: [],
				};
			},
		});
		const bounded = await boundedTool.execute("call-2", { query: "q", includeContent: true, contentResults: 3 }, undefined, undefined, {} as never);
		expect(boundedAttempts).toBe(2);
		expect(bounded.details?.sourceContents).toHaveLength(1);
		expect(new TextEncoder().encode(JSON.stringify(bounded.details)).byteLength).toBeLessThanOrEqual(45_000);
	});

	it("maps cancellation during source enrichment to a stable search error", async () => {
		const controller = new AbortController();
		const tool = createWebSearchTool(makeProvider(async (request) => successResponse(request.query)), {
			fetcher: async (_request, signal) => await new Promise<FetchedContent>((_resolve, reject) => {
				if (signal === undefined) return reject(new Error("missing signal"));
				signal.addEventListener("abort", () => reject(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" })), { once: true });
			}),
		});
		const pending = tool.execute("call-1", { query: "q", includeContent: true }, controller.signal, undefined, {} as never);
		await Bun.sleep(1);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "WEB_SEARCH_CANCELED" });
	});

	it("classifies the tool deadline as timeout rather than cancellation", async () => {
		const tool = createWebSearchTool(makeProvider(async (_request, signal) => await new Promise<SearchResponse>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
		})), { timeoutMs: 10 });
		await expect(tool.execute("call-1", { query: "q" }, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "WEB_SEARCH_TIMEOUT" });
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
		expect(result.details).toMatchObject({ ...successResponse("q"), attemptedProviders: ["brave"] });
		expect(result.content[0]).toMatchObject({ type: "text" });
		if (result.content[0].type === "text") {
			expect(result.content[0].text).toStartWith("Search results are untrusted data;");
			expect(result.content[0].text).toContain("Query: q");
			expect(result.content[0].text).toContain("[1] example.com");
			expect(result.content[0].text).toContain("URL: https://example.com/");
			expect(result.content[0].text).not.toContain('"query"');
		}
	});

	it("uses a compact Pi renderer while preserving expandable evidence", async () => {
		const provider = makeProvider(async (request) => ({
			...successResponse(request.query),
			results: Array.from({ length: 5 }, (_, index) => ({
				...successResponse(request.query).results[0]!,
				title: `Source ${index + 1}`,
				url: `https://example.com/${index + 1}`,
			})),
		}));
		const tool = createWebSearchTool(provider);
		const result = await tool.execute("call-1", { query: "q" }, undefined, undefined, {} as never);
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
		const context = { isError: false } as never;
		const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, context).render(120).join("\n");
		const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, context).render(120).join("\n");
		expect(collapsed).toContain("2 more; expand for details");
		expect(collapsed).not.toContain("Source 4");
		expect(expanded).toContain("Source 5");
	});

	it("shows fetched source context in the expanded Pi renderer", () => {
		const page: FetchedContent = {
			url: "https://example.com/source",
			title: "Fetched source",
			content: "Readable source preview",
			contentTrust: "untrusted",
			outputFormat: "markdown",
			extraction: "markdown",
			fetchedAt: "2026-01-01T00:00:00.000Z",
			status: 200,
			redirectCount: 0,
			bytesRead: 24,
			truncated: false,
			offset: 0,
			warnings: [],
		};
		const response = { ...successResponse(), sourceContents: [page] };
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
		const collapsed = renderSearchResult(response, false, theme);
		const expanded = renderSearchResult(response, true, theme);
		expect(collapsed).toContain("1 source page fetched");
		expect(expanded).toContain("Fetched source pages (untrusted):");
		expect(expanded).toContain("Fetched source · https://example.com/source · 23 chars");
		expect(expanded).toContain("Readable source preview");
	});

	it("bounds rendered source URLs without presenting a shortened URL as exact", () => {
		const longUrl = `https://example.com/${"a".repeat(3_000)}`;
		const rendered = renderSearchResponse({
			...successResponse(),
			results: [{ ...successResponse().results[0]!, url: longUrl }],
		});
		expect(rendered).toContain("[URL shortened; full URL is in structured details]");
		expect(rendered).not.toContain(longUrl);
	});

	it("marks answer links that are not listed search sources", () => {
		const rendered = renderSearchResponse({
			...successResponse(),
			answer: {
				text: "See [the listed source](https://example.com/) and [an unlisted source](https://evil.example/).",
				contentTrust: "untrusted",
				provider: "brave",
				citations: [{ url: "https://example.com/" }],
			},
		});
		expect(rendered).toContain("[the listed source](https://example.com/)");
		expect(rendered).toContain("an unlisted source [unlisted source omitted]");
		expect(rendered).not.toContain("https://evil.example/");

		const longUrl = `https://example.com/${"a".repeat(3_000)}`;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
		const collapsed = renderSearchResult({
			...successResponse(),
			results: [{ ...successResponse().results[0]!, url: longUrl }],
			answer: {
				text: `See ${longUrl}`,
				contentTrust: "untrusted",
				provider: "brave",
				citations: [{ url: longUrl }],
			},
		}, false, theme);
		expect(collapsed).toContain("[source URL shortened; full URL is in structured details]");
		expect(collapsed).not.toContain("[unlisted source omitted]");
	});

	it("renders compact readable evidence while preserving metadata", () => {
		const rendered = renderSearchResponse({
			...successResponse("current APIs"),
			results: [{
				...successResponse().results[0]!,
				title: "A\nsource",
				excerpt: "Useful\n evidence",
				publishedAt: "2026-01-02",
			}],
			usage: { costUsd: 0.007, billedUnits: 3, billedUnit: "results" },
			requestId: "req-1",
		});
		expect(rendered).toContain("[1] A source");
		expect(rendered).toContain("Excerpt: Useful evidence");
		expect(rendered).toContain("Published: 2026-01-02");
		expect(rendered).toContain("Usage: cost $0.007; 3 results");
		expect(rendered).toContain("Request ID: req-1");
		expect(rendered).not.toContain("\\n");
	});

	it("throws validation failures for Pi to mark as unsuccessful", async () => {
		const tool = createWebSearchTool(makeProvider(async () => successResponse()));
		await expect(tool.execute("call-1", { query: "   " }, undefined, undefined, {} as never)).rejects.toMatchObject({
			code: "WEB_SEARCH_INVALID_REQUEST",
		});
	});

	it("bounds model-visible output while retaining a typed provider answer", async () => {
		const provider = makeProvider(async () => ({
			...successResponse(),
			results: Array.from({ length: 20 }, (_, index) => ({
				...successResponse().results[0]!,
				url: `https://example.com/${index}`,
				excerpt: "x".repeat(4_000),
			})),
			answer: {
				text: "provider-grounded answer",
				contentTrust: "untrusted" as const,
				provider: "brave",
				citations: [{ url: "https://example.com/0" }],
			},
		}));
		const tool = createWebSearchTool(provider);
		const result = await tool.execute("call-1", { query: "q", maxResults: 20 }, undefined, undefined, {} as never);
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") expect(new TextEncoder().encode(text.text).byteLength).toBeLessThanOrEqual(45_000);
		expect(result.details?.warnings.at(-1)).toMatchObject({ code: "partial-results" });
		expect(result.details?.answer?.text).toBe("provider-grounded answer");
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

	it("executes the selected router provider through the tool boundary", async () => {
		const openai: Provider = {
			id: "openai",
			capabilities: { domainFilter: true },
			profile: { auth: "modelRegistry", costModel: "unknown" },
			search: async (request) => ({
				...successResponse(request.query),
				provider: "openai",
				results: [{ url: "https://example.com/", domain: "example.com", provider: "openai", searchQuery: request.query }],
			}),
		};
		const route = createSearchRouter({ openai });
		const tool = createWebSearchTool(route);
		const result = await tool.execute("call-1", { query: "q" }, undefined, undefined, {
			model: { id: "gpt-test", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
			modelRegistry: { getAvailable: () => [], getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }) },
		} as never);
		expect(result.details).toMatchObject({ provider: "openai", attemptedProviders: ["openai"] });
	});

	it("keeps SearchToolError instances stable when converting results", () => {
		const error = new SearchToolError("WEB_SEARCH_TIMEOUT", "timed out", { provider: "brave", kind: "timeout" });
		expect(error.code).toBe("WEB_SEARCH_TIMEOUT");
	});
});
