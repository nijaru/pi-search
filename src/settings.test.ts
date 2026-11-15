import { describe, expect, it } from "bun:test";
import { searchPreferences } from "./settings";

describe("installation search preferences", () => {
	it("defaults to automatic Codex-first routing, no fallback, and no batch tool", () => {
		expect(searchPreferences({})).toEqual({ primary: undefined, fallback: undefined, executionModel: undefined, researchEnabled: false });
		expect(searchPreferences({ PI_SEARCH_PROVIDER: "auto" }).primary).toBeUndefined();
	});
	it("captures explicit backend and search-model preferences without any chat state", () => {
		const env = { PI_SEARCH_PROVIDER: " openai-codex ", PI_SEARCH_MODEL: " search-model ", PI_SEARCH_FALLBACK_PROVIDER: "exa", PI_SEARCH_ENABLE_RESEARCH: "1" };
		const preferences = searchPreferences(env);
		env.PI_SEARCH_PROVIDER = "openai";
		expect(preferences).toEqual({ primary: "openai-codex", executionModel: "search-model", fallback: "exa", researchEnabled: true });
	});
	it.each([
		{ PI_SEARCH_PROVIDER: "native" }, { PI_SEARCH_PROVIDER: "" }, { PI_SEARCH_PROVIDER: "unknown" },
		{ PI_SEARCH_FALLBACK_PROVIDER: "auto" }, { PI_SEARCH_FALLBACK_PROVIDER: "native" },
		{ PI_SEARCH_MODEL: "model" }, { PI_SEARCH_PROVIDER: "auto", PI_SEARCH_MODEL: "model" },
		{ PI_SEARCH_PROVIDER: "openai", PI_SEARCH_MODEL: "" }, { PI_SEARCH_PROVIDER: "openai", PI_SEARCH_MODEL: "m".repeat(501) },
		{ PI_SEARCH_ENABLE_RESEARCH: "true" },
	])("rejects invalid configuration before tool registration: %j", env => {
		expect(() => searchPreferences(env)).toThrow(/PI_SEARCH_/);
	});
});
