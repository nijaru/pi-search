import { describe, expect, it } from "bun:test";
import type { ModelExecution } from "./model-selection";
import { modelAuthHeaders } from "./model-selection";

function execution(): ModelExecution {
	return {
		model: {
			id: "model",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://example.test/v1",
			headers: {
				"x-model-default": "model",
				"x-disabled": "model-value",
			},
		},
		auth: {
			ok: true,
			headers: {
				"x-disabled": null,
				"x-auth": "auth",
			},
		},
	};
}

function executionWithApiKey(headers: ModelExecution["auth"]["headers"]): ModelExecution {
	return {
		model: { id: "model", provider: "openai", api: "openai-responses", baseUrl: "https://example.test/v1" },
		auth: { ok: true, apiKey: "secret", headers },
	};
}

describe("model authentication headers", () => {
	it("treats null values as header deletions", () => {
		const headers = modelAuthHeaders(execution());

		expect(headers.get("x-model-default")).toBe("model");
		expect(headers.get("x-auth")).toBe("auth");
		expect(headers.get("x-disabled")).toBeNull();
	});

	it("derives a bearer only when no explicit authorization header is declared", () => {
		expect(modelAuthHeaders(executionWithApiKey(undefined)).get("authorization")).toBe("Bearer secret");
		expect(modelAuthHeaders(executionWithApiKey({ authorization: "Bearer explicit" })).get("authorization")).toBe("Bearer explicit");
		expect(modelAuthHeaders(executionWithApiKey({ authorization: null })).get("authorization")).toBeNull();
	});
});
