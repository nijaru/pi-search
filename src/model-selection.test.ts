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

describe("model authentication headers", () => {
	it("treats null values as header deletions", () => {
		const headers = modelAuthHeaders(execution());

		expect(headers.get("x-model-default")).toBe("model");
		expect(headers.get("x-auth")).toBe("auth");
		expect(headers.get("x-disabled")).toBeNull();
	});
});
