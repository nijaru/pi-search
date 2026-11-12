import { describe, expect, it } from "bun:test";
import type { ProviderContext } from "./contracts";
import { buildXAIRequest, createXAIProvider } from "./xai";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function context(): ProviderContext {
	const model = { id: "grok-4.5", provider: "xai", api: "openai-responses", baseUrl: "https://xai.test/v1" } as const;
	return {
		model,
		modelRegistry: { getModels: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-test" }) },
	};
}

function crossProviderContext(): ProviderContext {
	const model = { id: "grok-4.5", provider: "xai", api: "openai-responses", baseUrl: "https://xai.test/v1" } as const;
	return {
		model: undefined,
		modelRegistry: { getModels: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-test" }) },
	};
}

const payload = {
	id: "xai-1",
	status: "completed",
	citations: ["https://example.com/page"],
	output: [{ type: "message", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation", url: "https://example.org/other", title: "Other" }] }] }],
	usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
};

describe("XAIProvider", () => {
	it("preserves root usage and ids on noncompleted, tool-failed, and unusable responses", async () => {
		for (const tool of ["web_search", "x_search"] as const) {
			for (const failure of [{ status: "incomplete" }, { status: "failed" }, { status: undefined }, { status: "completed", output: [{ type: `${tool}_call`, status: "failed" }] }, { status: "completed", citations: [], output: [] }]) {
				const provider = createXAIProvider({ tool, fetchImpl: async () => response({ ...payload, ...failure, usage: { ...payload.usage, cost_in_usd_ticks: 50_000_000 } }) });
				await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ provider: tool === "x_search" ? "xai-x" : "xai", requestId: "xai-1", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, billedUnits: 20, billedUnit: "tokens", costUsd: 0.005 }, fallbackSafe: false });
			}
		}
	});

	it("retains reported monetary cost without inventing token counts or zero costs", async () => {
		for (const [usage, expected] of [[{ cost_in_usd_ticks: 50_000_000 }, { costUsd: 0.005 }], [{ cost_in_nano_usd: 5_000_000 }, { costUsd: 0.005 }], [undefined, undefined]] as const) {
			const provider = createXAIProvider({ tool: "web_search", fetchImpl: async () => response({ status: "failed", usage }) });
			await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ usage: expected, fallbackSafe: false });
		}
	});

	it("does not advertise combined handle filters", () => {
		expect(createXAIProvider({ tool: "x_search" }).capabilities.combinedHandleFilters).not.toBe(true);
	});

	it("uses xAI web search and normalizes response citations", async () => {
		let seenBody: Record<string, unknown> | undefined;
		let seenHeaders: Headers | undefined;
		const provider = createXAIProvider({ tool: "web_search", endpoint: "https://xai.test/v1", fetchImpl: async (_input, init) => {
			seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			seenHeaders = new Headers(init?.headers);
			return response({ ...payload, id: undefined }, 200, { "content-type": "application/json", "x-request-id": "xai-header" });
		} });
		const result = await provider.search({ query: "latest news", domains: { include: ["example.com"] } }, new AbortController().signal, context());
		expect(seenBody).toMatchObject({ model: "grok-4.5", input: [{ role: "user", content: "latest news" }], tools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }] });
		expect(seenHeaders?.get("authorization")).toBe("Bearer xai-test");
		expect(result).toMatchObject({ provider: "xai", requestId: "xai-header", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, billedUnits: 20, billedUnit: "tokens" } });
		expect(result.results).toHaveLength(2);
		expect(result.answer).toMatchObject({ text: "Answer", contentTrust: "untrusted", citations: [{ url: "https://example.org/other" }] });
	});

	it("drops numeric inline citation labels instead of exposing them as titles", async () => {
		const provider = createXAIProvider({ tool: "x_search", fetchImpl: async () => response({
			...payload,
			output: [{ type: "message", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation", url: "https://example.org/other", title: "2" }] }] }],
		}) });
		const result = await provider.search({ query: "q" }, new AbortController().signal, context());
		expect(result.results[1]?.title).toBeUndefined();
	});

	it("supports explicit X search and rejects web-only domain filters", async () => {
		const provider = createXAIProvider({ tool: "x_search", fetchImpl: async () => response(payload) });
		const result = await provider.search({ query: "what are people saying?" }, new AbortController().signal, context());
		expect(result.provider).toBe("xai-x");
		await expect(provider.search({ query: "q", domains: { include: ["example.com"] } }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "xai-x", kind: "unsupported" });
	});

	it("maps bounded X handles, dates, and media options", () => {
		const plan = buildXAIRequest({ query: "q", dateRange: { from: "2026-01-01", to: "2026-01-02" }, social: { includeHandles: ["@xai"], understandVideos: true } }, "x_search");
		expect(plan.body).toMatchObject({ tools: [{ type: "x_search", allowed_x_handles: ["xai"], from_date: "2026-01-01", to_date: "2026-01-02", enable_video_understanding: true }] });
		expect(plan.appliedOptions).toEqual(expect.arrayContaining(["dateRange", "social"]));
	});

	it("uses an explicitly selected registry xAI model when another model is active", async () => {
		const provider = createXAIProvider({ tool: "x_search", fetchImpl: async () => response(payload) });
		const result = await provider.search({ query: "q", executionModel: "grok-4.5" }, new AbortController().signal, crossProviderContext());
		expect(result.executionModel).toBe("grok-4.5");
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

	it("rejects a completed response with no citation evidence", async () => {
		const provider = createXAIProvider({ tool: "web_search", fetchImpl: async () => response({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Unsearchable answer" }] }] }) });
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "xai", kind: "malformed" });
	});

	it("requires an xAI Responses model", async () => {
		const provider = createXAIProvider({ tool: "web_search", fetchImpl: async () => response(payload) });
		await expect(provider.search({ query: "q" }, new AbortController().signal, { model: { id: "grok-4.3", provider: "xai", api: "openai-completions", baseUrl: "https://xai.test/v1" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-test" }) } })).rejects.toMatchObject({ provider: "xai", kind: "unsupported" });
	});
});
