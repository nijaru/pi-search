import { describe, expect, it } from "bun:test";
import { searchPreferences } from "./settings";

describe("installation search preferences", () => {
	it("defaults to active-provider routing and automatic fallback, with no batch tool", () => {
		expect(searchPreferences({})).toEqual({ primary: undefined, fallbacks: undefined, executionModel: undefined, researchEnabled: false });
		expect(searchPreferences({ PI_SEARCH_PROVIDER: "auto" }).primary).toBeUndefined();
	});
	it("captures an ordered fallback allowlist and an optional model pin", () => {
		const env = { PI_SEARCH_PROVIDER: " openai-codex ", PI_SEARCH_MODEL: " search-model ", PI_SEARCH_FALLBACK_PROVIDERS: " exa,deepseek,brave ", PI_SEARCH_ENABLE_RESEARCH: "1" };
		const preferences = searchPreferences(env);
		env.PI_SEARCH_PROVIDER = "openai";
		expect(preferences).toEqual({ primary: "openai-codex", executionModel: "search-model", fallbacks: ["exa", "deepseek", "brave"], researchEnabled: true });
		expect(searchPreferences({ PI_SEARCH_FALLBACK_PROVIDERS: "" }).fallbacks).toEqual([]);
	});
	it.each([
		{ PI_SEARCH_PROVIDER: "native" }, { PI_SEARCH_PROVIDER: "" }, { PI_SEARCH_PROVIDER: "unknown" },
		{ PI_SEARCH_FALLBACK_PROVIDERS: "auto" }, { PI_SEARCH_FALLBACK_PROVIDERS: "native" },
		{ PI_SEARCH_FALLBACK_PROVIDERS: "exa,,brave" }, { PI_SEARCH_FALLBACK_PROVIDERS: "exa,exa" },
		{ PI_SEARCH_MODEL: "model" }, { PI_SEARCH_PROVIDER: "auto", PI_SEARCH_MODEL: "model" },
		{ PI_SEARCH_PROVIDER: "openai", PI_SEARCH_MODEL: "" }, { PI_SEARCH_PROVIDER: "openai", PI_SEARCH_MODEL: "m".repeat(501) },
		{ PI_SEARCH_ENABLE_RESEARCH: "true" },
	])("rejects invalid configuration before tool registration: %j", env => {
		expect(() => searchPreferences(env)).toThrow(/PI_SEARCH_/);
	});
});
