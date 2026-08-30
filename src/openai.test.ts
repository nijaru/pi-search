import { describe, expect, it } from "bun:test";
import type { ProviderContext, SearchRequest } from "./contracts";
import { buildOpenAIRequest, createOpenAIProvider, normalizeOpenAIResponse, type OpenAIFetch } from "./openai";

function model(provider: "openai" = "openai", api = "openai-responses") {
	return {
		id: "gpt-5.4",
		provider,
		api,
		baseUrl: "https://api.openai.com/v1",
	};
}

function context(provider: "openai" = "openai", apiKey = "test-key"): ProviderContext {
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
	usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
	output: [
		{
			type: "message",
			content: [
				{
					type: "output_text",
					text: "TypeScript's latest release is documented here.",
					annotations: [
						{ type: "url_citation", url: "https://typescriptlang.org/docs?utm_source=openai", title: "TypeScript docs", start_index: 0, end_index: 42 },
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
		expect(result).toMatchObject({ query: request.query, provider: "openai", requestId: "resp-123", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, billedUnits: 30, billedUnit: "tokens" } });
		expect(result.answer).toMatchObject({
			text: "TypeScript's latest release is documented here.",
			contentTrust: "untrusted",
			citations: [{ url: "https://typescriptlang.org/docs", title: "TypeScript docs", startIndex: 0, endIndex: 42 }],
		});
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

	it("omits null header overrides instead of sending literal null", async () => {
		let seenHeaders: Headers | undefined;
		const provider = createOpenAIProvider({
			provider: "openai",
			endpoint: "https://example.test/v1/responses",
			fetchImpl: (async (_input, init) => {
				seenHeaders = new Headers(init?.headers);
				return response(payload);
			}) as OpenAIFetch,
		});

		await provider.search(request, new AbortController().signal, {
			model: { ...model(), headers: { "x-disabled": "model-value" } },
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-disabled": null, "x-auth": "yes" } }),
			},
		});

		expect(seenHeaders?.get("x-disabled")).toBeNull();
		expect(seenHeaders?.get("x-auth")).toBe("yes");
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

	it("selects an authenticated registry model when another provider is active", async () => {
		let authenticatedModel = "";
		let body: Record<string, unknown> | undefined;
		const searchModel = { ...model("openai"), id: "gpt-5.5" };
		const provider = createOpenAIProvider({
			provider: "openai",
			endpoint: "https://example.test/v1/responses",
			fetchImpl: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as OpenAIFetch,
		});
		await provider.search({ query: "q" }, new AbortController().signal, {
			model: { id: "deepseek-chat", provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.test" },
			modelRegistry: {
				getModels: () => [searchModel],
				getApiKeyAndHeaders: async (requested) => { authenticatedModel = requested.id; return { ok: true, apiKey: "registry-key" }; },
			},
		});
		expect(authenticatedModel).toBe("gpt-5.5");
		expect(body?.model).toBe("gpt-5.5");
	});

	it("honors an explicitly selected OpenAI execution model", async () => {
		let body: Record<string, unknown> | undefined;
		const selected = { ...model("openai"), id: "gpt-5.5" };
		const provider = createOpenAIProvider({
			provider: "openai",
			endpoint: "https://example.test/v1/responses",
			fetchImpl: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as OpenAIFetch,
		});
		await provider.search({ query: "q", executionModel: "gpt-5.5" }, new AbortController().signal, {
			model: { ...model("openai"), id: "gpt-5.4" },
			modelRegistry: {
				getModels: () => [selected],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "registry-key" }),
			},
		});
		expect(body?.model).toBe("gpt-5.5");
	});

	it("prefers an authenticated Luna model for native search", async () => {
		let authenticatedModel = "";
		let body: Record<string, unknown> | undefined;
		const luna = { ...model("openai"), id: "gpt-5.6-luna" };
		const fallback = { ...model("openai"), id: "gpt-5.5" };
		const provider = createOpenAIProvider({
			provider: "openai",
			endpoint: "https://example.test/v1/responses",
			fetchImpl: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as OpenAIFetch,
		});
		await provider.search({ query: "q" }, new AbortController().signal, {
			model: { ...model("openai"), id: "gpt-5.6-sol" },
			modelRegistry: {
				getModels: () => [fallback, luna],
				getApiKeyAndHeaders: async (requested) => { authenticatedModel = requested.id; return { ok: true, apiKey: "registry-key" }; },
			},
		});
		expect(authenticatedModel).toBe("gpt-5.6-luna");
		expect(body?.model).toBe("gpt-5.6-luna");
	});

	it("falls back during model selection when Luna authentication is unavailable", async () => {
		const attempts: string[] = [];
		let body: Record<string, unknown> | undefined;
		const luna = { ...model("openai"), id: "gpt-5.6-luna" };
		const fallback = { ...model("openai"), id: "gpt-5.5" };
		const provider = createOpenAIProvider({
			provider: "openai",
			endpoint: "https://example.test/v1/responses",
			fetchImpl: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as OpenAIFetch,
		});
		await provider.search({ query: "q" }, new AbortController().signal, {
			model: { ...model("openai"), id: "gpt-5.6-sol" },
			modelRegistry: {
				getModels: () => [fallback, luna],
				getApiKeyAndHeaders: async (requested) => {
					attempts.push(requested.id);
					return requested.id === luna.id ? { ok: false, error: "not configured" } : { ok: true, apiKey: "registry-key" };
				},
			},
		});
		expect(attempts).toEqual(["gpt-5.6-luna", "gpt-5.5"]);
		expect(body?.model).toBe("gpt-5.5");
	});

	it("honors an explicit OpenAI search model, including normally excluded models", async () => {
		let body: Record<string, unknown> | undefined;
		const selected = { ...model("openai"), id: "gpt-5.6-pro" };
		const provider = createOpenAIProvider({
			provider: "openai",
			endpoint: "https://example.test/v1/responses",
			fetchImpl: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as OpenAIFetch,
		});
		await provider.search({ query: "q", executionModel: selected.id }, new AbortController().signal, {
			model: { ...model("openai"), id: "gpt-5.6-sol" },
			modelRegistry: {
				getModels: () => [selected],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "registry-key" }),
			},
		});
		expect(body?.model).toBe(selected.id);
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

	it("rejects a JSON array instead of a Responses envelope", async () => {
		const provider = createOpenAIProvider({ provider: "openai", fetchImpl: (async () => response([])) as OpenAIFetch });
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({ kind: "malformed" });
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

	it("accepts header-only OpenAI auth", async () => {
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

	it("redacts header-only authentication from provider diagnostics", async () => {
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response({ error: { message: "authorization Bearer header-only was rejected" } }, 401)) as OpenAIFetch,
		});
		const headerOnly: ProviderContext = {
			model: model(),
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer header-only" } }) },
		};
		await expect(provider.search({ query: "q" }, new AbortController().signal, headerOnly)).rejects.toMatchObject({
			kind: "auth",
			message: expect.not.stringContaining("header-only"),
		});
	});

	it("sends allowed and blocked domain filters to native search", async () => {
		let body: Record<string, unknown> | undefined;
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as OpenAIFetch,
		});
		await provider.search({ query: "q", domains: { include: ["allowed.example"], exclude: ["blocked.example"] } }, new AbortController().signal, context());
		expect(body?.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["allowed.example"], blocked_domains: ["blocked.example"] } }]);
	});

	it("maps native context, token, location, and content controls into the tool", () => {
		const plan = buildOpenAIRequest({
			query: "q",
			searchContextSize: "high",
			returnTokenBudget: "unlimited",
			externalWebAccess: false,
			userLocation: { type: "approximate", country: "us", city: "Austin" },
			searchContentTypes: ["text", "image"],
			imageSettings: { maxResults: 3, caption: true },
		}, "openai");
		expect(plan.body.tools).toEqual([{
			type: "web_search",
			search_context_size: "high",
			return_token_budget: "unlimited",
			external_web_access: false,
			user_location: { type: "approximate", country: "US", city: "Austin" },
			search_content_types: ["text", "image"],
			image_settings: { maxResults: 3, caption: true },
		}]);
		expect(plan.appliedOptions).toEqual(expect.arrayContaining(["searchContextSize", "returnTokenBudget", "externalWebAccess", "userLocation", "searchContentTypes", "imageSettings"]));
	});

	it("rejects unsupported hard date and social constraints", () => {
		expect(() => buildOpenAIRequest({ query: "q", dateRange: { from: "2026-01-01" } }, "openai")).toThrow(/exact date-range/);
		expect(() => buildOpenAIRequest({ query: "q", social: { includeHandles: ["xai"] } }, "openai")).toThrow(/social\/X/);
	});

	it("cancels a pending error body when the caller aborts", async () => {
		let canceled = false;
		let fetchStartedResolve!: () => void;
		const fetchStarted = new Promise<void>((resolve) => { fetchStartedResolve = resolve; });
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{"));
				closeTimer = setTimeout(() => controller.close(), 200);
			},
			cancel() {
				canceled = true;
				if (closeTimer !== undefined) clearTimeout(closeTimer);
			},
		});
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => {
				fetchStartedResolve();
				return new Response(stream, { status: 503 });
			}) as OpenAIFetch,
		});
		const controller = new AbortController();
		const pending = provider.search({ query: "q" }, controller.signal, context());
		await fetchStarted;
		controller.abort();
		const settled = await Promise.race([
			pending.then(() => true, () => true),
			Bun.sleep(100).then(() => false),
		]);
		expect(settled).toBe(true);
		expect(canceled).toBe(true);
	});

	it("preserves success rate-limit metadata and failure request IDs", async () => {
		const successful = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response(payload, 200, {
				"content-type": "application/json",
				"x-request-id": "header-id",
				"x-ratelimit-limit": "10",
				"x-ratelimit-remaining": "9",
				"x-ratelimit-reset": "60",
			})) as OpenAIFetch,
		});
		const result = await successful.search({ query: "q" }, new AbortController().signal, context());
		expect(result.requestId).toBe("resp-123");
		expect(result.usage?.rateLimits?.windows[0]).toMatchObject({ limit: 10, remaining: 9, resetAfterMs: 60_000 });

		const incomplete = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => response({ status: "incomplete", output: [] }, 200, {
				"content-type": "application/json",
				"x-request-id": "incomplete-id",
				"retry-after": "2",
			})) as OpenAIFetch,
		});
		await expect(incomplete.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({
			kind: "http",
			requestId: "incomplete-id",
			retryAfterMs: 2_000,
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

	it("classifies a broken success stream as a retryable network failure", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				queueMicrotask(() => controller.error(new Error("socket closed")));
			},
		});
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "stream-id" } })) as OpenAIFetch,
		});
		await expect(provider.search({ query: "q" }, new AbortController().signal, context())).rejects.toMatchObject({
			provider: "openai",
			kind: "network",
			retryable: true,
			requestId: "stream-id",
		});
	});

	it("maps stream cancellation to a canceled provider error", async () => {
		let startedResolve!: () => void;
		const started = new Promise<void>((resolve) => { startedResolve = resolve; });
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				startedResolve();
			},
		});
		const provider = createOpenAIProvider({
			provider: "openai",
			fetchImpl: (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as OpenAIFetch,
		});
		const controller = new AbortController();
		const pending = provider.search({ query: "q" }, controller.signal, context());
		await started;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ provider: "openai", kind: "canceled" });
	});

	it("requires a terminal completion event for LF and CRLF streams", async () => {
		const item = { type: "web_search_call", action: { sources: [{ url: "https://example.com", title: "Example" }] } };
		const lf = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}`,
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
