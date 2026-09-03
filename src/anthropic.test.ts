import { describe, expect, it } from "bun:test";
import type { ProviderContext } from "./contracts";
import { buildAnthropicRequest, createAnthropicProvider, normalizeAnthropicResponse } from "./anthropic";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function context(): ProviderContext {
	const model = { id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" } as const;
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
			content: [{ type: "web_search_tool_result", tool_use_id: "srv-1", content: { type: "web_search_tool_error", error_code: "too_many_requests" } }],
		};
		expect(() => normalizeAnthropicResponse(errored, { query: "q" })).toThrow(/too_many_requests/);
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
});
