import { describe, expect, it } from "bun:test";
import type { Provider, SearchRequest, SearchResponse } from "./contracts";
import { SearchToolError } from "./errors";
import { SafeFetchError } from "./fetch-errors";
import { createWebResearchTool, executeResearch, renderResearchResponse, renderResearchResult } from "./research-tool";
import { createSearchRouter } from "./router";
import type { DirectTransport } from "./direct-transport";

function textTransport(content: string): DirectTransport {
	return async () => ({
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": "text/plain" }),
		body: {
			async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(content); },
			cancel() {},
			destroy() {},
		},
	});
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

function context(): never {
	return { model: { provider: "openai", id: "gpt-test", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }) } } as never;
}

function provider(fail = false, estimatedCostUsd?: number, resultUrls = ["https://example.com/1"], responseWarnings: SearchResponse["warnings"] = []): Provider {
	let calls = 0;
	return {
		id: "openai",
		capabilities: { keyword: true, freshness: true },
		profile: { auth: "modelRegistry", costModel: "unknown", ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) },
		search: async (request): Promise<SearchResponse> => {
			calls += 1;
			if (fail) throw new SearchToolError("WEB_SEARCH_RATE_LIMIT", "native rate limit");
			return {
				query: request.query,
				results: [{ url: resultUrls[(calls - 1) % resultUrls.length]!, provider: "openai", searchQuery: request.query }],
				provider: "openai",
				appliedOptions: ["maxResults"],
				warnings: responseWarnings,
			};
		},
	};
}

const budget = { maxSteps: 3, maxProviderCalls: 2, maxFetches: 0, timeoutMs: 5_000, maxOutputChars: 20_000 };

describe("web_research", () => {
	it("runs only caller-supplied queries under one provider and explicit bounds", async () => {
		const result = await executeResearch({ question: "main", queries: ["one", "two"], budget }, () => provider(false, undefined, ["https://example.com/1", "https://example.com/2"]), context());
		expect(result).toMatchObject({ question: "main", providerCalls: 2, stepsCompleted: 2, fetchesCompleted: 0, fetchAttempts: 0, stopReason: "completed" });
		expect(result.results.map((item) => item.searchQuery)).toEqual(["one", "two"]);
	});

	it("enforces the 2000-character runtime query bound without provider-specific schema rewrites", async () => {
		const accepted = await executeResearch({ question: "main", queries: ["q".repeat(2_000)], budget: { ...budget, maxProviderCalls: 1 } }, () => provider(), context());
		expect(accepted.providerCalls).toBe(1);
		for (const queries of [["q".repeat(2_001)], [], "query", Array(9).fill("q")] as const) {
			let selected = false;
			await expect(executeResearch({ question: "main", queries: queries as never, budget }, () => { selected = true; return provider(); }, context())).rejects.toMatchObject({ code: "WEB_RESEARCH_INVALID_REQUEST" });
			expect(selected).toBe(false);
		}
	});

	it("propagates an explicit execution model through every research query", async () => {
		const seenModels: string[] = [];
		const selected: Provider = {
			...provider(),
			id: "gemini",
			search: async (request) => {
				seenModels.push(request.executionModel ?? "missing");
				return {
					query: request.query,
					results: [{ url: "https://example.com/1", provider: "gemini", searchQuery: request.query }],
					provider: "gemini",
					executionModel: request.executionModel,
					usage: { billedUnits: 2, billedUnit: "requests", costUsd: 0.1 },
					appliedOptions: [],
					warnings: [],
				};
			},
		};
		const result = await executeResearch({ question: "main", queries: ["one", "two"], provider: "gemini", executionModel: "gemini-flash-lite-latest", budget }, () => selected, context());
		expect(seenModels).toEqual(["gemini-flash-lite-latest", "gemini-flash-lite-latest"]);
		expect(result.executionModel).toBe("gemini-flash-lite-latest");
		expect(result.usage).toMatchObject({ costUsd: 0.2, billedUnits: 4, billedUnit: "requests" });
	});

	it("returns a bounded partial result on provider failure", async () => {
		const result = await executeResearch({ question: "main", budget }, () => provider(true), context());
		expect(result.stopReason).toBe("provider-error");
		expect(result.providerCalls).toBe(1);
		expect(result.warnings[0]?.message).toContain("rate limit");
	});

	it("continues independent queries after a malformed provider response", async () => {
		let calls = 0;
		const selected: Provider = {
			...provider(),
			search: async (request) => {
				calls += 1;
				if (calls === 2) throw new SearchToolError("WEB_SEARCH_MALFORMED_RESPONSE", "no inspectable sources", { kind: "malformed", provider: "openai" });
				return { query: request.query, results: [{ url: `https://example.com/${calls}`, provider: "openai", searchQuery: request.query }], provider: "openai", appliedOptions: [], warnings: [] };
			},
		};
		const result = await executeResearch({ question: "main", queries: ["one", "two", "three"], budget: { ...budget, maxProviderCalls: 3 } }, () => selected, context());
		expect(result.stopReason).toBe("partial");
		expect(result.providerCalls).toBe(3);
		expect(result.results.map((item) => item.searchQuery)).toEqual(["one", "three"]);
		expect(result.warnings[0]?.message).toContain('query "two"');
	});

	it("fetches retained results after a later search provider failure", async () => {
		let calls = 0;
		const selected: Provider = {
			...provider(),
			search: async (request) => {
				calls += 1;
				if (calls === 2) throw new SearchToolError("WEB_SEARCH_RATE_LIMIT", "later search failed");
				return { query: request.query, results: [{ url: "https://example.com/first", provider: "openai", searchQuery: request.query }], provider: "openai", appliedOptions: [], warnings: [] };
			},
		};
		const result = await executeResearch({ question: "main", queries: ["one", "two"], fetchResults: 1, budget: { ...budget, maxFetches: 1 } }, () => selected, context(), { transport: textTransport("fetched evidence"), lookup: publicLookup });
		expect(result.stopReason).toBe("provider-error");
		expect(result.fetchAttempts).toBe(1);
		expect(result.fetchesCompleted).toBe(1);
		expect(result.fetched[0]?.content).toContain("fetched evidence");
	});

	it("preserves warnings returned by each provider call", async () => {
		const result = await executeResearch({ question: "main", budget }, () => provider(false, undefined, ["https://example.com/1"], [{ code: "unsupported-option", option: "mode", message: "freshness is approximate" }]), context());
		expect(result.warnings).toContainEqual({ code: "unsupported-option", option: "mode", message: "freshness is approximate" });
	});

	it.each([
		{ maxSteps: 0 }, { maxProviderCalls: 0 }, { maxFetches: -1 },
		{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxOutputChars: 0 }, { maxCostUsd: -1 },
	])("rejects invalid budgets before provider selection: %j", async (limits) => {
		let selected = false;
		await expect(executeResearch({ question: "main", budget: { ...budget, ...limits } }, () => { selected = true; return provider(); }, context())).rejects.toMatchObject({ code: "WEB_RESEARCH_BUDGET" });
		expect(selected).toBe(false);
	});

	it("reserves estimated cost before each provider call", async () => {
		const result = await executeResearch({ question: "main", queries: ["one", "two"], budget: { ...budget, maxCostUsd: 1 } }, () => provider(false, 0.6), context());
		expect(result).toMatchObject({ providerCalls: 1, stopReason: "budget", usage: { costUsd: 0.6 } });
	});

	it("retains the cost reservation for malformed potentially billed responses", async () => {
		const selected: Provider = {
			...provider(false, 0.007),
			search: async () => { throw new SearchToolError("WEB_SEARCH_MALFORMED_RESPONSE", "invalid sources", { kind: "malformed" }); },
		};
		const result = await executeResearch({ question: "main", queries: ["one", "two", "three"], budget: { ...budget, maxProviderCalls: 3, maxCostUsd: 0.007 } }, () => selected, context());
		expect(result).toMatchObject({ providerCalls: 1, stopReason: "budget", usage: { costUsd: 0.007 } });
	});

	it("reports a budget stop rather than completion when steps omit planned queries", async () => {
		const result = await executeResearch({ question: "main", queries: ["one", "two"], budget: { ...budget, maxSteps: 1 } }, () => provider(), context());
		expect(result).toMatchObject({ providerCalls: 1, stepsCompleted: 1, stopReason: "budget" });
	});

	it("counts failed fetch attempts and reports partial coverage", async () => {
		const result = await executeResearch({ question: "main", fetchResults: 2, budget: { ...budget, maxFetches: 1 } }, () => provider(false, undefined, ["http://127.0.0.1/blocked", "http://127.0.0.1/blocked-2"]), context());
		expect(result).toMatchObject({ stopReason: "partial", fetchAttempts: 1, fetchesCompleted: 0 });
		expect(result.warnings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("fetch failed") }));
	});

	it("keeps a budget stop when a failed fetch leaves another requested source unfetched", async () => {
		const selected: Provider = { ...provider(), search: async (request) => ({
			query: request.query,
			provider: "openai",
			appliedOptions: [],
			warnings: [],
			results: [1, 2].map(index => ({ url: `http://127.0.0.1/blocked-${index}`, provider: "openai", searchQuery: request.query })),
		}) };
		const result = await executeResearch({ question: "main", fetchResults: 2, budget: { ...budget, maxFetches: 1 } }, () => selected, context());
		expect(result).toMatchObject({ stopReason: "budget", fetchAttempts: 1, fetchesCompleted: 0 });
	});

	it("keeps deadline precedence over a failed requested fetch", async () => {
		const hanging: DirectTransport = (_target, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" })), { once: true });
		});
		const result = await executeResearch({ question: "main", fetchResults: 1, budget: { ...budget, maxFetches: 1, timeoutMs: 100 } }, () => provider(false, undefined, ["https://example.com/1"]), context(), { transport: hanging, lookup: publicLookup });
		expect(result).toMatchObject({ stopReason: "deadline", fetchAttempts: 1, fetchesCompleted: 0 });
	});

	it("keeps cancellation precedence over a failed requested fetch", async () => {
		const hanging: DirectTransport = (_target, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new SafeFetchError({ kind: "canceled", message: "Fetch canceled" })), { once: true });
		});
		const controller = new AbortController();
		const pending = executeResearch({ question: "main", fetchResults: 1, budget: { ...budget, maxFetches: 1 } }, () => provider(false, undefined, ["https://example.com/1"]), context(), { transport: hanging, lookup: publicLookup }, controller.signal);
		await Bun.sleep(10);
		controller.abort();
		expect(await pending).toMatchObject({ stopReason: "canceled", fetchAttempts: 1, fetchesCompleted: 0 });
	});

	it("keeps provider-error precedence over a failed requested fetch", async () => {
		let calls = 0;
		const selected: Provider = {
			...provider(),
			search: async (request) => {
				calls += 1;
				if (calls === 2) throw new SearchToolError("WEB_SEARCH_RATE_LIMIT", "later search failed");
				return { query: request.query, results: [{ url: "http://127.0.0.1/blocked", provider: "openai", searchQuery: request.query }], provider: "openai", appliedOptions: [], warnings: [] };
			},
		};
		const result = await executeResearch({ question: "main", queries: ["one", "two"], fetchResults: 1, budget: { ...budget, maxFetches: 1 } }, () => selected, context());
		expect(result).toMatchObject({ stopReason: "provider-error", fetchAttempts: 1, fetchesCompleted: 0 });
	});

	it("applies normalized domain and date constraints to provider selection and every query", async () => {
		const seen: SearchRequest[] = [];
		const exa: Provider = {
			id: "exa",
			capabilities: { domainFilter: true, dateFilter: true },
			profile: { auth: "environment", costModel: "per-request", estimatedCostUsd: 0.007 },
			search: async (request) => {
				seen.push(request);
				return {
					query: request.query,
					results: [{ url: `https://example.com/${seen.length}`, domain: "example.com", provider: "exa", searchQuery: request.query }],
					provider: "exa",
					appliedOptions: ["maxResults", "domains", "dateRange"],
					warnings: [],
				};
			},
		};
		const route = createSearchRouter({ exa, exaConfigured: true, billingPolicy: "allow-configured-metered" });
		const result = await executeResearch({
			question: "main",
			queries: ["one", "two"],
			domains: { include: ["Example.COM"] },
			dateRange: { from: "2026-01-01", to: "2026-01-02" },
			budget: { ...budget, maxCostUsd: 0.02 },
		}, route, context());
		expect(result.provider).toBe("exa");
		expect(seen).toHaveLength(2);
		for (const request of seen) {
			expect(request).toMatchObject({ domains: { include: ["example.com"] }, dateRange: { from: "2026-01-01", to: "2026-01-02" } });
		}
		expect(result.usage).toMatchObject({ costUsd: 0.014 });
	});

	it("rejects invalid research filters before provider selection", async () => {
		let selected = false;
		for (const filters of [{ domains: { include: ["https://example.com"] } }, { dateRange: { from: "2026-02-30" } }]) {
			await expect(executeResearch({ question: "main", ...filters, budget }, () => { selected = true; return provider(); }, context())).rejects.toMatchObject({ code: "WEB_RESEARCH_INVALID_REQUEST" });
		}
		expect(selected).toBe(false);
	});

	it("rejects hard research filters the selected route cannot enforce", async () => {
		const brave: Provider = { id: "brave", capabilities: { domainFilter: true }, profile: { auth: "environment", costModel: "per-request" }, search: async () => { throw new Error("must not dispatch"); } };
		const route = createSearchRouter({ brave, braveConfigured: true, braveFreeCapacityConfigured: true });
		await expect(executeResearch({ question: "main", dateRange: { from: "2026-01-01" }, budget }, route, context())).rejects.toMatchObject({ code: "WEB_RESEARCH_PROVIDER", message: expect.stringContaining("date range") });
	});

	it.each([
		{ fetchResults: 1, maxFetches: 1, maxSteps: 2, attempts: 1, stopReason: "completed" },
		{ fetchResults: 2, maxFetches: 1, maxSteps: 3, attempts: 1, stopReason: "budget" },
		{ fetchResults: 1, maxFetches: 0, maxSteps: 3, attempts: 0, stopReason: "budget" },
		{ fetchResults: 1, maxFetches: 1, maxSteps: 1, attempts: 0, stopReason: "budget" },
		{ fetchResults: 2, maxFetches: 2, maxSteps: 3, attempts: 2, stopReason: "completed" },
		{ fetchResults: 2, maxFetches: 1, maxSteps: 2, attempts: 1, stopReason: "completed", sharedPage: true },
	])("distinguishes requested fetch completion from exhausted limits: %j", async ({ fetchResults, maxFetches, maxSteps, attempts, stopReason, sharedPage }) => {
		const selected: Provider = { ...provider(), search: async (request) => ({
			query: request.query, provider: "openai", appliedOptions: [], warnings: [],
			results: [1, 2].map(index => ({ url: `https://example.com/${index}`, provider: "openai", searchQuery: request.query, ...(sharedPage ? { sourcePageUrl: "https://example.com/page" } : {}) })),
		}) };
		const result = await executeResearch({ question: "main", fetchResults, budget: { ...budget, maxFetches, maxSteps } }, () => selected, context(), { transport: textTransport("evidence"), lookup: publicLookup });
		expect(result).toMatchObject({ stopReason, fetchAttempts: attempts, fetchesCompleted: attempts });
		if (sharedPage) expect(result.fetched[0]?.url).toBe("https://example.com/page");
	});

	it("deduplicates query plans and canonical result URLs without extra calls or fetches", async () => {
		const result = await executeResearch({ question: "main", queries: [" one ", "one", "two"], fetchResults: 2, budget: { ...budget, maxFetches: 2 } }, () => provider(false, undefined, ["https://EXAMPLE.com:443/page#part", "https://example.com/page"]), context(), { transport: textTransport("evidence"), lookup: publicLookup });
		expect(result).toMatchObject({ providerCalls: 2, fetchAttempts: 1, fetchesCompleted: 1, stopReason: "completed" });
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({ url: "https://example.com/page", sourceUrl: "https://EXAMPLE.com:443/page#part", searchQuery: "one" });
	});

	it("emits one warning when fetched content exceeds the research output budget", async () => {
		const result = await executeResearch({ question: "main", fetchResults: 1, budget: { ...budget, maxFetches: 1, maxOutputChars: 1_000 } }, () => provider(false), context(), { transport: textTransport("large evidence ".repeat(200)), lookup: publicLookup });
		expect(result.warnings.filter((item) => item.message.startsWith("Research output was bounded")).length).toBe(1);
	});

	it("keeps long URLs complete for the model and shortens only Pi display", () => {
		const longUrl = `https://example.com/${"a".repeat(3_000)}`;
		const response = {
			question: "main",
			provider: "openai" as const,
			results: [{ url: longUrl, title: "Long source", provider: "openai" as const, searchQuery: "main" }],
			fetched: [{
				url: longUrl,
				title: "Long page",
				content: "Fetched content",
				contentTrust: "untrusted" as const,
				outputFormat: "markdown" as const,
				extraction: "markdown" as const,
				fetchedAt: "2026-01-01T00:00:00.000Z",
				status: 200,
				redirectCount: 0,
				bytesRead: 15,
				truncated: false,
				offset: 0,
				warnings: [],
			}],
			stepsCompleted: 1,
			providerCalls: 1,
			fetchesCompleted: 1,
			fetchAttempts: 1,
			stopReason: "completed" as const,
			warnings: [],
		};
		const rendered = renderResearchResponse(response);
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
		const tui = renderResearchResult(response, true, theme);
		expect(rendered).toContain(`URL: ${longUrl}`);
		expect(rendered).toContain("Question: main");
		expect(rendered).toContain("Search evidence:");
		expect(rendered).not.toContain('"results"');
		expect(rendered).not.toContain("[URL shortened");
		expect(tui).toContain("Long page ·");
		expect(tui).toContain("[URL shortened]");
	});

	it("strips terminal controls from fetched research content", () => {
		const rendered = renderResearchResponse({
			question: "q",
			provider: "openai" as const,
			results: [],
			fetched: [{
				url: "https://example.com/",
				title: "page\u001b[2J",
				content: "body\u001b]8;;https://evil.test\u0007x\u001b]8;;\u001b\\",
				contentTrust: "untrusted" as const,
				outputFormat: "text" as const,
				extraction: "plain-text" as const,
				fetchedAt: "2026-01-01T00:00:00.000Z",
				status: 200,
				redirectCount: 0,
				bytesRead: 10,
				truncated: false,
				offset: 0,
				warnings: [],
			}],
			stepsCompleted: 1,
			providerCalls: 1,
			fetchesCompleted: 1,
			fetchAttempts: 1,
			stopReason: "completed" as const,
			warnings: [],
		});
		expect(rendered).not.toContain("\u001b");
	});

	it("trims long excerpts before dropping a source that still fits", async () => {
		const longExcerpt = "e".repeat(4_000);
		const selected: Provider = {
			...provider(),
			search: async (request) => ({
				query: request.query,
				results: [{ url: "https://example.com/1", provider: "openai", searchQuery: request.query, excerpt: longExcerpt }],
				provider: "openai",
				appliedOptions: [],
				warnings: [],
			}),
		};
		const tool = createWebResearchTool(() => selected);
		const result = await tool.execute("call-1", {
			question: "main",
			budget: { ...budget, maxOutputChars: 2_000 },
		}, undefined, undefined, context());
		expect(result.details?.results).toHaveLength(1);
		expect(result.details?.results[0]?.excerpt?.length).toBeLessThan(longExcerpt.length);
		const text = result.content[0];
		if (text.type === "text") {
			expect(text.text).toContain("https://example.com/1");
			expect(new TextEncoder().encode(text.text).byteLength).toBeLessThanOrEqual(2_000);
		}
	});

	it("reports truncation and continuation offsets for fetched sources", () => {
		const rendered = renderResearchResponse({
			question: "main",
			provider: "openai" as const,
			results: [],
			fetched: [{
				url: "https://example.com/",
				content: "short",
				contentTrust: "untrusted" as const,
				outputFormat: "text" as const,
				extraction: "plain-text" as const,
				fetchedAt: "2026-01-01T00:00:00.000Z",
				status: 200,
				redirectCount: 0,
				bytesRead: 5,
				truncated: true,
				offset: 0,
				nextOffset: 5,
				warnings: [],
			}],
			stepsCompleted: 1,
			providerCalls: 1,
			fetchesCompleted: 1,
			fetchAttempts: 1,
			stopReason: "completed" as const,
			warnings: [],
		});
		expect(rendered).toContain("content truncated; continue at offset 5");
	});

	it("keeps the complete model-visible research result within its budget", async () => {
		const tool = createWebResearchTool(() => provider());
		const result = await tool.execute("call-1", { question: "q".repeat(2_000), budget: { ...budget, maxOutputChars: 1_000 } }, undefined, undefined, context());
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") expect(new TextEncoder().encode(text.text).byteLength).toBeLessThanOrEqual(1_000);
		expect(new TextEncoder().encode(JSON.stringify(result.details, null, 2)).byteLength).toBeLessThanOrEqual(256_000);
	});

	it("rejects a cost ceiling when the selected provider has no estimate", async () => {
		await expect(executeResearch({ question: "main", budget: { ...budget, maxCostUsd: 0 } }, () => provider(), context())).rejects.toMatchObject({ code: "WEB_RESEARCH_BUDGET" });
	});
});
