import { describe, expect, it } from "bun:test";
import { createExaProvider, normalizeExaResponse, type ExaFetch } from "./exa";
import type { SearchRequest } from "./contracts";

const request: SearchRequest = {
	query: "synth plugin modulation",
	mode: "semantic",
	maxResults: 2,
	domains: { include: ["example.com"], exclude: ["blocked.example"] },
	publishedAfter: "2025-01-01T00:00:00.000Z",
	publishedBefore: "2025-12-31T00:00:00.000Z",
	wantHighlights: true,
};

function response(body: unknown, status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("ExaProvider", () => {
	it("normalizes evidence and applies supported options without requesting an answer", async () => {
		let seenBody: Record<string, unknown> | undefined;
		let seenInit: RequestInit | undefined;
		const provider = createExaProvider({
			apiKey: "test-key",
			fetchImpl: (async (_input, init) => {
				seenInit = init;
				seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response({
					requestId: "req-123",
					costDollars: { total: 0.007 },
					results: [
						{
							id: "source-1",
							url: "https://Example.com/article",
							title: "A synth article",
							publishedDate: "2025-04-02T03:04:05.000Z",
							text: "An evidence excerpt.",
							highlights: ["evidence excerpt"],
							score: 0.75,
						},
						{
							url: "https://example.com/second",
							summary: "A summary excerpt.",
						},
					],
					output: { content: "This must not become an answer" },
				});
			}) as ExaFetch,
		});

		const result = await provider.search(request, new AbortController().signal, {});

		expect(seenBody).toEqual({
			query: "synth plugin modulation",
			numResults: 2,
			type: "neural",
			includeDomains: ["example.com"],
			excludeDomains: ["blocked.example"],
			startPublishedDate: "2025-01-01T00:00:00.000Z",
			endPublishedDate: "2025-12-31T00:00:00.000Z",
			contents: { highlights: true },
		});
		expect(seenInit?.headers).toMatchObject({ "x-api-key": "test-key" });
		expect(result).toMatchObject({
			query: "synth plugin modulation",
			provider: "exa",
			requestId: "req-123",
			usage: { costUsd: 0.007 },
			appliedOptions: ["maxResults", "mode", "domains", "publishedAfter", "publishedBefore", "wantHighlights"],
			warnings: [],
		});
		expect(result.answer).toBeUndefined();
		expect(result.results).toEqual([
			{
				url: "https://Example.com/article",
				title: "A synth article",
				domain: "example.com",
				publishedAt: "2025-04-02T03:04:05.000Z",
				excerpt: "An evidence excerpt.",
				highlights: ["evidence excerpt"],
				provider: "exa",
				searchQuery: "synth plugin modulation",
				sourceId: "source-1",
				score: 0.75,
			},
			{
				url: "https://example.com/second",
				domain: "example.com",
				excerpt: "A summary excerpt.",
				provider: "exa",
				searchQuery: "synth plugin modulation",
			},
		]);
	});

	it("reports unsupported modes and answer synthesis instead of dropping them", async () => {
		let seenBody: Record<string, unknown> | undefined;
		const provider = createExaProvider({
			apiKey: "test-key",
			fetchImpl: (async (_input, init) => {
				seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response({ results: [] });
			}) as ExaFetch,
		});

		const result = await provider.search(
			{ query: "new music", mode: "fresh", wantAnswer: true },
			new AbortController().signal,
			{},
		);

		expect(seenBody).toEqual({ query: "new music", numResults: 10, contents: { highlights: true } });
		expect(result.warnings).toEqual([
			{
				code: "unsupported-option",
				option: "mode",
				message: "Exa does not provide fresh search semantics; provider default used",
			},
			{
				code: "unsupported-option",
				option: "wantAnswer",
				message: "Exa evidence search does not request a synthesized answer",
			},
		]);
	});

	it("returns an auth failure before making a request without a key", async () => {
		let calls = 0;
		const provider = createExaProvider({
			fetchImpl: (async () => {
				calls += 1;
				return response({ results: [] });
			}) as ExaFetch,
		});

		await expect(provider.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({
			kind: "auth",
			provider: "exa",
		});
		expect(calls).toBe(0);
	});

	it("maps auth, rate-limit, HTTP, and malformed payload failures", async () => {
		for (const [status, kind] of [
			[401, "auth"],
			[429, "rateLimit"],
			[503, "http"],
		] as const) {
			const provider = createExaProvider({
				apiKey: "test-key",
				fetchImpl: (async () => response({ error: "not exposed" }, status)) as ExaFetch,
			});
			await expect(provider.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({
				kind,
				status,
			});
		}

		const malformedProvider = createExaProvider({
			apiKey: "test-key",
			fetchImpl: (async () => response({ results: [{ title: "missing url" }] })) as ExaFetch,
		});
		await expect(malformedProvider.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({
			kind: "malformed",
		});
	});

	it("maps transport errors and cancellation", async () => {
		const networkProvider = createExaProvider({
			apiKey: "test-key",
			fetchImpl: (async () => {
				throw new Error("socket failed");
			}) as ExaFetch,
		});
		await expect(networkProvider.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({
			kind: "network",
			retryable: true,
		});

		const controller = new AbortController();
		controller.abort();
		const canceledProvider = createExaProvider({
			apiKey: "test-key",
			fetchImpl: (async () => response({ results: [] })) as ExaFetch,
		});
		await expect(canceledProvider.search({ query: "q" }, controller.signal, {})).rejects.toMatchObject({
			kind: "canceled",
		});
	});

	it("normalizes a standalone fixture response", () => {
		const result = normalizeExaResponse(
			{ results: [{ url: "https://example.com", highlights: ["a"] }] },
			{ query: "q", wantHighlights: true },
		);
		expect(result.results[0]?.excerpt).toBe("a");
		expect(result.results[0]?.highlights).toEqual(["a"]);
	});
});
