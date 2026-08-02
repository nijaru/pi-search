import { describe, expect, it } from "bun:test";
import type { ProviderContext } from "./contracts";
import { createGeminiProvider } from "./gemini";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function context(apiKey: string | undefined = "gemini-test"): ProviderContext {
	return {
		model: { id: "gemini-3-flash", provider: "google", api: "google-generative-ai", baseUrl: "https://gemini.test/v1beta" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, ...(apiKey === undefined ? {} : { apiKey }) }) },
	};
}

describe("GeminiProvider", () => {
	it("uses native Google Search grounding and returns grounding chunks", async () => {
		let seenBody: Record<string, unknown> | undefined;
		let seenHeaders: Headers | undefined;
		const provider = createGeminiProvider({ endpoint: "https://gemini.test/v1beta" , fetchImpl: async (_input, init) => {
			seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			seenHeaders = new Headers(init?.headers);
			return response({ candidates: [{ content: { parts: [{ text: "Grounded Gemini answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/page", title: "Example" } }] } }], usageMetadata: { totalTokenCount: 12 } }, 200, { "content-type": "application/json", "x-request-id": "gemini-header" });
		} });
		const result = await provider.search({ query: "latest TypeScript release", maxResults: 1 }, new AbortController().signal, context());
		expect(seenBody).toMatchObject({ tools: [{ google_search: {} }], contents: [{ parts: [{ text: "latest TypeScript release" }] }] });
		expect(seenHeaders?.get("x-goog-api-key")).toBe("gemini-test");
		expect(result).toMatchObject({ provider: "gemini", requestId: "gemini-header", usage: { billedUnits: 12, billedUnit: "tokens" } });
		expect(result.results[0]).toMatchObject({ url: "https://example.com/page", title: "Example" });
		expect(result.answer).toMatchObject({ text: "Grounded Gemini answer", contentTrust: "untrusted", citations: [{ url: "https://example.com/page" }] });
	});

	it("rejects domain constraints because grounding cannot enforce them", async () => {
		const provider = createGeminiProvider({ fetchImpl: async () => response({ candidates: [] }) });
		await expect(provider.search({ query: "q", domains: { exclude: ["example.com"] } }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "gemini", kind: "unsupported" });
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
