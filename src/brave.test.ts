import { describe, expect, it } from "bun:test";
import {
	BRAVE_MAX_RESULTS,
	BraveQuotaTracker,
	type BraveFetch,
	buildBraveRequest,
	createBraveProvider,
	normalizeBraveResponse,
	parseBraveRateLimits,
} from "./brave";
import type { SearchRequest } from "./contracts";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

const signal = new AbortController().signal;

describe("BraveProvider", () => {
	it("builds one bounded request with safe domain operators and fresh mode", () => {
		const plan = buildBraveRequest({
			query: "typescript fetch",
			mode: "fresh",
			maxResults: 20,
			domains: { include: ["Example.com", "docs.example.com"], exclude: ["blocked.example"] },
		});
		const url = new URL(plan.url);
		expect(url.searchParams.get("q")).toBe("(site:example.com OR site:docs.example.com) typescript fetch -site:blocked.example");
		expect(url.searchParams.get("count")).toBe(String(BRAVE_MAX_RESULTS));
		expect(url.searchParams.get("freshness")).toBe("pm");
		expect(plan.appliedOptions).toEqual(["maxResults", "domains", "mode"]);
		expect(plan.warnings).toEqual([]);
	});

	it("normalizes evidence and post-filters domains", () => {
		const result = normalizeBraveResponse(
			{
				web: {
					results: [
						{ title: "Allowed", url: "https://docs.example.com/a", description: "A snippet", published: "2025-04-02" },
						{ title: "Outside", url: "https://other.example/a", description: "Drop me" },
						{ title: "Blocked", url: "https://blocked.example/a", description: "Drop me too" },
					],
				},
			},
			{ query: "q", domains: { include: ["example.com"], exclude: ["blocked.example"] }, maxResults: 10 },
			{ requestId: "brave-1", rateLimits: { windows: [{ limit: 1, remaining: 0, resetAfterMs: 1000 }] } },
		);
		expect(result.results).toEqual([
			{
				url: "https://docs.example.com/a",
				title: "Allowed",
				domain: "docs.example.com",
				publishedAt: "2025-04-02",
				excerpt: "A snippet",
				provider: "brave",
				searchQuery: "q",
			},
		]);
		expect(result.requestId).toBe("brave-1");
		expect(result.usage?.rateLimits?.windows[0]?.remaining).toBe(0);
	});

	it("parses multiple quota windows and retry-after metadata", () => {
		const info = parseBraveRateLimits(
			new Headers({
				"x-ratelimit-limit": "1, 2000",
				"x-ratelimit-remaining": "0, 1999",
				"x-ratelimit-reset": "1, 2592000",
				"retry-after": "2",
			}),
		);
		expect(info).toEqual({
			windows: [
				{ limit: 1, remaining: 0, resetAfterMs: 1000, scope: "window-0" },
				{ limit: 2000, remaining: 1999, resetAfterMs: 2_592_000_000, scope: "window-1" },
			],
			retryAfterMs: 2000,
		});
	});

	it("expires relative quota observations and treats zero limits as unlimited", async () => {
		const tracker = new BraveQuotaTracker();
		tracker.observe({ windows: [{ limit: 1, remaining: 0, resetAfterMs: 5 }] });
		expect(tracker.canAttempt()).toBe(false);
		await Bun.sleep(10);
		expect(tracker.canAttempt()).toBe(true);
		tracker.observe({ windows: [{ limit: 0, remaining: 0, resetAfterMs: 1_000 }] });
		expect(tracker.canAttempt()).toBe(true);
	});

	it("does not call the network without a key or after known quota exhaustion", async () => {
		let calls = 0;
		const tracker = new BraveQuotaTracker();
		const provider = createBraveProvider({
			apiKey: "test-key",
			capacityTracker: tracker,
			fetchImpl: (async () => {
				calls += 1;
				return response({ web: { results: [] } });
			}) as BraveFetch,
		});
		tracker.observe({ windows: [{ remaining: 0, resetAfterMs: 1000 }] });
		await expect(provider.search({ query: "q" }, signal, {})).rejects.toMatchObject({ kind: "rateLimit", provider: "brave" });
		expect(calls).toBe(0);

		const noKey = createBraveProvider({ fetchImpl: (async () => response({ web: { results: [] } })) as BraveFetch });
		await expect(noKey.search({ query: "q" }, signal, {})).rejects.toMatchObject({ kind: "auth", provider: "brave" });
	});

	it("maps HTTP, malformed, oversized, and cancellation failures", async () => {
		for (const [status, kind] of [[401, "auth"], [429, "rateLimit"], [503, "http"]] as const) {
			const provider = createBraveProvider({ apiKey: "test-key", fetchImpl: (async () => response({}, status)) as BraveFetch });
			await expect(provider.search({ query: "q" }, signal, {})).rejects.toMatchObject({ kind, status });
		}
		const malformed = createBraveProvider({ apiKey: "test-key", fetchImpl: (async () => response({ web: {} })) as BraveFetch });
		await expect(malformed.search({ query: "q" }, signal, {})).rejects.toMatchObject({ kind: "malformed" });
		const oversized = createBraveProvider({ apiKey: "test-key", maxResponseBytes: 10, fetchImpl: (async () => response({ web: { results: [] } })) as BraveFetch });
		await expect(oversized.search({ query: "q" }, signal, {})).rejects.toMatchObject({ kind: "malformed" });

		const controller = new AbortController();
		controller.abort();
		const canceled = createBraveProvider({ apiKey: "test-key", fetchImpl: (async () => response({ web: { results: [] } })) as BraveFetch });
		await expect(canceled.search({ query: "q" }, controller.signal, {})).rejects.toMatchObject({ kind: "canceled" });
	});
});
