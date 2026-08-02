import { describe, expect, it } from "bun:test";
import type { ProviderContext } from "./contracts";
import { createGeminiProvider } from "./gemini";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function context(apiKey: string | undefined = "gemini-test"): ProviderContext {
	const model = { id: "gemini-flash-lite-latest", provider: "google", api: "google-generative-ai", baseUrl: "https://gemini.test/v1beta" } as const;
	return {
		model,
		modelRegistry: { getModels: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, ...(apiKey === undefined ? {} : { apiKey }) }) },
	};
}

function crossProviderContext(apiKey: string | undefined = "gemini-test"): ProviderContext {
	const model = { id: "gemini-flash-lite-latest", provider: "google", api: "google-generative-ai", baseUrl: "https://gemini.test/v1beta" } as const;
	return {
		model: undefined,
		modelRegistry: { getModels: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, ...(apiKey === undefined ? {} : { apiKey }) }) },
	};
}

describe("GeminiProvider", () => {
	it("uses native Google Search grounding and returns grounding chunks", async () => {
		let seenBody: Record<string, unknown> | undefined;
		let seenHeaders: Headers | undefined;
		const provider = createGeminiProvider({ endpoint: "https://gemini.test/v1beta" , fetchImpl: async (_input, init) => {
			seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			seenHeaders = new Headers(init?.headers);
			return response({ candidates: [{ content: { parts: [{ text: "Grounded Gemini answer" }] }, groundingMetadata: { webSearchQueries: ["latest TypeScript release"], groundingChunks: [{ web: { uri: "https://example.com/page", title: "Example" } }], groundingSupports: [{ groundingChunkIndices: [0] }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 } }, 200, { "content-type": "application/json", "x-request-id": "gemini-header" });
		} });
		const result = await provider.search({ query: "latest TypeScript release", maxResults: 1 }, new AbortController().signal, context());
		expect(seenBody).toMatchObject({ tools: [{ google_search: {} }], contents: [{ parts: [{ text: "latest TypeScript release" }] }], });
		expect(seenBody).not.toHaveProperty("generationConfig");
		expect(seenHeaders?.get("x-goog-api-key")).toBe("gemini-test");
		expect(seenHeaders?.get("authorization")).toBeNull();
		expect(result).toMatchObject({ provider: "gemini", requestId: "gemini-header", executionModel: "gemini-flash-lite-latest", usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12, searchQueries: 1 } });
		expect(result.results[0]).toMatchObject({ url: "https://example.com/page", title: "Example" });
		expect(result.answer).toMatchObject({ text: "Grounded Gemini answer", contentTrust: "untrusted", citations: [{ url: "https://example.com/page" }] });
	});

	it("uses an explicitly selected registry Gemini model when another model is active", async () => {
		const provider = createGeminiProvider({ fetchImpl: async () => response({ candidates: [{ content: { parts: [{ text: "Cross-provider answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/page" } }], groundingSupports: [{ groundingChunkIndices: [0] }] } }] }) });
		const result = await provider.search({ query: "q", executionModel: "gemini-flash-lite-latest" }, new AbortController().signal, crossProviderContext());
		expect(result.executionModel).toBe("gemini-flash-lite-latest");
	});

	it("does not create an answer when grounding supports do not identify citations", async () => {
		const provider = createGeminiProvider({ fetchImpl: async () => response({ candidates: [{ content: { parts: [{ text: "Uncited answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/page" } }] } }] }) });
		const result = await provider.search({ query: "q" }, new AbortController().signal, context());
		expect(result.answer).toBeUndefined();
	});

	it("rejects a completed response with no grounding evidence", async () => {
		const provider = createGeminiProvider({ fetchImpl: async () => response({ candidates: [{ content: { parts: [{ text: "Unsearchable answer" }] } }] }) });
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "gemini", kind: "malformed" });
	});

	it("rejects domain and date/social constraints because grounding cannot enforce them", async () => {
		const provider = createGeminiProvider({ fetchImpl: async () => response({ candidates: [] }) });
		await expect(provider.search({ query: "q", domains: { exclude: ["example.com"] } }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "gemini", kind: "unsupported" });
		await expect(provider.search({ query: "q", dateRange: { from: "2026-01-01" } }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "gemini", kind: "unsupported" });
	});

	it("reports blocked and truncated grounding responses", async () => {
		const blocked = createGeminiProvider({ fetchImpl: async () => response({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }) });
		await expect(blocked.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "gemini", kind: "http" });
		const truncated = createGeminiProvider({ fetchImpl: async () => response({ candidates: [{ finishReason: "MAX_TOKENS", groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com" } }] } }] }) });
		const result = await truncated.search({ query: "q" }, new AbortController().signal, context());
		expect(result.warnings).toContainEqual(expect.objectContaining({ code: "partial-results" }));
	});

	it("does not call the network when model authentication is unavailable", async () => {
		let calls = 0;
		const provider = createGeminiProvider({ fetchImpl: async () => { calls += 1; return response({ candidates: [] }); } });
		await expect(provider.search({ query: "q" }, new AbortController().signal, context(""))).rejects.toMatchObject({ provider: "gemini", kind: "auth" });
		expect(calls).toBe(0);
	});
});
