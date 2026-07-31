import { describe, expect, it } from "bun:test";
import type { ProviderContext, SearchRequest } from "./contracts";
import { createOpenAIProvider, normalizeOpenAIResponse, type OpenAIFetch } from "./openai";

function model(provider: "openai" | "openai-codex" = "openai", api = provider === "openai" ? "openai-responses" : "openai-codex-responses") {
	return {
		id: provider === "openai" ? "gpt-5.4" : "gpt-5.3-codex",
		provider,
		api,
		baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
	};
}

function context(provider: "openai" | "openai-codex" = "openai", apiKey = "test-key"): ProviderContext {
	return {
		model: model(provider),
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey, headers: { "x-test-auth": "yes" } }),
		},
	};
}

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

const request: SearchRequest = {
	query: "latest TypeScript release",
	maxResults: 2,
	domains: { include: ["typescriptlang.org"] },
	wantAnswer: true,
};

const payload = {
	id: "resp-123",
	status: "completed",
	output: [
		{
			type: "message",
			content: [
				{
					type: "output_text",
					text: "TypeScript's latest release is documented here.",
					annotations: [
						{ type: "url_citation", url: "https://typescriptlang.org/docs?utm_source=openai", title: "TypeScript docs" },
					],
				},
			],
		},
		{
			type: "web_search_call",
			action: {
				sources: [
					{ id: "source-1", url: "https://typescriptlang.org/docs", title: "TypeScript docs", snippet: "Release information." },
					{ url: "https://example.com/ignored" },
				],
			},
		},
	],
};

describe("OpenAIProvider", () => {
	it("normalizes citations and sources without exposing an answer by default", () => {
		const result = normalizeOpenAIResponse(payload, { ...request, wantAnswer: false }, "openai");
		expect(result).toMatchObject({ query: request.query, provider: "openai", requestId: "resp-123" });
		expect(result.answer).toBeUndefined();
		expect(result.results).toEqual([
			{
				url: "https://typescriptlang.org/docs",
				sourceUrl: "https://typescriptlang.org/docs?utm_source=openai",
				title: "TypeScript docs",
				domain: "typescriptlang.org",
				excerpt: "Release information.",
				provider: "openai",
				searchQuery: request.query,
				sourceId: "source-1",
			},
			{
				url: "https://example.com/ignored",
				domain: "example.com",
				provider: "openai",
				searchQuery: request.query,
			},
		]);
	});

	it("requests native search through the active model registry", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const provider = createOpenAIProvider({
			provider: "openai",
			endpoint: "https://example.test/v1/responses",
			fetchImpl: (async (input, init) => {
				seenUrl = String(input);
				seenInit = init;
				return response(payload);
			}) as OpenAIFetch,
		});

		const result = await provider.search(request, new AbortController().signal, context());
		const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
		expect(seenUrl).toBe("https://example.test/v1/responses");
		const requestHeaders = new Headers(seenInit?.headers);
		expect(requestHeaders.get("authorization")).toBe("Bearer test-key");
		expect(requestHeaders.get("x-test-auth")).toBe("yes");
		expect(body).toMatchObject({ model: "gpt-5.4", stream: true, tool_choice: "required", store: false });
		expect(body.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["typescriptlang.org"] } }]);
		expect(result).toMatchObject({
		provider: "openai",
		requestId: "resp-123",
		answer: "TypeScript's latest release is documented here.",
		appliedOptions: ["maxResults", "mode", "domains", "wantAnswer"],
		warnings: [],
	});
	});

	it("parses the Codex SSE protocol and adds its account headers", async () => {
		const token = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }))}.signature`;
		const events = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: payload.output[0] })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "codex-resp", status: "completed", output: payload.output } })}`,
		].join("\n\n");
		const provider = createOpenAIProvider({
			provider: "openai-codex",
			fetchImpl: (async (_input, init) => {
				const requestHeaders = new Headers(init?.headers);
				expect(requestHeaders.get("authorization")).toBe(`Bearer ${token}`);
				expect(requestHeaders.get("chatgpt-account-id")).toBe("acct-1");
				expect(requestHeaders.get("originator")).toBe("pi");
				expect(requestHeaders.get("openai-beta")).toBe("responses=experimental");
				return response(events, 200, { "content-type": "text/event-stream" });
			}) as OpenAIFetch,
		});

		const result = await provider.search({ query: "q", wantAnswer: true }, new AbortController().signal, context("openai-codex", token));
		expect(result.provider).toBe("openai-codex");
		expect(result.requestId).toBe("codex-resp");
	});

	it("rejects failed native search calls and non-completed responses", async () => {
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response({
				status: "completed",
				output: [{ type: "web_search_call", status: "failed", action: { sources: [] } }],
			})) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ kind: "http" });

		const incompleteProvider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response({ status: "cancelled", output: [] })) as OpenAIFetch,
		});
		await expect(incompleteProvider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ kind: "http" });
	});

	it("accepts header-only OpenAI auth while still requiring a Codex token", async () => {
		let calls = 0;
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async (_input, init) => {
				calls += 1;
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer header-only");
				return response({ output: [] });
			}) as OpenAIFetch,
		});
		const headerOnly: ProviderContext = {
			model: model(),
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer header-only" } }) },
		};
		await provider.search({ query: "q" }, new AbortController().signal, headerOnly);
		expect(calls).toBe(1);
	});

	it("rejects hard constraints that native search cannot enforce", async () => {
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response(payload)) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q", domains: { exclude: ["example.com"] } }, new AbortController().signal, context())).rejects.toMatchObject({
			provider: "openai",
			kind: "unsupported",
		});
		await expect(provider.search({ query: "q", publishedAfter: "2026-01-01" }, new AbortController().signal, context())).rejects.toMatchObject({
			provider: "openai",
			kind: "unsupported",
		});
	});

	it("maps auth, rate-limit, and transient HTTP failures", async () => {
		for (const [status, kind] of [[401, "auth"], [429, "rateLimit"], [503, "http"]] as const) {
			const provider = createOpenAIProvider({
				provider: "openai",
				fetchImpl: (async () => response({ error: "not exposed" }, status)) as OpenAIFetch,
			});
			await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({
				provider: "openai",
				kind,
				status,
			});
		}
	});

	it("does not use a fallback when active OpenAI auth is unavailable", async () => {
		let calls = 0;
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => {
				calls += 1;
				return response(payload);
			}) as OpenAIFetch,
		});
		const noAuth: ProviderContext = {
			model: model(),
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "not configured" }) },
		};
		await expect(provider.search({ query: "q" }, new AbortController().signal, noAuth)).rejects.toMatchObject({ kind: "auth" });
		expect(calls).toBe(0);
	});
});
