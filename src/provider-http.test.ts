import { expect, test } from "bun:test";
import { parseProviderRateLimits, postJson } from "./provider-http";

test.each([[400, "badRequest", false], [401, "auth", false], [429, "rateLimit", true], [503, "http", true]] as const)("shared HTTP rejection %i preserves diagnostics and closes the body", async (status, kind, retryable) => {
	let closed = false;
	let calls = 0;
	await expect(postJson({
		provider: "parallel-responses", url: "https://example.test", headers: { authorization: "Bearer dummy" }, signal: new AbortController().signal,
		fetchImpl: async (_url, init) => {
			calls++;
			expect(init?.redirect).toBe("error");
			return new Response(new ReadableStream({ cancel() { closed = true; } }), { status, headers: { "x-request-id": "rejected", "retry-after": "2" } });
		},
	})).rejects.toMatchObject({ kind, status, retryable, requestId: "rejected", retryAfterMs: 2000 });
	expect(closed).toBe(true);
	expect(calls).toBe(1);
});

test("keeps quota windows aligned and rejects overflowing retry delays", () => {
	expect(parseProviderRateLimits(new Headers({ "x-ratelimit-limit": "10,,30", "x-ratelimit-remaining": "9,0,29" }))?.windows).toEqual([
		{ limit: 10, remaining: 9, scope: "window-0" },
		{ remaining: 0, scope: "window-1" },
		{ limit: 30, remaining: 29, scope: "window-2" },
	]);
	expect(parseProviderRateLimits(new Headers({ "retry-after": "9".repeat(308) }))).toBeUndefined();
});

test("bounds quota headers and windows and ignores invalid reset dates", () => {
	const info = parseProviderRateLimits(new Headers({ "x-ratelimit-limit": "1,".repeat(1_000), "x-ratelimit-reset": "9".repeat(5_000), "retry-after": "9".repeat(5_000) }));
	expect(info?.windows).toHaveLength(8);
	expect(info?.retryAfterMs).toBeUndefined();
	expect(parseProviderRateLimits(new Headers({ "x-ratelimit-limit": "1,".repeat(10_000) }))).toBeUndefined();
	expect(parseProviderRateLimits(new Headers({ "x-ratelimit-reset": "99999999999999999999" }))).toBeUndefined();
});

test("parses multiple quota windows and retry-after metadata", () => {
	const info = parseProviderRateLimits(new Headers({
		"x-ratelimit-limit": "1, 2000", "x-ratelimit-remaining": "0, 1999",
		"x-ratelimit-reset": "1, 2592000", "retry-after": "2",
	}));
	expect(info).toEqual({
		windows: [
			{ limit: 1, remaining: 0, resetAfterMs: 1000, scope: "window-0" },
			{ limit: 2000, remaining: 1999, resetAfterMs: 2_592_000_000, scope: "window-1" },
		],
		retryAfterMs: 2000,
	});
});
