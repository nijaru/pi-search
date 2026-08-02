import { describe, expect, it } from "bun:test";
import { buildXRequest, createXProvider, type XAdapterOptions } from "./x";
import type { SearchHttpFetch } from "./provider-http";

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

const payload = {
	data: [
		{ id: "123", text: "A post about protocols", author_id: "u1", created_at: "2025-01-02T03:04:05.000Z" },
		{ id: "456", text: "Another post", author_id: "u2", created_at: "2025-01-03T03:04:05.000Z" },
	],
	includes: { users: [{ id: "u1", username: "alice" }, { id: "u2", username: "bob" }] },
};

function provider(options: Partial<XAdapterOptions> = {}) {
	return createXProvider({ endpoint: "https://x.test/2/tweets/search/recent", bearerToken: "x-test", ...options });
}

describe("X API provider", () => {
	it("builds bounded recent-search requests", () => {
		const plan = buildXRequest({ query: "from:alice protocols", maxResults: 2 });
		const url = new URL(plan.url);
		expect(url.searchParams.get("query")).toBe("from:alice protocols");
		expect(url.searchParams.get("max_results")).toBe("10");
		expect(url.searchParams.get("tweet_fields")).toContain("created_at");
		expect(plan.appliedOptions).toEqual(["maxResults", "mode"]);
	});

	it("maps bounded X handles and date ranges to recent search", () => {
		const plan = buildXRequest({ query: "protocols", dateRange: { from: "2026-01-01", to: "2026-01-02" }, social: { includeHandles: ["@alice", "bob"], excludeHandles: ["carol"] } });
		const url = new URL(plan.url);
		expect(url.searchParams.get("query")).toBe("protocols (from:alice OR from:bob) -from:carol");
		expect(url.searchParams.get("start_time")).toBe("2026-01-01T00:00:00.000Z");
		expect(url.searchParams.get("end_time")).toBe("2026-01-02T23:59:59.999Z");
		expect(plan.appliedOptions).toEqual(["maxResults", "mode", "dateRange", "social"]);
	});

	it("normalizes post text, authors, timestamps, and canonical post URLs", async () => {
		let seenUrl = "";
		let seenMethod = "";
		let seenHeaders: Headers | undefined;
		const result = await provider({ fetchImpl: (async (input, init) => {
			seenUrl = String(input);
			seenMethod = init?.method ?? "";
			seenHeaders = new Headers(init?.headers);
			return response(payload, 200, {
				"content-type": "application/json",
				"x-request-id": "x-123",
				"x-rate-limit-limit": "450",
				"x-rate-limit-remaining": "449",
				"x-rate-limit-reset": "1700000000",
			});
		}) as SearchHttpFetch }).search({ query: "protocols", maxResults: 2 }, new AbortController().signal, {});
		expect(seenMethod).toBe("GET");
		expect(new URL(seenUrl).searchParams.get("max_results")).toBe("10");
		expect(seenHeaders?.get("authorization")).toBe("Bearer x-test");
		expect(result).toMatchObject({ provider: "x", requestId: "x-123", usage: { billedUnits: 2, billedUnit: "posts" } });
		expect(result.usage?.rateLimits?.windows[0]).toMatchObject({ limit: 450, remaining: 449 });
		expect(result.results).toEqual([
			{ url: "https://x.com/i/web/status/123", title: "@alice", domain: "x.com", publishedAt: "2025-01-02T03:04:05.000Z", excerpt: "A post about protocols", provider: "x", searchQuery: "protocols", sourceId: "123" },
			{ url: "https://x.com/i/web/status/456", title: "@bob", domain: "x.com", publishedAt: "2025-01-03T03:04:05.000Z", excerpt: "Another post", provider: "x", searchQuery: "protocols", sourceId: "456" },
		]);
	});

	it("rejects web-domain and media constraints instead of dropping hard constraints", async () => {
		await expect(provider().search({ query: "q", domains: { include: ["example.com"] } }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "x", kind: "unsupported" });
		await expect(provider().search({ query: "q", social: { understandVideos: true } }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "x", kind: "unsupported" });
	});

	it("returns empty results for a valid no-match response and rejects missing auth", async () => {
		const empty = await provider({ fetchImpl: (async () => response({ meta: { result_count: 0 } })) as SearchHttpFetch }).search({ query: "none" }, new AbortController().signal, {});
		expect(empty.results).toEqual([]);
		await expect(createXProvider({ fetchImpl: (async () => response({})) as SearchHttpFetch }).search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "x", kind: "auth" });
	});

	it("maps X rate limits and authentication failures through the shared HTTP boundary", async () => {
		const failing = provider({ fetchImpl: (async () => response({ errors: [{ message: "bad token" }] }, 401, { "x-request-id": "x-auth" })) as SearchHttpFetch });
		await expect(failing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ provider: "x", kind: "auth", requestId: "x-auth" });
	});
});
