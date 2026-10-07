import { describe, expect, it } from "bun:test";
import { createCloudflareProvider, type CloudflareAdapterOptions, type CloudflareUpstream } from "./cloudflare";
import type { SearchRequest } from "./contracts";
import { createWebSearchTool } from "./search-tool";
import { createWebResearchTool } from "./research-tool";

const payload = {
	items: [{ url: "https://example.com/page", title: "Example", description: "Useful evidence." }],
	metadata: { query: "q", requestId: "cf-body", latencyMs: 612 },
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function provider(options: Partial<CloudflareAdapterOptions> = {}) {
	return createCloudflareProvider({ accountId: "account-test", apiToken: "token-test", upstream: "exa", fetchImpl: async () => response(payload), ...options });
}

function search(configured = provider(), request: SearchRequest = { query: "q" }, signal = new AbortController().signal) {
	return configured.search(request, signal, {});
}

describe("CloudflareProvider", () => {
	it("uses Cloudflare bearer auth, explicit upstream, gateway and BYOK alias in one request", async () => {
		for (const upstream of ["ceramic", "exa", "linkup"] as const) {
			let calls = 0;
			const controller = new AbortController();
			const configured = provider({ upstream, gatewayId: "search-gateway", byokAlias: "key_1-test", fetchImpl: async (input, init) => {
				calls += 1;
				expect(String(input)).toBe("https://api.cloudflare.com/client/v4/accounts/account-test/ai/websearch/");
				expect(init?.method).toBe("POST");
				expect(init?.redirect).toBe("error");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-test");
				expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
				expect(init?.signal).toBe(controller.signal);
				expect(JSON.parse(String(init?.body))).toEqual({ query: "q", provider: upstream, limit: 1, options: { gateway: { id: "search-gateway" } }, byokAlias: "key_1-test" });
				return response(payload);
			} });
			const result = await search(configured, { query: "  q  ", maxResults: 1, answerMode: "evidence" }, controller.signal);
			expect(calls).toBe(1);
			expect(result).toMatchObject({ provider: "cloudflare", query: "q", requestId: "cf-body", latencyMs: 612, appliedOptions: ["maxResults"], warnings: [] });
			expect(result.results[0]).toMatchObject({ provider: "cloudflare", upstreamProvider: upstream, searchQuery: "q", url: "https://example.com/page", domain: "example.com", title: "Example", excerpt: "Useful evidence." });
			expect(result.answer).toBeUndefined();
			expect(result.usage).toBeUndefined();
			expect(configured.profile).toEqual({ auth: "environment", costModel: "unknown" });
		}
	});

	it("preserves gateway provenance through both public tool entry points", async () => {
		const configured = provider({ fetchImpl: async () => response({ ...payload, items: [{ url: "https://EXAMPLE.com/page#part", description: "evidence" }] }) });
		const searchTool = createWebSearchTool(configured);
		const context = { modelRegistry: { getAvailable: () => [] } } as never;
		const result = await searchTool.execute("call", { query: "q", provider: "cloudflare" }, undefined, undefined, context);
		expect(result.details).toMatchObject({ provider: "cloudflare", upstreamProvider: "exa", results: [{ sourceUrl: "https://EXAMPLE.com/page#part", upstreamProvider: "exa" }] });
		expect(result.content).toMatchObject([{ type: "text", text: expect.stringContaining("cloudflare/exa") }]);
		const researchTool = createWebResearchTool(() => configured);
		const research = await researchTool.execute("call", { question: "q", provider: "cloudflare", budget: { maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 5_000, maxOutputChars: 5_000 } }, undefined, undefined, context);
		expect(research.details.results[0]).toMatchObject({ provider: "cloudflare", upstreamProvider: "exa" });
		expect(research.content).toMatchObject([{ type: "text", text: expect.stringContaining("cloudflare/exa") }]);
	});

	it("defaults only the gateway and result limit, never the upstream or BYOK alias", async () => {
		await search(provider({ fetchImpl: async (_input, init) => {
			expect(JSON.parse(String(init?.body))).toEqual({ query: "q", provider: "exa", limit: 10, options: { gateway: { id: "default" } } });
			return response(payload);
		} }));
	});

	it("rejects missing credentials/upstream and invalid gateway or BYOK alias before I/O", async () => {
		let calls = 0;
		const cases: readonly [Partial<CloudflareAdapterOptions>, string][] = [
			[{ accountId: undefined }, "auth"], [{ apiToken: " " }, "auth"],
			[{ upstream: undefined }, "badRequest"], [{ upstream: "unknown" as CloudflareUpstream }, "badRequest"],
			[{ gatewayId: " " }, "badRequest"], [{ byokAlias: "" }, "badRequest"],
			[{ byokAlias: "invalid alias" }, "badRequest"], [{ byokAlias: "a".repeat(65) }, "badRequest"],
		];
		for (const [options, kind] of cases) {
			await expect(search(provider({ ...options, fetchImpl: async () => { calls += 1; return response(payload); } }))).rejects.toMatchObject({ provider: "cloudflare", kind, retryable: false });
		}
		expect(calls).toBe(0);
	});

	it("validates neutral requests and rejects provider limits rather than truncating", async () => {
		let calls = 0;
		const configured = provider({ fetchImpl: async (_input, init) => {
			calls += 1;
			const body = JSON.parse(String(init?.body));
			expect(body.query).toBe("a".repeat(1_024));
			expect(body.limit).toBe(10);
			return response({ items: [] });
		} });
		await expect(search(configured, { query: " " })).rejects.toMatchObject({ code: "WEB_SEARCH_INVALID_REQUEST" });
		await expect(search(configured, { query: "q", maxResults: 0 })).rejects.toMatchObject({ code: "WEB_SEARCH_INVALID_REQUEST" });
		await expect(search(configured, { query: "a".repeat(1_025) })).rejects.toMatchObject({ kind: "badRequest" });
		await expect(search(configured, { query: "q", maxResults: 11 })).rejects.toMatchObject({ kind: "badRequest" });
		expect(calls).toBe(0);
		await search(configured, { query: "a".repeat(1_024), maxResults: 10 });
		expect(calls).toBe(1);
	});

	it("rejects all unsupported constraints and native controls, including false/default values", async () => {
		let calls = 0;
		const configured = provider({ fetchImpl: async () => { calls += 1; return response(payload); } });
		const cases: readonly Partial<SearchRequest>[] = [
			{ domains: { include: ["example.com"] } }, { domains: { exclude: ["example.com"] } },
			{ dateRange: { from: "2026-01-01" } }, { dateRange: { to: "2026-01-01" } },
			{ social: { includeHandles: ["example"] } }, { social: { understandImages: false } },
			{ executionModel: "model" }, { searchContextSize: "low" }, { returnTokenBudget: "default" },
			{ externalWebAccess: false }, { externalWebAccess: true },
			{ userLocation: { type: "approximate", country: "US" } },
			{ searchContentTypes: ["text"] }, { searchContentTypes: ["image"] },
			{ searchContentTypes: ["image"], imageSettings: { caption: false } },
		];
		for (const options of cases) {
			await expect(search(configured, { query: "q", ...options })).rejects.toMatchObject({ provider: "cloudflare", kind: "unsupported", retryable: false });
		}
		expect(calls).toBe(0);
	});

	it("warns on mode hints without claiming to apply them", async () => {
		for (const mode of ["keyword", "fresh"] as const) {
			const result = await search(provider(), { query: "q", mode });
			expect(result.warnings).toMatchObject([{ code: "unsupported-option", option: "mode" }]);
			expect(result.appliedOptions).toEqual(["maxResults"]);
		}
	});

	it("normalizes bounded HTTP evidence, preserves original URLs, and discards malformed sources", async () => {
		const result = await search(provider({ fetchImpl: async () => response({
			items: [null, [], { url: "not-a-url" }, { url: "javascript:alert(1)" }, { url: "https://user:password@example.com/" }, { url: `https://example.com/${"a".repeat(8_192)}` },
				{ url: "https://EXAMPLE.com/page#fragment", title: "t".repeat(600), description: "e".repeat(8_000), imageUrl: "https://example.com/image", faviconUrl: "https://example.com/icon", lastModifiedDate: "2026-01-01T00:00:00Z" },
				{ url: "http://example.com/second" }],
			metadata: { query: "reported query", requestId: "cf-body", latencyMs: 0 },
		}) }), { query: "q", maxResults: 1 });
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toEqual({ url: "https://example.com/page", sourceUrl: "https://EXAMPLE.com/page#fragment", domain: "example.com", title: "t".repeat(500), excerpt: "e".repeat(4_000), provider: "cloudflare", upstreamProvider: "exa", searchQuery: "q" });
		expect(result.query).toBe("q");
		expect(result.latencyMs).toBe(0);
		expect(result.warnings).toEqual([{ code: "partial-results", message: "Cloudflare discarded 6 malformed result entries" }]);
	});

	it("accepts empty searches but rejects malformed envelopes and wholly invalid sources", async () => {
		expect((await search(provider({ fetchImpl: async () => response({ items: [] }) }))).results).toEqual([]);
		for (const body of [null, {}, { items: {} }, { items: [null, { url: "file:///tmp/a" }] }]) {
			await expect(search(provider({ fetchImpl: async () => response(body) }))).rejects.toMatchObject({ provider: "cloudflare", kind: "malformed", retryable: false });
		}
	});

	it("preserves transport metadata without inferring costs or mislabeling optional fields", async () => {
		const result = await search(provider({ fetchImpl: async () => response({
			...payload, metadata: { query: 123, requestId: "cf-body", latencyMs: -1 }, costDollars: { total: 7 },
		}, 200, { "x-request-id": "cf-header", "x-ratelimit-limit": "10", "x-ratelimit-remaining": "7" }) }));
		expect(result.requestId).toBe("cf-header");
		expect(result.latencyMs).toBeUndefined();
		expect(result.query).toBe("q");
		expect(result.usage).toEqual({ rateLimits: { windows: [{ limit: 10, remaining: 7, scope: "window-0" }] } });
	});

	it("surfaces HTTP errors without upstream or paid fallback, including a missing BYOK key", async () => {
		for (const [status, kind, retryable] of [[400, "badRequest", false], [401, "auth", false], [429, "rateLimit", true], [503, "http", true]] as const) {
			let calls = 0;
			const configured = provider({ byokAlias: "missing-key", fetchImpl: async () => {
				calls += 1;
				return response({ error: "failed" }, status, { "x-request-id": "failed-request", "retry-after": "2" });
			} });
			await expect(search(configured)).rejects.toMatchObject({ provider: "cloudflare", kind, status, retryable, requestId: "failed-request", retryAfterMs: 2_000 });
			expect(calls).toBe(1);
		}
	});

	it("uses shared bounded JSON and cancellation handling", async () => {
		await expect(search(provider({ maxResponseBytes: 10 }))).rejects.toMatchObject({ provider: "cloudflare", kind: "malformed" });
		await expect(search(provider({ fetchImpl: async () => new Response("not JSON") }))).rejects.toMatchObject({ kind: "malformed" });
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(search(provider({ fetchImpl: async () => { calls += 1; return response(payload); } }), { query: "q" }, controller.signal)).rejects.toMatchObject({ provider: "cloudflare", kind: "canceled", retryable: false });
		expect(calls).toBe(0);
		const duringRequest = new AbortController();
		await expect(search(provider({ fetchImpl: async (_input, init) => {
			expect(init?.signal).toBe(duringRequest.signal);
			duringRequest.abort();
			throw new DOMException("aborted", "AbortError");
		} }), { query: "q" }, duringRequest.signal)).rejects.toMatchObject({ provider: "cloudflare", kind: "canceled" });
	});
});
