import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAuthResult, ProviderContext } from "./contracts";
import { buildAnthropicRequest, createAnthropicProvider, normalizeAnthropicResponse } from "./anthropic";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function context(): ProviderContext {
	const model = { id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } as const;
	return {
		model,
		modelRegistry: { getModels: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "anthropic-test" }) },
	};
}

const payload = {
	id: "msg-1",
	type: "message",
	role: "assistant",
	stop_reason: "end_turn",
	content: [
		{ type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "latest news" } },
		{
			type: "web_search_tool_result",
			tool_use_id: "srv-1",
			content: [
				{ type: "web_search_result", title: "Example", url: "https://example.com/page" },
				{ type: "web_search_result", title: "Other", url: "https://example.org/other" },
			],
		},
		{
			type: "text",
			text: "Latest news summary.",
			citations: [{ type: "citations", cited_text: "news", url: "https://example.com/page", title: "Example" }],
		},
	],
	usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
};

describe("AnthropicProvider", () => {
	it("builds a Messages request with domain and location controls", () => {
		const plan = buildAnthropicRequest({
			query: "q",
			maxResults: 4,
			domains: { include: ["example.com"] },
			userLocation: { type: "approximate", country: "US", city: "Austin" },
		});
		expect(plan.body).toMatchObject({
			max_tokens: 2_048,
			messages: [{ role: "user", content: "q" }],
			tools: [{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 4,
				allowed_domains: ["example.com"],
				user_location: { type: "approximate", country: "US", city: "Austin" },
			}],
		});
		expect(plan.appliedOptions).toContain("domains");
		expect(plan.appliedOptions).toContain("userLocation");
	});

	it("rejects allowed and blocked domains together", () => {
		expect(() => buildAnthropicRequest({ query: "q", domains: { include: ["a.com"], exclude: ["b.com"] } }))
			.toThrow(/allowed or blocked/);
	});

	it("rejects date ranges and social constraints", () => {
		expect(() => buildAnthropicRequest({ query: "q", dateRange: { from: "2026-01-01" } }))
			.toThrow(/date-range/);
		expect(() => buildAnthropicRequest({ query: "q", social: { includeHandles: ["xai"] } }))
			.toThrow(/social/);
	});

	it("normalizes tool results and text citations as evidence", () => {
		const result = normalizeAnthropicResponse(payload, { query: "latest news", maxResults: 5 });
		expect(result).toMatchObject({
			provider: "anthropic",
			requestId: "msg-1",
			usage: { inputTokens: 100, outputTokens: 50, searchQueries: 1 },
		});
		expect(result.results.map((item) => item.url)).toEqual(["https://example.com/page", "https://example.org/other"]);
		expect(result.answer).toMatchObject({
			text: "Latest news summary.",
			contentTrust: "untrusted",
			citations: [{ url: "https://example.com/page", title: "Example" }],
		});
	});

	it("surfaces tool result errors instead of empty evidence", () => {
		const errored = {
			...payload,
			content: [{ type: "web_search_tool_result", tool_use_id: "srv-1", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }],
		};
		expect(() => normalizeAnthropicResponse(errored, { query: "q" })).toThrow(/too_many_requests/);
	});

	it("maps retryable error codes and paused turns to fallback-eligible failures", () => {
		const unavailable = {
			...payload,
			content: [{ type: "web_search_tool_result", tool_use_id: "srv-1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }],
		};
		try {
			normalizeAnthropicResponse(unavailable, { query: "q" });
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({ kind: "unavailable", retryable: true });
		}
		const paused = { ...payload, stop_reason: "pause_turn", content: [] };
		try {
			normalizeAnthropicResponse(paused, { query: "q" });
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({ kind: "unavailable", retryable: true });
		}
	});

	it("sends x-api-key auth without a bearer header", async () => {
		let seenHeaders: Headers | undefined;
		let seenBody: Record<string, unknown> | undefined;
		const provider = createAnthropicProvider({
			endpoint: "https://anthropic.test/v1/messages",
			fetchImpl: (async (_input, init) => {
				seenHeaders = new Headers(init?.headers);
				seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as typeof fetch,
		});
		const result = await provider.search({ query: "latest news" }, new AbortController().signal, context());
		expect(seenHeaders?.get("x-api-key")).toBe("anthropic-test");
		expect(seenHeaders?.get("anthropic-version")).toBe("2023-06-01");
		expect(seenHeaders?.get("authorization")).toBeNull();
		expect(seenBody).toMatchObject({ model: "claude-opus-5" });
		expect(result.executionModel).toBe("claude-opus-5");
		expect(result.appliedOptions).toContain("maxResults");
	});

	it("accepts registry-owned bearer authentication without an API key", async () => {
		let headers: Headers | undefined;
		const provider = createAnthropicProvider({ fetchImpl: async (input, init) => {
			expect(String(input)).toBe("https://api.anthropic.com/v1/messages");
			headers = new Headers(init?.headers);
			return response(payload);
		} });
		const original = context();
		await provider.search({ query: "q" }, new AbortController().signal, {
			...original,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer registry-token" } }) },
		});
		expect(headers?.get("authorization")).toBe("Bearer registry-token");
		expect(headers?.get("x-api-key")).toBeNull();
	});

	it("exchanges registry federation identity through the official protocol and reuses its token", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-search-identity-"));
		const path = join(directory, "identity");
		await writeFile(path, "projected-identity\n");
		let exchanges = 0;
		let searches = 0;
		let rejectNextSearch = false;
		const controller = new AbortController();
		const provider = createAnthropicProvider({ fetchImpl: async (input, init) => {
			if (String(input).endsWith("/oauth/token")) {
				exchanges += 1;
				expect(String(input)).toBe("https://anthropic-proxy.test/v1/oauth/token");
				expect(init?.signal).toBe(controller.signal);
				expect(init?.redirect).toBe("error");
				expect(JSON.parse(String(init?.body))).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "projected-identity", federation_rule_id: "rule", organization_id: "org", service_account_id: "account", workspace_id: "workspace" });
				return response({ access_token: "federated-access", expires_in: 3600, token_type: "Bearer" });
			}
			searches += 1;
			if (rejectNextSearch) {
				rejectNextSearch = false;
				return response({}, 401);
			}
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer federated-access");
			expect(headers.get("x-api-key")).toBeNull();
			expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
			return response(payload);
		} });
		const env = { ANTHROPIC_FEDERATION_RULE_ID: "rule", ANTHROPIC_ORGANIZATION_ID: "org", ANTHROPIC_IDENTITY_TOKEN_FILE: path, ANTHROPIC_SERVICE_ACCOUNT_ID: "account", ANTHROPIC_WORKSPACE_ID: "workspace" };
		const configured: ProviderContext = { ...context(), modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, baseUrl: "https://anthropic-proxy.test/v1", env }) } };
		try {
			await provider.search({ query: "q" }, controller.signal, configured);
			await provider.search({ query: "q" }, controller.signal, configured);
			expect(exchanges).toBe(1);
			expect(searches).toBe(2);
			rejectNextSearch = true;
			await expect(provider.search({ query: "q" }, controller.signal, configured)).rejects.toMatchObject({ kind: "auth" });
			expect(exchanges).toBe(1); // no hidden retry after the rejected search
			await provider.search({ query: "q" }, controller.signal, configured);
			expect(exchanges).toBe(2);
			expect(searches).toBe(4);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("preserves explicit auth deletion and rejects incomplete federation before I/O", async () => {
		let calls = 0;
		const provider = createAnthropicProvider({ fetchImpl: async () => { calls += 1; return response(payload); } });
		const credentials: ProviderAuthResult[] = [
			{ ok: true as const, apiKey: "derived", headers: { "x-api-key": null } },
			{ ok: true as const, headers: { authorization: null }, env: { ANTHROPIC_FEDERATION_RULE_ID: "rule", ANTHROPIC_ORGANIZATION_ID: "org", ANTHROPIC_IDENTITY_TOKEN_FILE: "/must-not-be-read" } },
			{ ok: true as const, env: { ANTHROPIC_FEDERATION_RULE_ID: "rule" } },
		];
		for (const auth of credentials) {
			await expect(provider.search({ query: "q" }, new AbortController().signal, { ...context(), modelRegistry: { getApiKeyAndHeaders: async () => auth } })).rejects.toMatchObject({ kind: "auth" });
		}
		expect(calls).toBe(0);
	});

	it("cancels a pending federation exchange without issuing a Messages request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-search-identity-"));
		const path = join(directory, "identity");
		await writeFile(path, "projected-identity");
		const controller = new AbortController();
		let calls = 0;
		const provider = createAnthropicProvider({ fetchImpl: async (_input, init) => {
			calls += 1;
			expect(init?.signal).toBe(controller.signal);
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		} });
		try {
			await expect(provider.search({ query: "q" }, controller.signal, { ...context(), modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, env: { ANTHROPIC_FEDERATION_RULE_ID: "rule", ANTHROPIC_ORGANIZATION_ID: "org", ANTHROPIC_IDENTITY_TOKEN_FILE: path } }) } })).rejects.toMatchObject({ kind: "canceled" });
			expect(calls).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects unsupported subscription request identities before dispatch", async () => {
		let calls = 0;
		const provider = createAnthropicProvider({ fetchImpl: async () => { calls += 1; return response(payload); } });
		const credentials: ProviderAuthResult[] = [{ ok: true, apiKey: "sk-ant-oat-test" }, { ok: true, headers: { Authorization: "Bearer sk-ant-oat-test" } }];
		for (const auth of credentials) {
			await expect(provider.search({ query: "q" }, new AbortController().signal, { ...context(), modelRegistry: { getApiKeyAndHeaders: async () => auth } })).rejects.toMatchObject({ kind: "unsupported" });
		}
		expect(calls).toBe(0);
	});

	it("lets an explicit x-api-key win over the derived key", async () => {
		let seenHeaders: Headers | undefined;
		const provider = createAnthropicProvider({
			endpoint: "https://anthropic.test/v1/messages",
			fetchImpl: (async (_input, init) => {
				seenHeaders = new Headers(init?.headers);
				return response(payload);
			}) as typeof fetch,
		});
		const model = { id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" } as const;
		await provider.search({ query: "latest news" }, new AbortController().signal, {
			model,
			modelRegistry: { getModels: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "derived", headers: { "x-api-key": "explicit" } }) },
		});
		expect(seenHeaders?.get("x-api-key")).toBe("explicit");
	});
});
