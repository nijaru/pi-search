import { describe, expect, it } from "bun:test";
import { validateResearchBudget } from "./contracts";

describe("research budgets", () => {
	it("rejects unbounded or invalid values", () => {
		expect(() => validateResearchBudget({ maxSteps: 3, maxProviderCalls: 4, maxFetches: 1, timeoutMs: 10_000, maxOutputChars: 10_000, maxCostUsd: 1 })).not.toThrow();
		expect(() => validateResearchBudget({ maxSteps: 0, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 10_000, maxOutputChars: 10_000 })).toThrow("maxSteps");
		expect(() => validateResearchBudget({ maxSteps: 1, maxProviderCalls: 1, maxFetches: 0, timeoutMs: 0, maxOutputChars: 10_000 })).toThrow("timeoutMs");
	});
});
