import { describe, expect, it } from "bun:test";
import { buildCodexRequest, CODEX_SEARCH_ENDPOINT, CodexProvider } from "./codex";
import type { ProviderContext } from "./contracts";

function context(token = "test-token"): ProviderContext {
	return {
		model: { provider: "openai-codex", id: "gpt-test", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: token }) },
	};
}

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "x-request-id": "req-codex" } });
}

describe("CodexProvider", () => {
	it("builds the official alpha/search request with supported controls", () => {
		const plan = buildCodexRequest({
			query: "latest OpenAI news",
			maxResults: 4,
			mode: "fresh",
			domains: { include: ["openai.com"], exclude: ["example.com"] },
			searchContextSize: "low",
			userLocation: { type: "approximate", country: "US", city: "San Francisco" },
			searchContentTypes: ["text", "image"],
			imageSettings: { maxResults: 2, caption: true },
			externalWebAccess: true,
		});
		expect(plan.body).toMatchObject({
			input: "latest OpenAI news",
			commands: { search_query: [{ q: "latest OpenAI news", recency: 7, domains: ["openai.com"] }], image_query: [{ q: "latest OpenAI news" }] },
			settings: {
				search_context_size: "low",
				filters: { allowed_domains: ["openai.com"], blocked_domains: ["example.com"] },
				user_location: { type: "approximate", country: "US", city: "San Francisco" },
				image_settings: { max_results: 2, caption: true },
				external_web_access: true,
			},
		});
		expect(plan.appliedOptions).toEqual(expect.arrayContaining(["domains", "searchContextSize", "userLocation", "searchContentTypes", "imageSettings", "externalWebAccess"]));
		expect(plan.warnings.map((warning) => warning.option)).toEqual(["mode"]);
	});

	it("posts to alpha/search, sends Codex account headers, and normalizes cited sources", async () => {
		const payload = { output: "Answer cites turn0search0", results: [{ type: "text_result", ref_id: "turn0search0", url: "https://example.com/news", title: "News", snippet: "An excerpt" }] };
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const tokenPayload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString("base64url");
		const token = `header.${tokenPayload}.signature`;
		const provider = new CodexProvider({ fetchImpl: async (input, init) => { seenUrl = String(input); seenInit = init; return response(payload); } });
		const result = await provider.search({ query: "news", maxResults: 2 }, new AbortController().signal, context(token));
		expect(seenUrl).toBe(`${CODEX_SEARCH_ENDPOINT}`);
		expect(seenInit?.headers).toMatchObject({ authorization: `Bearer ${token}`, "chatgpt-account-id": "acct-123", originator: "pi" });
		expect(JSON.parse(String(seenInit?.body))).toMatchObject({ model: "gpt-test", input: "news", commands: { search_query: [{ q: "news" }] } });
		expect(result).toMatchObject({ provider: "openai-codex", requestId: "req-codex", executionModel: "gpt-test", results: [{ url: "https://example.com/news", sourceId: "turn0search0" }], answer: { citations: [{ url: "https://example.com/news", sourceId: "turn0search0" }] } });
	});

	it("rejects unsupported hard constraints before network access", async () => {
		let calls = 0;
		const provider = new CodexProvider({ fetchImpl: async () => { calls += 1; return response({}); } });
		await expect(provider.search({ query: "q", dateRange: { from: "2025-01-01" } }, new AbortController().signal, context())).rejects.toMatchObject({ kind: "unsupported" });
		expect(calls).toBe(0);
	});
});
