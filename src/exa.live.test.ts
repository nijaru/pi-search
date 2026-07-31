import { describe, expect, it } from "bun:test";
import { createExaProvider } from "./exa";

const liveEnabled = process.env.PI_SEARCH_LIVE_EXA_TEST === "1" && Boolean(process.env.EXA_API_KEY);

describe("Exa live smoke test", () => {
	it.skipIf(!liveEnabled)("runs only with explicit opt-in and EXA_API_KEY", async () => {
		const provider = createExaProvider({ apiKey: process.env.EXA_API_KEY });
		const result = await provider.search(
			{ query: "music production synthesizer", maxResults: 3 },
			new AbortController().signal,
			{},
		);
		expect(result.provider).toBe("exa");
		expect(result.results.length).toBeLessThanOrEqual(3);
	});
});
