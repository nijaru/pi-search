import { describe, expect, it } from "bun:test";
import { availableProviderHints, type ProviderHintAvailability } from "./provider-availability";
import { createWebSearchTool } from "./search-tool";
import { createWebResearchTool } from "./research-tool";
import type { Provider } from "./contracts";

describe("provider hint availability", () => {
	it("exposes native grounding ids plus only configured direct providers", () => {
		const hints = availableProviderHints({ brave: true, exa: false, parallel: true, parallelResponses: true, braveAnswers: false, x: false });
		expect(hints).toEqual(["openai", "openai-codex", "gemini", "brave", "parallel", "parallel-responses", "xai", "xai-x", "anthropic", "meta"]);
	});

	it("exposes every native id even with no direct providers configured", () => {
		const hints = availableProviderHints({});
		expect(hints).toEqual(["openai", "openai-codex", "gemini", "xai", "xai-x", "anthropic", "meta"]);
	});

	it("omits synthesis providers when their gates are off", () => {
		const hints = availableProviderHints({ parallel: true, parallelResponses: false, brave: true, braveAnswers: false });
		expect(hints).toContain("parallel");
		expect(hints).not.toContain("parallel-responses");
		expect(hints).toContain("brave");
		expect(hints).not.toContain("brave-answers");
	});

	it("keeps the full provider enum when no availability is supplied", () => {
		const provider: Provider = {
			id: "brave",
			capabilities: {},
			profile: { auth: "none", costModel: "free" },
			search: async () => { throw new Error("not called"); },
		};
		const full = createWebSearchTool(provider);
		const providerProperty = ((full.parameters as unknown as { properties: Record<string, unknown> }).properties.provider) as { enum: readonly string[] };
		expect(providerProperty.enum).toContain("parallel-responses");
		expect(providerProperty.enum).toContain("brave-answers");
	});

	it("narrows the web_search provider enum to available hints", () => {
		const provider: Provider = {
			id: "brave",
			capabilities: {},
			profile: { auth: "none", costModel: "free" },
			search: async () => { throw new Error("not called"); },
		};
		const tool = createWebSearchTool(provider, { availableProviderHints: availableProviderHints({ brave: true }) });
		const providerProperty = ((tool.parameters as unknown as { properties: Record<string, unknown> }).properties.provider) as { enum: readonly string[] };
		expect(providerProperty.enum).toContain("native");
		expect(providerProperty.enum).toContain("brave");
		expect(providerProperty.enum).not.toContain("exa");
		expect(providerProperty.enum).not.toContain("parallel-responses");
		expect(providerProperty.enum).not.toContain("brave-answers");
	});

	it("narrows the web_research provider enum to available hints", () => {
		const resolver = () => ({
			id: "brave",
			capabilities: {},
			profile: { auth: "none", costModel: "free" },
			search: async () => { throw new Error("not called"); },
		}) as unknown as ReturnType<() => Provider>;
		const tool = createWebResearchTool(resolver as never, { availableProviderHints: availableProviderHints({ exa: true }) });
		const providerProperty = ((tool.parameters as unknown as { properties: Record<string, unknown> }).properties.provider) as { enum: readonly string[] };
		expect(providerProperty.enum).toContain("exa");
		expect(providerProperty.enum).not.toContain("brave");
		expect(providerProperty.enum).not.toContain("brave-answers");
	});

	it("availability object shape stays provider-boolean only", () => {
		const sample: ProviderHintAvailability = { brave: true, exa: true };
		expect(Object.keys(sample).every((key) => typeof (sample as Record<string, unknown>)[key] === "boolean")).toBe(true);
	});
});
