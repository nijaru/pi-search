import { describe, expect, it } from "bun:test";
import extension from "./index";

describe("extension registration", () => {
	it("registers exactly the three public tools", () => {
		const names: string[] = [];
		extension({
			on() {},
			registerTool(tool: { name: string }) { names.push(tool.name); },
		} as never);
		expect(names).toEqual(["web_search", "web_fetch", "web_research"]);
	});

	it("registers the local llama schema compatibility hook", () => {
		let beforeProviderRequest: ((event: unknown, context: unknown) => unknown) | undefined;
		extension({
			on(event: string, handler: (event: unknown, context: unknown) => unknown) {
				if (event === "before_provider_request") beforeProviderRequest = handler;
			},
			registerTool() {},
		} as never);
		const schema = {
			type: "object",
			properties: {
			queries: { type: "array", items: { type: "string", maxLength: 2_000 } },
			},
		};
		const payload = { tools: [{ type: "function", name: "web_research", parameters: schema }] };
		const adapted = beforeProviderRequest?.({ payload }, { model: { api: "openai-completions", provider: "fedora", baseUrl: "http://fedora:8080/v1" } }) as typeof payload;
		expect(adapted.tools[0]!.parameters.properties.queries.items.maxLength).toBe(1_999);
		const hostedPayload = { tools: [{ type: "function", name: "web_research", parameters: schema }] };
		expect(beforeProviderRequest?.({ payload: hostedPayload }, { model: { api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1" } })).toBeUndefined();
	});
});
