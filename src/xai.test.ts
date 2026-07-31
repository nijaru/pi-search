import { describe, expect, it } from "bun:test";
import type { ProviderContext } from "./contracts";
import { createXAIProvider } from "./xai";

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function context(): ProviderContext {
	return {
		model: { id: "grok-4.5", provider: "xai", api: "openai-responses", baseUrl: "https://xai.test/v1" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-test" }) },
	};
}

const payload = {
	id: "xai-1",
	status: "completed",
	citations: ["https://example.com/page"],
	output: [{ type: "message", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation", url: "https://example.org/other", title: "Other" }] }] }],
	usage: { total_tokens: 20 },
};

describe("XAIProvider", () => {
	it("uses xAI web search and normalizes response citations", async () => {
		let seenBody: Record<string, unknown> | undefined;
		let seenHeaders: Headers | undefined;
		const provider = createXAIProvider({ tool: "web_search", endpoint: "https://xai.test/v1", fetchImpl: async (_input, init) => {
			seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			seenHeaders = new Headers(init?.headers);
			return response(payload);
		} });
		const result = await provider.search({ query: "latest news", domains: { include: ["example.com"] } }, new AbortController().signal, context());
		expect(seenBody).toMatchObject({ model: "grok-4.5", input: "latest news", tools: [{ type: "web_search", allowed_domains: ["example.com"] }] });
		expect(seenHeaders?.get("authorization")).toBe("Bearer xai-test");
		expect(result).toMatchObject({ provider: "xai", requestId: "xai-1", usage: { billedUnits: 20, billedUnit: "tokens" } });
		expect(result.results).toHaveLength(2);
	});

	it("supports explicit X search and rejects web-only domain filters", async () => {
		const provider = createXAIProvider({ tool: "x_search", fetchImpl: async () => response(payload) });
		const result = await provider.search({ query: "what are people saying?" }, new AbortController().signal, context());
		expect(result.provider).toBe("xai-x");
		await expect(provider.search({ query: "q", domains: { include: ["example.com"] } }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "xai-x", kind: "unsupported" });
	});

	it("rejects a failed server-side search call even when the envelope completed", async () => {
		const provider = createXAIProvider({ tool: "web_search", fetchImpl: async () => response({ status: "completed", output: [{ type: "web_search_call", status: "failed" }] }) });
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "xai", kind: "http" });
	});

	it("preserves xai-x as the provider for authentication failures", async () => {
		const provider = createXAIProvider({ tool: "x_search", fetchImpl: async () => response({ status: "completed", output: [] }) });
		const noAuth = { ...context(), modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }) } };
		await expect(provider.search({ query: "q" }, new AbortController().signal, noAuth)).rejects.toMatchObject({ provider: "xai-x", kind: "auth" });
	});

	it("rejects a search call with no terminal status", async () => {
		const provider = createXAIProvider({ tool: "web_search", fetchImpl: async () => response({ status: "completed", output: [{ type: "web_search_call" }] }) });
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "xai", kind: "malformed" });
	});

	it("requires an xAI Responses model", async () => {
		const provider = createXAIProvider({ tool: "web_search", fetchImpl: async () => response(payload) });
		await expect(provider.search({ query: "q" }, new AbortController().signal, { model: { id: "grok-4.3", provider: "xai", api: "openai-completions", baseUrl: "https://xai.test/v1" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-test" }) } })).rejects.toMatchObject({ provider: "xai", kind: "unsupported" });
	});
});
