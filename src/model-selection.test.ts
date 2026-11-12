import { describe, expect, it } from "bun:test";
import type { ProviderAuthResult, ProviderContext } from "./contracts";
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
	it("marks unavailable model selection safe before dispatch", async () => {
		const context: ProviderContext = { modelRegistry: { getModels: () => [], getApiKeyAndHeaders: async () => { throw new Error("must not authenticate"); } } };
		for (const request of [{ query: "q" }, { query: "q", executionModel: "missing" }]) {
			await expect(selectModelExecution({ ...options(), context, request, allowRegistryFallback: true })).rejects.toMatchObject({ kind: "unsupported", fallbackSafe: true });
		}
	});

	it("preserves keyless routing, environment, and explicit header decisions end to end", async () => {
		for (const authorization of ["Bearer workload", null] as const) {
			const auth = {
				ok: true as const,
				baseUrl: "https://workload.example/v1",
				headers: { Authorization: authorization, "x-disabled": null },
				env: { WORKLOAD_IDENTITY: "identity" },
			};
			const model = { ...catalogModel, headers: { authorization: "Bearer catalog", "x-disabled": "default" } };
			const context = providerContextFromPi({
				model,
				modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => auth },
			} as never);
			const execution = await selectModelExecution({ ...options(), context });
			expect(execution.auth).toEqual(auth);
			expect(execution.model.baseUrl).toBe(auth.baseUrl);
			expect(model.baseUrl).toBe(catalogModel.baseUrl);
			expect(modelAuthHeaders(execution).get("authorization")).toBe(authorization);
			expect(modelAuthHeaders(execution).get("x-disabled")).toBeNull();
		}
	});

	it("uses the auth-resolved base URL over the catalog base URL", async () => {
		const execution = await selectModelExecution(options("https://proxy.example/v1"));
		expect(execution.model.baseUrl).toBe("https://proxy.example/v1");
		expect(execution.auth.baseUrl).toBe("https://proxy.example/v1");
	});

	it("keeps the catalog base URL when auth resolves none", async () => {
		const execution = await selectModelExecution(options());
		expect(execution.model.baseUrl).toBe(catalogModel.baseUrl);
	});

	it("keeps generic registry order and stops on active or explicit authentication failure", async () => {
		const first = { ...catalogModel, id: "first" };
		const second = { ...catalogModel, id: "second" };
		const third = { ...catalogModel, id: "third" };
		const calls: string[] = [];
		const context: ProviderContext = {
			modelRegistry: {
				getModels: () => [first, second, third],
				getApiKeyAndHeaders: async (model): Promise<ProviderAuthResult> => {
					calls.push(model.id);
					if (model.id === "first") throw new Error("resolver failed");
					if (model.id === "second") return { ok: false, error: "unavailable" };
					return { ok: true, headers: { authorization: "Bearer third" }, baseUrl: "https://third.example/v1" };
				},
			},
		};
		const selection = { ...options(), context, allowRegistryFallback: true };
		expect((await selectModelExecution(selection)).model.baseUrl).toBe("https://third.example/v1");
		expect(calls).toEqual(["first", "second", "third"]);
		calls.length = 0;
		await expect(selectModelExecution({ ...selection, context: { ...context, model: first } })).rejects.toMatchObject({ kind: "auth", fallbackSafe: true });
		expect(calls).toEqual(["first"]);
		calls.length = 0;
		await expect(selectModelExecution({ ...selection, request: { query: "q", executionModel: "second" } })).rejects.toMatchObject({ kind: "auth", message: "Pi model authentication is not configured for second" });
		expect(calls).toEqual(["second"]);
	});

	it("forwards resolved base URL and env through the tool-boundary shim", async () => {
		const providerContext = providerContextFromPi(authContext("https://proxy.example/v1", { FOO: "bar" }) as never);
		const resolved = await providerContext.modelRegistry!.getApiKeyAndHeaders(catalogModel);
		expect(resolved).toEqual({ ok: true, apiKey: "secret", baseUrl: "https://proxy.example/v1", env: { FOO: "bar" } });
	});
});
