import { describe, expect, it } from "bun:test";
import { WebResearchParameters } from "./research-tool";
import {
	adaptLocalLlamaPayload,
	isLocalOpenAICompatibleModel,
	LLAMA_SAFE_NESTED_MAX_LENGTH,
} from "./local-llama-compat";

function researchSchema(): Record<string, any> {
	return WebResearchParameters as Record<string, any>;
}

function queryItemSchema(): Record<string, any> {
	return researchSchema().properties.queries.items;
}

describe("local llama schema compatibility", () => {
	it("identifies local OpenAI-compatible endpoints without matching hosted providers", () => {
		expect(isLocalOpenAICompatibleModel({ api: "openai-completions", baseUrl: "http://fedora:8080/v1" })).toBe(true);
		expect(isLocalOpenAICompatibleModel({ api: "openai-completions", baseUrl: "http://localhost:11434/v1" })).toBe(true);
		expect(isLocalOpenAICompatibleModel({ api: "openai-completions", baseUrl: "http://[::1]:8080/v1" })).toBe(true);
		expect(isLocalOpenAICompatibleModel({ api: "openai-completions", baseUrl: "https://api.openai.com/v1" })).toBe(false);
		expect(isLocalOpenAICompatibleModel({ api: "openai-completions", baseUrl: "https://llama-cloud.example/v1" })).toBe(false);
		expect(isLocalOpenAICompatibleModel({ api: "anthropic-messages", baseUrl: "http://localhost:8080" })).toBe(false);
	});

	it("rewrites only web_research query bounds in chat-completions tool payloads", () => {
		const payload = {
			model: "qwen3.6:27b",
			tools: [{ type: "function", function: { name: "web_research", description: "d", parameters: researchSchema() } }],
		};
		const adapted = adaptLocalLlamaPayload(payload) as typeof payload;
		expect(adapted).not.toBe(payload);
		expect(adapted.tools[0]!.function.parameters.properties.queries.items.maxLength).toBe(LLAMA_SAFE_NESTED_MAX_LENGTH);
		expect(adapted.tools[0]!.function.parameters.properties.question.maxLength).toBe(2_000);
		expect(queryItemSchema().maxLength).toBe(2_000);
	});

	it("rewrites responses-style tools and leaves unrelated tools unchanged", () => {
		const researchPayload = {
			tools: [{ type: "function", name: "web_research", parameters: researchSchema() }],
		};
		const adapted = adaptLocalLlamaPayload(researchPayload) as typeof researchPayload;
		expect(adapted.tools[0]!.parameters.properties.queries.items.maxLength).toBe(LLAMA_SAFE_NESTED_MAX_LENGTH);

		const unrelatedPayload = {
			tools: [{ type: "function", name: "other_tool", parameters: researchSchema() }],
		};
		expect(adaptLocalLlamaPayload(unrelatedPayload)).toBe(unrelatedPayload);
	});

	it("does not rewrite payloads that are already below the llama.cpp threshold", () => {
		const schema = structuredClone(researchSchema());
		schema.properties.queries.items.maxLength = LLAMA_SAFE_NESTED_MAX_LENGTH;
		const payload = { tools: [{ type: "function", name: "web_research", parameters: schema }] };
		expect(adaptLocalLlamaPayload(payload)).toBe(payload);
	});
});
