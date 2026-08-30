import { describe, expect, it } from "bun:test";
import { modelBaseUrlForProvider } from "./live-smoke";

describe("live smoke model contexts", () => {
	it("uses the ChatGPT backend for Codex rather than the OpenAI API", () => {
		expect(modelBaseUrlForProvider("openai-codex")).toBe("https://chatgpt.com/backend-api/codex");
		expect(modelBaseUrlForProvider("openai-codex")).not.toContain("api.openai.com");
	});

	it("keeps provider API bases distinct", () => {
		expect(modelBaseUrlForProvider("openai")).toBe("https://api.openai.com/v1");
		expect(modelBaseUrlForProvider("xai")).toBe("https://api.x.ai/v1");
		expect(modelBaseUrlForProvider("google")).toBe("https://generativelanguage.googleapis.com/v1beta");
	});
});
