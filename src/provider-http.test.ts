import { expect, test } from "bun:test";
import { postJson } from "./provider-http";

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
