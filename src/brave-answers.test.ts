import { describe, expect, it } from "bun:test";
import { buildBraveAnswersRequest, createBraveAnswersProvider, extractTaggedAnswer, type BraveAnswersAdapterOptions } from "./brave-answers";

function sse(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "content-type": "text/event-stream", "x-request-id": "req-ba", ...headers } });
}

/** Stream one answer text split across deltas with citation and usage tags. */
const streamedAnswer = [
	{ choices: [{ delta: { content: "The second highest mountain is K2, at 8,611" } }] },
	{ choices: [{ delta: { content: " metres above sea level." } }] },
	{ choices: [{ delta: { content: '<citation>{"start_index": 0, "end_index": 30, "number": 1, "url": "https://en.wikipedia.org/wiki/K2", "favicon": "Wikipedia", "snippet": "K2 is the second highest mountain"}</citation>' } }] },
	{ choices: [{ delta: { content: ' <citation>{"start_index": 0, "end_index": 30, "number": 2, "url": "https://britannica.com/topic/K2", "snippet": "K2 mountain"}</citation>' } }] },
	{ choices: [{ delta: { content: '<usage>{ "X-Request-Requests": 1, "X-Request-Queries": 2, "X-Request-Tokens-In": 1234, "X-Request-Tokens-Out": 300, "X-Request-Total-Cost": 0.01567 }</usage>' } }] },
];

function sseBody(chunks: readonly unknown[]): string {
	return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function provider(options: Partial<BraveAnswersAdapterOptions> = {}) {
	return createBraveAnswersProvider({ apiKey: "brave-test", endpoint: "https://brave.test/res/v1/chat/completions", ...options });
}

describe("BraveAnswersProvider", () => {
	it("builds the streaming chat-completions request with citation controls", () => {
		const plan = buildBraveAnswersRequest({ query: "second highest mountain", searchContextSize: "low", userLocation: { type: "approximate", country: "US" } });
		expect(plan.body).toMatchObject({
			model: "brave",
			stream: true,
			enable_citations: true,
			messages: [{ role: "user", content: "second highest mountain" }],
			web_search_options: {
				search_context_size: "low",
				user_location: { type: "approximate", country: "US" },
			},
		});
		expect(plan.appliedOptions).toEqual(["mode", "searchContextSize", "userLocation"]);
	});

	it("rejects unsupported hard constraints before network access", async () => {
		let calls = 0;
		const configured = provider({ fetchImpl: async () => { calls += 1; return sse(sseBody(streamedAnswer)); } });
		await expect(configured.search({ query: "q", domains: { include: ["example.com"] } }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "unsupported" });
		await expect(configured.search({ query: "q", dateRange: { from: "2026-01-01" } }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "unsupported" });
		expect(calls).toBe(0);
	});

	it("parses streamed citations and usage into cited evidence", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const configured = provider({ fetchImpl: async (input, init) => {
			seenUrl = String(input);
			seenInit = init;
			return sse(sseBody(streamedAnswer));
		} });
		const result = await configured.search({ query: "k2" }, new AbortController().signal, {});
		expect(seenUrl).toBe("https://brave.test/res/v1/chat/completions");
		expect(seenInit?.headers).toMatchObject({ "x-subscription-token": "brave-test", accept: "text/event-stream" });
		expect(result.provider).toBe("brave-answers");
		expect(result.requestId).toBe("req-ba");
		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/K2", excerpt: "K2 is the second highest mountain" });
		expect(result.answer?.text).toContain("8,611");
		expect(result.answer?.citations[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/K2", startIndex: 0, endIndex: 30 });
		expect(result.usage).toMatchObject({ inputTokens: 1234, outputTokens: 300, searchQueries: 2, costUsd: 0.01567 });
	});

	it("buffers citation tags that split across SSE deltas", () => {
		const a = "Answer.<citation>{\"url\": \"https://example.com/";
		const b = "page\", \"start_index\": 0, \"end_index\": 6}</citation>tail";
		const joined = extractTaggedAnswer(a + b);
		expect(joined.text).toBe("Answer.tail");
		expect(joined.citations).toHaveLength(1);
		expect(joined.citations[0]).toMatchObject({ url: "https://example.com/page", startIndex: 0, endIndex: 6 });
	});

	it("drops malformed citation JSON without losing surrounding text", () => {
		const joined = extractTaggedAnswer("before <citation>{not json</citation> after");
		expect(joined.text).toBe("before  after");
		expect(joined.citations).toHaveLength(0);
	});

	it("omits the answer in evidence mode but keeps cited results", async () => {
		const configured = provider({ fetchImpl: async () => sse(sseBody(streamedAnswer)) });
		const result = await configured.search({ query: "q", answerMode: "evidence" }, new AbortController().signal, {});
		expect(result.answer).toBeUndefined();
		expect(result.results).toHaveLength(2);
	});

	it("fails when the stream contains no answer text", async () => {
		const empty = provider({ fetchImpl: async () => sse(sseBody([{ choices: [{ delta: {} }] }])) });
		await expect(empty.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "malformed" });
	});

	it("maps HTTP error statuses onto provider errors", async () => {
		const rateLimited = provider({ fetchImpl: async () => sse("{}", 429, { "retry-after": "1" }) });
		await expect(rateLimited.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "rateLimit", retryable: true });
		const unauthorized = provider({ fetchImpl: async () => sse("{}", 401) });
		await expect(unauthorized.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "auth" });
	});

	it("surfaces the Brave ErrorResponse detail on failure statuses", async () => {
		const planMissing = provider({ fetchImpl: async () => sse(JSON.stringify({ type: "ErrorResponse", error: { id: "x", status: 400, detail: "The option is not included in the plan.", code: "OPTION_NOT_IN_PLAN" }, time: 0 }), 400, { "content-type": "application/json" }) });
		await expect(planMissing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "badRequest", message: "brave-answers failed with HTTP 400 (OPTION_NOT_IN_PLAN: The option is not included in the plan.)" });
	});

	it("falls back to the status-code message when the error body is not a Brave envelope", async () => {
		const html = provider({ fetchImpl: async () => sse("<html>gateway error</html>", 502, { "content-type": "text/html" }) });
		await expect(html.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "http", message: "brave-answers failed with HTTP 502" });
	});

	it("requires an API key", async () => {
		const missing = createBraveAnswersProvider({ endpoint: "https://brave.test/res/v1/chat/completions", fetchImpl: async () => sse(sseBody(streamedAnswer)) });
		await expect(missing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "auth" });
	});
});
