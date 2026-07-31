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
	it("normalizes citations and sources as inspectable evidence", () => {
		const result = normalizeOpenAIResponse(payload, request, "openai");
		expect(result).toMatchObject({ query: request.query, provider: "openai", requestId: "resp-123" });
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
			appliedOptions: ["maxResults", "mode", "domains"],
			warnings: [],
		});
	});

	it("selects an authenticated same-provider search model", async () => {
		let authenticatedModel = "";
		let body: Record<string, unknown> | undefined;
		const token = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-search" } }))}.signature`;
		const active = { ...model("openai-codex"), id: "gpt-5.6-sol" };
		const searchModel = { ...model("openai-codex"), id: "gpt-5.5" };
		const provider = createOpenAIProvider({
			provider: "openai-codex",
			endpoint: "https://example.test/backend-api",
			fetchImpl: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as OpenAIFetch,
		});
		await provider.search({ query: "q" }, new AbortController().signal, {
			model: active,
			modelRegistry: {
				getModels: () => [
					{ ...searchModel, id: "gpt-5.6-pro" },
					searchModel,
				],
				getApiKeyAndHeaders: async (requested) => {
					authenticatedModel = requested.id;
					return { ok: true, apiKey: token };
				},
			},
		});
		expect(authenticatedModel).toBe("gpt-5.5");
		expect(body?.model).toBe("gpt-5.5");
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
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				expect(body.max_output_tokens).toBeUndefined();
				return response(events, 200, { "content-type": "text/event-stream" });
			}) as OpenAIFetch,
		});

		const result = await provider.search({ query: "q" }, new AbortController().signal, context("openai-codex", token));
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

	it("rejects completed responses with no inspectable sources", async () => {
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response({ status: "completed", output: [{ type: "message", content: [] }] })) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({
			provider: "openai",
			kind: "malformed",
			message: expect.stringContaining("no inspectable HTTP sources"),
		});
	});

	it("accepts header-only OpenAI auth while still requiring a Codex token", async () => {
		let calls = 0;
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async (_input, init) => {
				calls += 1;
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer header-only");
				return response(payload);
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
	});

	it("maps auth, rate-limit, and transient HTTP failures with retry metadata", async () => {
		for (const [status, kind] of [[401, "auth"], [429, "rateLimit"], [503, "http"]] as const) {
			const provider = createOpenAIProvider({
				provider: "openai",
				fetchImpl: (async () => response({ error: "not exposed" }, status, {
					"content-type": "application/json",
					"x-request-id": "req-1",
					"retry-after": "2",
				})) as OpenAIFetch,
			});
			await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({
				provider: "openai",
				kind,
				status,
				requestId: "req-1",
				retryAfterMs: 2_000,
			});
		}
	});

	it("includes bounded provider diagnostics for HTTP failures", async () => {
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response({ error: { type: "invalid_request_error", code: "unsupported_model", message: "model is not enabled" } }, 400)) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({
			kind: "badRequest",
			message: expect.stringContaining("unsupported_model: invalid_request_error: model is not enabled"),
		});
	});

	it("cancels non-success response bodies before reporting HTTP failures", async () => {
		let failedResponse: Response | undefined;
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => {
				const failure = response({ error: "not exposed" }, 401);
				failedResponse = failure;
				return failure;
			}) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ kind: "auth" });
		expect(failedResponse?.bodyUsed).toBe(true);
	});

	it("requires an OpenAI Responses model rather than a completions model", async () => {
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response(payload)) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q" }, new AbortController().signal, {
			model: model("openai", "openai-completions"),
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		})).rejects.toMatchObject({ provider: "openai", kind: "unsupported" });
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

	it("requires a terminal completion event for LF and CRLF streams", async () => {
		const item = { type: "web_search_call", action: { sources: [{ url: "https://example.com", title: "Example" }] } };
		const lf = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}`,
		].join("\n\n");
		const crlf = lf.replaceAll("\n", "\r\n");
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async (_input, init) => response(String(init?.body).includes("crlf-marker") ? crlf : lf, 200, { "content-type": "text/event-stream" })) as OpenAIFetch,
		});
		const [first, second] = await Promise.all([
			provider.search({ query: "q" }, new AbortController().signal, context()),
			provider.search({ query: "crlf-marker" }, new AbortController().signal, context()),
		]);
		expect(first.results).toHaveLength(1);
		expect(second.results).toHaveLength(1);
	});

	it("rejects a stream that ends before completion", async () => {
		const item = { type: "web_search_call", action: { sources: [{ url: "https://example.com" }] } };
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response(`data: ${JSON.stringify({ type: "response.output_item.done", item })}`, 200, { "content-type": "text/event-stream" })) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ provider: "openai", kind: "malformed", retryable: true });
	});
});
