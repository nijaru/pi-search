import { describe, expect, it } from "bun:test";
import type { ProviderContext } from "./contracts";
import { buildMetaRequest, createMetaProvider, normalizeMetaResponse } from "./meta";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function context(): ProviderContext {
	const model = { id: "muse-spark-1.3", provider: "meta", api: "openai-responses", baseUrl: "https://api.meta.ai/v1" } as const;
	return {
		model,
		modelRegistry: { getModels: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "meta-test" }) },
	};
}

const payload = {
	id: "resp-meta-1",
	status: "completed",
	usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
	output: [
		{
			type: "message",
			content: [
				{
					type: "output_text",
					text: "The latest release is documented here.",
					annotations: [
						{ type: "url_citation", url: "https://example.com/docs", title: "Example docs", start_index: 0, end_index: 10 },
					],
				},
			],
		},
		{
			type: "web_search_call",
			status: "completed",
			action: {
				sources: [
					{ url: "https://example.com/docs", title: "Example docs", snippet: "Release notes." },
				],
			},
		},
	],
};

describe("MetaProvider", () => {
	it("builds a minimal Responses request with the web_search tool", () => {
		const plan = buildMetaRequest({ query: "latest release", maxResults: 3 });
		expect(plan.body).toMatchObject({
			input: [{ role: "user", content: "latest release" }],
			tools: [{ type: "web_search" }],
			store: false,
		});
		expect(plan.appliedOptions).toEqual(["maxResults", "mode"]);
	});

	it("rejects unverified hard controls instead of dropping them", () => {
		expect(() => buildMetaRequest({ query: "q", domains: { include: ["example.com"] } }))
			.toThrow(/domain filters/);
		expect(() => buildMetaRequest({ query: "q", dateRange: { from: "2026-01-01" } }))
			.toThrow(/date/);
		expect(() => buildMetaRequest({ query: "q", searchContextSize: "high" }))
			.toThrow(/context/);
	});

	it("normalizes OpenAI-shaped responses under the meta provider id", () => {
		const result = normalizeMetaResponse(payload, { query: "latest release", maxResults: 3 });
		expect(result).toMatchObject({
			provider: "meta",
			requestId: "resp-meta-1",
			usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
		});
		expect(result.results).toEqual([
			{
				url: "https://example.com/docs",
				title: "Example docs",
				domain: "example.com",
				excerpt: "Release notes.",
				provider: "meta",
				searchQuery: "latest release",
			},
		]);
		expect(result.answer).toMatchObject({ contentTrust: "untrusted", provider: "meta" });
	});

	it("posts to the Responses endpoint with bearer auth", async () => {
		let seenUrl = "";
		let seenHeaders: Headers | undefined;
		let seenBody: Record<string, unknown> | undefined;
		const provider = createMetaProvider({
			fetchImpl: (async (input, init) => {
				seenUrl = String(input);
				seenHeaders = new Headers(init?.headers);
				seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response(payload);
			}) as typeof fetch,
		});
		const result = await provider.search({ query: "latest release" }, new AbortController().signal, context());
		expect(seenUrl).toBe("https://api.meta.ai/v1/responses");
		expect(seenHeaders?.get("authorization")).toBe("Bearer meta-test");
		expect(seenBody).toMatchObject({ model: "muse-spark-1.3", tools: [{ type: "web_search" }] });
		expect(result.executionModel).toBe("muse-spark-1.3");
	});
});
