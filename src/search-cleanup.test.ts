import { describe, expect, it } from "bun:test";
import type { SearchResponse } from "./contracts";
import { cleanupSearchResponse, searchUrlIdentity } from "./search-cleanup";
import { validateSearchRequest } from "./search";

describe("search result cleanup", () => {
	it("normalizes URL identity, preserves the raw URL, merges metadata, and limits after deduplication", () => {
		const request = validateSearchRequest({ query: "  q  ", maxResults: 1 });
		const response: SearchResponse = {
			query: "wrong",
			provider: "wrong",
			results: [
				{
					url: "https://EXAMPLE.com:443/page#section",
					title: " ",
					provider: "wrong",
					searchQuery: "wrong",
				},
				{
					url: "https://example.com/page",
					title: "Useful title",
					excerpt: "Useful excerpt",
					sourceId: "source-1",
					provider: "wrong",
					searchQuery: "wrong",
				},
				{
					url: "https://example.com/second",
					provider: "wrong",
					searchQuery: "wrong",
				},
			],
			appliedOptions: ["maxResults"],
			warnings: [],
		};

		const cleaned = cleanupSearchResponse(response, request, "brave");
		expect(cleaned.query).toBe("q");
		expect(cleaned.provider).toBe("brave");
		expect(cleaned.results).toEqual([
			{
				url: "https://example.com/page",
				sourceUrl: "https://EXAMPLE.com:443/page#section",
				title: "Useful title",
				domain: "example.com",
				excerpt: "Useful excerpt",
				provider: "brave",
				searchQuery: "q",
				sourceId: "source-1",
			},
		]);
	});

	it("rejects non-http URLs and embedded credentials while reporting discarded results", () => {
		const request = validateSearchRequest({ query: "q" });
		const cleaned = cleanupSearchResponse({
			query: "q",
			provider: "brave",
			results: [
				{ url: "javascript:alert(1)", provider: "brave", searchQuery: "q" },
				{ url: "https://user:pass@example.com/", provider: "brave", searchQuery: "q" },
				{ url: `https://example.com/${"x".repeat(8_200)}`, provider: "brave", searchQuery: "q" },
			],
			appliedOptions: [],
			warnings: [],
		}, request, "brave");

		expect(cleaned.results).toEqual([]);
		expect(cleaned.warnings.at(-1)).toMatchObject({ code: "partial-results" });
	});

	it("uses the same conservative identity for research fetch deduplication", () => {
		expect(searchUrlIdentity("https://EXAMPLE.com:443/page#part")).toBe("https://example.com/page");
		expect(searchUrlIdentity("https://example.com/page")).toBe("https://example.com/page");
		expect(searchUrlIdentity("file:///tmp/private")).toBeUndefined();
	});
});
