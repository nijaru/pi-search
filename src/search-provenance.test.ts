import { describe, expect, it } from "bun:test";
import type { ProviderContext, ProviderModel } from "./contracts";
import { createAnthropicProvider } from "./anthropic";
import { createBraveProvider } from "./brave";
import { createBraveAnswersProvider } from "./brave-answers";
import { createCloudflareProvider } from "./cloudflare";
import { CodexProvider } from "./codex";
import { createDeepSeekProvider } from "./deepseek";
import { createExaProvider } from "./exa";
import { createGeminiProvider } from "./gemini";
import { createMetaProvider } from "./meta";
import { createOpenAIProvider } from "./openai";
import { createParallelProvider } from "./parallel";
import { createParallelResponsesProvider } from "./parallel-responses";
import { executeSearch } from "./search";
import { createXProvider } from "./x";
import { createXAIProvider } from "./xai";

const url = "https://example.com/page";
const query = "evidence provenance";
const answer = "Generated claim, not page text.";
const fetchJson = (body: unknown) => async () => new Response(JSON.stringify(body), {
	headers: { "content-type": "application/json", "x-request-id": "transport-id" },
});

function context(provider: string, api: string): ProviderContext {
	const model: ProviderModel = { id: "test-model", provider, api, baseUrl: "https://provider.test/v1" };
	return { model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) } };
}

const responsesPayload = {
	status: "completed",
	id: "response-id",
	usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
	output: [
		{ type: "message", content: [{ type: "output_text", text: answer, annotations: [{ type: "url_citation", url, start_index: 0, end_index: 15 }] }] },
		{ type: "web_search_call", status: "completed", action: { sources: [{ url, snippet: "Provider text" }] } },
	],
};

describe("adapter evidence provenance through executeSearch", () => {
	it.each([
		["brave", createBraveProvider({ apiKey: "test", fetchImpl: fetchJson({ web: { results: [{ url, description: "Provider text" }] } }) }), "provider-excerpt"],
		["parallel", createParallelProvider({ apiKey: "test", fetchImpl: fetchJson({ results: [{ url, excerpts: ["Provider text"] }] }) }), "provider-excerpt"],
		["x", createXProvider({ bearerToken: "test", fetchImpl: fetchJson({ data: [{ id: "123", text: "Provider text" }] }) }), "provider-excerpt"],
		["cloudflare", createCloudflareProvider({ accountId: "test", apiToken: "test", upstream: "exa", fetchImpl: fetchJson({ items: [{ url, description: "Provider text" }] }) }), "provider-text"],
	] as const)("preserves %s provenance and source identity", async (_name, provider, excerptKind) => {
		const response = await executeSearch(provider, { query });
		expect(response.results[0]).toMatchObject({ excerpt: "Provider text", excerptKind, provider: provider.id, searchQuery: query });
		expect(response.results[0]?.url).toBe(provider.id === "x" ? "https://x.com/i/web/status/123" : url);
		expect(response.requestId).toBe("transport-id");
		if (provider.id === "cloudflare") expect(response.results[0]?.upstreamProvider).toBe("exa");
	});

	it.each(["deepseek", "exa"] as const)("classifies %s text at the production field, not by provider category", async (id) => {
		const results = id === "deepseek" ? [
			{ url, summary: "Summary", snippet: "Unused snippet" },
			{ url: `${url}/snippet`, summary: " ", snippet: "Snippet" },
			{ url: `${url}/empty` },
		] : [
			{ url, summary: "Summary", highlights: [] },
			{ url: `${url}/snippet`, highlights: ["Snippet"], summary: "Unused summary" },
			{ url: `${url}/empty` },
		];
		const options = { apiKey: "test", fetchImpl: fetchJson({ results }) };
		const provider = id === "deepseek" ? createDeepSeekProvider(options) : createExaProvider(options);
		const response = await executeSearch(provider, { query });
		expect(response.results.map((result) => [result.excerpt, result.excerptKind])).toEqual([
			["Summary", "provider-summary"], ["Snippet", "provider-excerpt"], [undefined, undefined],
		]);
		expect(response.results[2]).not.toHaveProperty("excerpt");
		expect(response.results[2]).not.toHaveProperty("excerptKind");
	});

	it.each(["openai", "meta"] as const)("preserves ambiguous %s source text separately from the aligned model answer", async (id) => {
		const options = { fetchImpl: fetchJson(responsesPayload) };
		const provider = id === "openai" ? createOpenAIProvider({ ...options, provider: "openai" }) : createMetaProvider(options);
		const response = await executeSearch(provider, { query, answerMode: "auto" }, { context: context(id, "openai-responses") });
		expect(response.results[0]).toMatchObject({ url, excerpt: "Provider text", excerptKind: "provider-text" });
		expect(response.answer).toMatchObject({ text: answer, citations: [{ url, startIndex: 0, endIndex: 15 }] });
		expect(response).toMatchObject({ requestId: "response-id", executionModel: "test-model", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
	});

	it.each(["snippet", "text", "description", "caption"])("labels opaque Codex %s as provider text without promoting generated output", async (field) => {
		const provider = new CodexProvider({ fetchImpl: fetchJson({
			output: `${answer} turn0search0 https://example.org/answer-only`,
			results: [{ url, ref_id: "turn0search0", [field]: "Opaque source text" }],
		}) });
		const response = await executeSearch(provider, { query, answerMode: "auto" }, { context: context("openai-codex", "openai-codex-responses") });
		expect(response.results[0]).toMatchObject({ url, excerpt: "Opaque source text", excerptKind: "provider-text", sourceId: "turn0search0" });
		expect(response.results[1]).not.toHaveProperty("excerpt");
		expect(response.results[1]).not.toHaveProperty("excerptKind");
		expect(response.answer?.citations).toContainEqual({ url, sourceId: "turn0search0", ...(field === "caption" ? { title: "Opaque source text" } : {}) });
	});

	it("keeps Anthropic citation/answer text out of source excerpts and preserves source text through merging", async () => {
		const provider = createAnthropicProvider({ fetchImpl: fetchJson({ content: [
			{ type: "text", text: answer, citations: [{ url, cited_text: "Generated cited text" }] },
			{ type: "web_search_tool_result", content: [{ url, encrypted_content: "opaque", snippet: "Provider text" }, { url: `${url}/encrypted`, encrypted_content: "not readable evidence" }] },
		] }) });
		const response = await executeSearch(provider, { query, answerMode: "auto" }, { context: context("anthropic", "anthropic-messages") });
		expect(response.results[0]).toMatchObject({ url, excerpt: "Provider text", excerptKind: "provider-text" });
		expect(response.results[1]).not.toHaveProperty("excerpt");
		expect(response.answer).toMatchObject({ text: answer, citations: [{ url }] });
	});

	it("does not claim Brave answer-tag snippets are fetched or verbatim page content", async () => {
		const tagged = `${answer}<citation>${JSON.stringify({ url, snippet: "Citation text" })}</citation>`;
		const provider = createBraveAnswersProvider({ apiKey: "test", fetchImpl: async () => new Response(
			`data: ${JSON.stringify({ choices: [{ delta: { content: tagged } }] })}\n\ndata: [DONE]\n\n`,
		) });
		const response = await executeSearch(provider, { query, answerMode: "auto" });
		expect(response.results[0]).toMatchObject({ url, excerpt: "Citation text", excerptKind: "provider-text" });
		expect(response.answer).toMatchObject({ text: answer, citations: [{ url }] });
	});

	it.each(["gemini", "xai", "xai-x", "parallel-responses"] as const)("does not turn %s grounding text into a page excerpt", async (id) => {
		let provider;
		let executionContext: ProviderContext = {};
		if (id === "gemini") {
			provider = createGeminiProvider({ fetchImpl: fetchJson({ candidates: [{ content: { parts: [{ text: answer }] }, groundingMetadata: {
				groundingChunks: [{ web: { uri: url } }], groundingSupports: [{ groundingChunkIndices: [0], segment: { text: answer } }],
			} }] }) });
			executionContext = context("google", "google-generative-ai");
		} else if (id === "parallel-responses") {
			provider = createParallelResponsesProvider({ apiKey: "test", fetchImpl: fetchJson(responsesPayload) });
		} else {
			provider = createXAIProvider({ tool: id === "xai-x" ? "x_search" : "web_search", fetchImpl: fetchJson(responsesPayload) });
			executionContext = context("xai", "openai-responses");
		}
		const response = await executeSearch(provider, { query, answerMode: "auto" }, { context: executionContext });
		expect(response.answer).toMatchObject({ text: answer, citations: [{ url }] });
		expect(response.results[0]).toMatchObject({ url });
		expect(response.results[0]).not.toHaveProperty("excerpt");
		expect(response.results[0]).not.toHaveProperty("excerptKind");
	});
});
