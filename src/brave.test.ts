import { describe, expect, it, jest, spyOn } from "bun:test";
import { getEventListeners } from "node:events";
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

	it("rejects unsupported exact dates and social constraints", () => {
		expect(() => buildBraveRequest({ query: "q", dateRange: { from: "2026-01-01" } })).toThrow(/exact date-range/);
		expect(() => buildBraveRequest({ query: "q", social: { includeHandles: ["xai"] } })).toThrow(/social\/X/);
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

	it("canonicalizes trailing-dot domains before applying exclusions", () => {
		const result = normalizeBraveResponse(
			{ web: { results: [{ url: "https://example.com./private", title: "Excluded" }] } },
			{ query: "q", domains: { exclude: ["example.com"] }, maxResults: 10 },
		);
		expect(result.results).toEqual([]);
	});

	it("rejects overlong result URLs instead of truncating them", () => {
		expect(() => normalizeBraveResponse(
			{ web: { results: [{ url: `https://example.com/${"a".repeat(8_200)}` }] } },
			{ query: "q", maxResults: 10 },
		)).toThrow("exceeds the supported length limit");
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

	it("removes canceled reservations without delaying surviving FIFO admissions", async () => {
		jest.useFakeTimers();
		try {
			const tracker = new BraveQuotaTracker({ minimumIntervalMs: 100 });
			expect(await tracker.waitForTurn(signal)).toBe(true);
			const batch = new AbortController();
			const canceled = Array.from({ length: 5 }, () => tracker.waitForTurn(batch.signal));
			const admissions: string[] = [];
			const first = tracker.waitForTurn(signal).then(ok => { if (ok) admissions.push("first"); });
			const second = tracker.waitForTurn(signal).then(ok => { if (ok) admissions.push("second"); });
			batch.abort();
			expect(await Promise.all(canceled)).toEqual([false, false, false, false, false]);
			jest.advanceTimersByTime(99);
			await Promise.resolve();
			expect(admissions).toEqual([]);
			jest.advanceTimersByTime(1);
			await Promise.resolve();
			expect(admissions).toEqual(["first"]);
			jest.advanceTimersByTime(100);
			await Promise.resolve();
			expect(admissions).toEqual(["first", "second"]);
			await Promise.all([first, second]);
		} finally {
			jest.useRealTimers();
		}
	});

	it("leaves only the last actual admission's spacing after an entire queue is canceled", async () => {
		jest.useFakeTimers();
		try {
			const tracker = new BraveQuotaTracker({ minimumIntervalMs: 100 });
			await tracker.waitForTurn(signal);
			const controller = new AbortController();
			const pending = tracker.waitForTurn(controller.signal);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
			jest.advanceTimersByTime(50);
			controller.abort();
			expect(await pending).toBe(false);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			let admitted = false;
			const next = tracker.waitForTurn(signal).then(ok => { admitted = ok; });
			jest.advanceTimersByTime(49);
			await Promise.resolve();
			expect(admitted).toBe(false);
			jest.advanceTimersByTime(1);
			await Promise.resolve();
			expect(admitted).toBe(true);
			await next;
			expect(getEventListeners(signal, "abort")).toHaveLength(0);
		} finally {
			jest.useRealTimers();
		}
	});

	it("paces from actual admissions even when a timer runs late", async () => {
		jest.useFakeTimers();
		let now = 1_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const tracker = new BraveQuotaTracker({ minimumIntervalMs: 100 });
			await tracker.waitForTurn(signal);
			const starts: number[] = [];
			const pending = [1, 2].map(() => tracker.waitForTurn(signal).then(() => { starts.push(now); }));
			// Simulate a stalled event loop: due callbacks see a much later wall clock.
			now = 2_000;
			jest.advanceTimersByTime(500);
			await Promise.resolve();
			expect(starts).toEqual([2_000]);
			now = 2_100;
			jest.advanceTimersByTime(100);
			await Promise.all(pending);
			expect(starts).toEqual([2_000, 2_100]);
		} finally {
			clock.mockRestore();
			jest.useRealTimers();
		}
	});

	it("admits zero-interval calls immediately but rejects already canceled calls", async () => {
		const tracker = new BraveQuotaTracker();
		const controller = new AbortController();
		controller.abort();
		expect(await tracker.waitForTurn(controller.signal)).toBe(false);
		expect(await Promise.all(Array.from({ length: 5 }, () => tracker.waitForTurn(signal)))).toEqual([true, true, true, true, true]);
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
