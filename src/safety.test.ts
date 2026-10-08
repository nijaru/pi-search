import { expect, test } from "bun:test";
import type { Provider, ProviderContext, SearchResponse } from "./contracts";
import { AnthropicProvider } from "./anthropic";
import { createBraveProvider } from "./brave";
import { createBraveAnswersProvider } from "./brave-answers";
import { CodexProvider } from "./codex";
import { createParallelResponsesProvider } from "./parallel-responses";
import { createWebSearchTool } from "./search-tool";
import { createWebResearchTool } from "./research-tool";
import { createSearchRouter } from "./router";
import { executeSearchSelection } from "./search";

const signal = new AbortController().signal;
const evidence: SearchResponse = {
	query: "q", provider: "exa", appliedOptions: [], warnings: [],
	results: [{ url: "https://example.com/", provider: "exa", searchQuery: "q" }],
};
const adapter = (search: Provider["search"]): Provider => ({
	id: "exa", capabilities: { domainFilter: true }, profile: { auth: "none", costModel: "unknown" }, search,
});
const cited = { choices: [{ delta: { content: 'Answer.<citation>{"url":"https://example.com/"}</citation>' } }] };
const stream = (events: unknown[], done = true) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""));
const json = (value: unknown) => new Response(JSON.stringify(value));
const context: ProviderContext = {
	model: { id: "test", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
};

test("Brave credentials never follow cross-origin redirects", async () => {
	let leaked = false;
	const target = Bun.serve({ port: 0, fetch(request) { leaked ||= request.headers.has("x-subscription-token"); return json({ web: { results: [] } }); } });
	const redirect = Bun.serve({ port: 0, fetch() { return Response.redirect(String(target.url)); } });
	try {
		for (const provider of [createBraveProvider({ apiKey: "dummy", endpoint: String(redirect.url) }), createBraveAnswersProvider({ apiKey: "dummy", endpoint: String(redirect.url) })]) {
			await expect(provider.search({ query: "q" }, signal, {})).rejects.toMatchObject({ kind: "network" });
		}
		expect(leaked).toBe(false);
	} finally { redirect.stop(true); target.stop(true); }
});

test("a pre-aborted search tool never dispatches", async () => {
	let calls = 0;
	const canceled = new AbortController(); canceled.abort();
	const tool = createWebSearchTool(adapter(async () => { calls++; return evidence; }));
	await expect(tool.execute("call", { query: "q" }, canceled.signal, undefined, {} as never)).rejects.toMatchObject({ code: "WEB_SEARCH_CANCELED" });
	expect(calls).toBe(0);
});

test.each(["pause_turn", "too_many_requests", "unavailable"])("Anthropic %s cannot initiate another paid provider", async code => {
	let fallbackCalls = 0;
	const primary = new AnthropicProvider({ fetchImpl: async () => json({ stop_reason: code === "pause_turn" ? code : "end_turn", content: code === "pause_turn" ? [] : [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: code } }], usage: { input_tokens: 10, output_tokens: 2, server_tool_use: { web_search_requests: 1 } } }) });
	const fallback = adapter(async () => { fallbackCalls++; return evidence; });
	await expect(executeSearchSelection({ provider: primary, fallbacks: [fallback], automatic: true }, { query: "q" }, { context })).rejects.toBeInstanceOf(Error);
	expect(fallbackCalls).toBe(0);
	const piContext = { ...context, modelRegistry: { ...context.modelRegistry, getAvailable: () => [] } } as never;
	const search = await createWebSearchTool(primary).execute("call", { query: "q" }, signal, undefined, piContext);
	expect(search).toMatchObject({ isError: true, usage: { input: 10, output: 2, totalTokens: 12 } });
	const research = await createWebResearchTool(() => primary).execute("call", { question: "q", budget: { maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 1000, maxOutputChars: 10000 } }, signal, undefined, piContext);
	expect(research).toMatchObject({ usage: { input: 10, output: 2, totalTokens: 12 } });
});

test("search and research report nested usage to Pi", async () => {
	const provider = adapter(async () => ({ ...evidence, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.1 } }));
	const search = await createWebSearchTool(provider).execute("call", { query: "q" }, signal, undefined, {} as never);
	const research = await createWebResearchTool(() => provider).execute("call", { question: "q", budget: { maxSteps: 2, maxProviderCalls: 2, maxFetches: 0, timeoutMs: 1000, maxOutputChars: 10000 }, queries: ["one", "two"] }, signal, undefined, {} as never);
	expect(search.usage).toMatchObject({ input: 10, output: 2, totalTokens: 12, cost: { total: 0.1 } });
	expect(research.usage).toMatchObject({ input: 20, output: 4, totalTokens: 24, cost: { total: 0.2 } });
});

test("output bounds cover citations and preserve source alignment", async () => {
	const results = Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}/${"a".repeat(7900)}`, provider: "exa" as const, searchQuery: "q", title: "x".repeat(500) }));
	const tool = createWebSearchTool(adapter(async () => ({ ...evidence, results, answer: { text: "Answer", contentTrust: "untrusted", provider: "exa", citations: results.map(({ url, title }) => ({ url, title })) } })));
	const result = await tool.execute("call", { query: "q", maxResults: 20 }, signal, undefined, {} as never);
	expect(Buffer.byteLength(JSON.stringify(result.details, null, 2))).toBeLessThanOrEqual(45000);
	expect(Buffer.byteLength(result.content.map(item => item.type === "text" ? item.text : "").join(""))).toBeLessThanOrEqual(45000);
	const urls = new Set(result.details?.results.map(source => source.url));
	for (const citation of result.details?.answer?.citations ?? []) expect(urls.has(citation.url)).toBe(true);
});

test("Codex accepts header-only auth and preserves explicit account identity", async () => {
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "derived" } })).toString("base64url")}.signature`;
	for (const apiKey of [undefined, token]) {
		const provider = new CodexProvider({ fetchImpl: async (_url, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit");
			expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("explicit-account");
			return json({ output: "See https://example.com/", results: [] });
		} });
		await provider.search({ query: "q" }, signal, { model: { ...context.model!, provider: "openai-codex", api: "openai-codex-responses" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey, headers: { authorization: "Bearer explicit", "chatgpt-account-id": "explicit-account" } }) } });
	}
});

test("automatic routing respects Anthropic's domain-filter combination", () => {
	const exa = adapter(async () => evidence);
	const route = createSearchRouter({ anthropic: new AnthropicProvider(), exa, exaConfigured: true, billingPolicy: "allow-configured-metered" });
	const ctx = { ...context, modelRegistry: { getAvailable: () => [] } } as never;
	expect(route({ query: "q", domains: { include: ["example.com"] } }, ctx).provider.id).toBe("anthropic");
	expect(route({ query: "q", domains: { include: ["example.com"], exclude: ["blocked.example.com"] } }, ctx).provider.id).toBe("exa");
});

test.each(["failed", "incomplete", undefined])("Parallel requires terminal success: %s", async status => {
	const provider = createParallelResponsesProvider({ apiKey: "test", fetchImpl: async () => json({ status, output: [{ type: "message", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation", url: "https://example.com/" }] }] }] }) });
	await expect(provider.search({ query: "q" }, signal, {})).rejects.toBeInstanceOf(Error);
});

test("Brave rejects incomplete and error-bearing streams", async () => {
	for (const response of [stream([cited], false), stream([cited, { error: { message: "failed" } }])]) {
		const provider = createBraveAnswersProvider({ apiKey: "test", fetchImpl: async () => response });
		await expect(provider.search({ query: "q" }, signal, {})).rejects.toBeInstanceOf(Error);
	}
});
