import { describe, expect, it } from "bun:test";
import type { ModelExecution } from "./model-selection";
import { modelAuthHeaders, selectModelExecution } from "./model-selection";
import { providerContextFromPi } from "./search-tool";

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

const catalogModel = { provider: "openai", id: "gpt-test", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };

function authContext(baseUrl?: string, env?: Record<string, string>) {
	return {
		model: catalogModel,
		modelRegistry: {
			getModels: () => [catalogModel],
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: "secret",
				...(baseUrl === undefined ? {} : { baseUrl }),
				...(env === undefined ? {} : { env }),
			}),
		},
	} as never;
}

function options(baseUrl?: string, env?: Record<string, string>) {
	return {
		searchProvider: "openai",
		modelProvider: "openai",
		api: "openai-responses",
		request: { query: "test" } as never,
		context: authContext(baseUrl, env),
	};
}

describe("resolved endpoint routing", () => {
	it("uses the auth-resolved base URL over the catalog base URL", async () => {
		const execution = await selectModelExecution(options("https://proxy.example/v1"));
		expect(execution.model.baseUrl).toBe("https://proxy.example/v1");
		expect(execution.auth.baseUrl).toBe("https://proxy.example/v1");
	});

	it("keeps the catalog base URL when auth resolves none", async () => {
		const execution = await selectModelExecution(options());
		expect(execution.model.baseUrl).toBe(catalogModel.baseUrl);
	});

	it("forwards resolved base URL and env through the tool-boundary shim", async () => {
		const providerContext = providerContextFromPi(authContext("https://proxy.example/v1", { FOO: "bar" }) as never);
		const resolved = await providerContext.modelRegistry!.getApiKeyAndHeaders(catalogModel);
		expect(resolved).toEqual({ ok: true, apiKey: "secret", baseUrl: "https://proxy.example/v1", env: { FOO: "bar" } });
	});
});
