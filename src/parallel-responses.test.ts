import { describe, expect, it } from "bun:test";
import { buildParallelResponsesRequest, createParallelResponsesProvider, type ParallelResponsesAdapterOptions } from "./parallel-responses";

function sseResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "x-request-id": "req-pr" } });
}

/** A canonical Responses-shaped answer with two url_citation annotations. */
const responsesPayload = {
	id: "resp_123",
	object: "response",
	status: "completed",
	usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
	output: [
		{
			type: "message",
			content: [
				{
					type: "output_text",
					text: "Jensen Huang has been the CEO of Nvidia since April 1993.",
					annotations: [
						{ type: "url_citation", url: "https://nvidianews.nvidia.com/bios/jensen-huang", title: "Jensen Huang | NVIDIA Newsroom", start_index: 0, end_index: 56 },
						{ type: "url_citation", url: "https://simplywall.st/stocks/de/semiconductors/etr-nvd/nvidia-shares/management", title: "NVIDIA Leadership", start_index: 0, end_index: 56 },
						{ type: "url_citation", url: "https://nvidianews.nvidia.com/bios/jensen-huang", title: "Duplicate source", start_index: 57, end_index: 60 },
					],
				},
			],
		},
	],
};

function provider(options: Partial<ParallelResponsesAdapterOptions> = {}) {
	return createParallelResponsesProvider({ apiKey: "parallel-test", endpoint: "https://parallel.test/v1/responses", ...options });
}

describe("ParallelResponsesProvider", () => {
	it("builds the Responses request with the effort tier from searchContextSize", () => {
		const low = buildParallelResponsesRequest({ query: "federal funds rate", searchContextSize: "low" });
		expect(low.body).toMatchObject({ model: "parallel", input: "federal funds rate", reasoning: { effort: "low" } });
		expect(low.appliedOptions).toEqual(["mode", "searchContextSize"]);
		const medium = buildParallelResponsesRequest({ query: "q" });
		expect(medium.body).toMatchObject({ reasoning: { effort: "medium" } });
		const high = buildParallelResponsesRequest({ query: "q", searchContextSize: "high" });
		expect(high.body).toMatchObject({ reasoning: { effort: "high" } });
	});

	it("rejects unsupported hard constraints before network access", async () => {
		let calls = 0;
		const configured = provider({ fetchImpl: async () => { calls += 1; return sseResponse(responsesPayload); } });
		await expect(configured.search({ query: "q", domains: { include: ["example.com"] } }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "unsupported" });
		await expect(configured.search({ query: "q", dateRange: { from: "2026-01-01" } }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "unsupported" });
		await expect(configured.search({ query: "q", social: { includeHandles: ["a"] } }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "unsupported" });
		expect(calls).toBe(0);
	});

	it("sends bearer auth and normalizes a cited answer into evidence", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const configured = provider({ fetchImpl: async (input, init) => {
			seenUrl = String(input);
			seenInit = init;
			return sseResponse(responsesPayload);
		} });
		const result = await configured.search({ query: "nvidia ceo" }, new AbortController().signal, {});
		expect(seenUrl).toBe("https://parallel.test/v1/responses");
		expect(seenInit?.headers).toMatchObject({ authorization: "Bearer parallel-test" });
		expect(JSON.parse(String(seenInit?.body))).toMatchObject({ model: "parallel", reasoning: { effort: "medium" } });
		expect(result.provider).toBe("parallel-responses");
		expect(result.requestId).toBe("req-pr");
		expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 80, totalTokens: 200 });
		// Duplicate citation URL deduplicates into one result; results are cited sources.
		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toMatchObject({ url: "https://nvidianews.nvidia.com/bios/jensen-huang", domain: "nvidianews.nvidia.com" });
		expect(result.answer).toBeDefined();
		expect(result.answer?.text).toContain("Jensen Huang");
		expect(result.answer?.citations[0]).toMatchObject({ url: "https://nvidianews.nvidia.com/bios/jensen-huang", startIndex: 0, endIndex: 56 });
		expect(result.answer?.contentTrust).toBe("untrusted");
	});

	it("omits the answer in evidence mode but keeps cited results", async () => {
		const configured = provider({ fetchImpl: async () => sseResponse(responsesPayload) });
		const result = await configured.search({ query: "q", answerMode: "evidence" }, new AbortController().signal, {});
		expect(result.answer).toBeUndefined();
		expect(result.results).toHaveLength(2);
	});

	it("fails when the answer cites no HTTP sources", async () => {
		const empty = { ...responsesPayload, output: [{ type: "message", content: [{ type: "output_text", text: "No sources.", annotations: [] }] }] };
		const configured = provider({ fetchImpl: async () => sseResponse(empty) });
		await expect(configured.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "malformed" });
	});

	it("maps HTTP error statuses onto provider errors", async () => {
		const rateLimited = provider({ fetchImpl: async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429, headers: { "retry-after": "1" } }) });
		await expect(rateLimited.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "rateLimit", retryable: true });
		const unauthorized = provider({ fetchImpl: async () => new Response("{}", { status: 401 }) });
		await expect(unauthorized.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "auth" });
	});

	it("requires an API key", async () => {
		const missing = createParallelResponsesProvider({ endpoint: "https://parallel.test/v1/responses", fetchImpl: async () => sseResponse(responsesPayload) });
		await expect(missing.search({ query: "q" }, new AbortController().signal, {})).rejects.toMatchObject({ kind: "auth" });
	});
});


