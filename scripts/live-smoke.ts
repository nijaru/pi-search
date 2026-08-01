import { BraveQuotaTracker, createBraveProvider } from "../src/brave";
import { createExaProvider } from "../src/exa";
import { createGeminiProvider } from "../src/gemini";
import { createOpenAIProvider } from "../src/openai";
import { createParallelProvider } from "../src/parallel";
import { executeSearch } from "../src/search";
import { createXProvider } from "../src/x";
import { createXAIProvider } from "../src/xai";
import type { Provider, ProviderContext, ProviderModel, SearchRequest, SearchResponse } from "../src/contracts";

const LIVE_QUERY = "IANA protocol parameters";
const LIVE_DOMAIN = "iana.org";
const LIVE_MAX_RESULTS = 3;
const LIVE_TIMEOUT_MS = 30_000;
const PROVIDERS = ["openai", "openai-codex", "gemini", "xai", "xai-x", "x", "brave", "exa", "parallel"] as const;
type SmokeProvider = (typeof PROVIDERS)[number];

function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value === undefined || value.length === 0 ? undefined : value;
}

function required(name: string): string {
	const value = env(name);
	if (value === undefined) throw new Error(`${name} is not configured`);
	return value;
}

function selectedProvider(): SmokeProvider {
	const argument = process.argv.slice(2).find((value) => value.startsWith("--provider="))?.slice("--provider=".length);
	const value = argument ?? env("PI_SEARCH_LIVE_PROVIDER");
	if (value === undefined || !PROVIDERS.includes(value as SmokeProvider)) {
		throw new Error(`Select exactly one provider with --provider=<id> or PI_SEARCH_LIVE_PROVIDER. Valid ids: ${PROVIDERS.join(", ")}`);
	}
	return value as SmokeProvider;
}

function isDryRun(): boolean {
	return process.argv.includes("--dry-run");
}

export function modelBaseUrlForProvider(provider: string): string {
	if (provider === "openai-codex") return "https://chatgpt.com/backend-api";
	if (provider === "xai") return "https://api.x.ai/v1";
	if (provider === "google") return "https://generativelanguage.googleapis.com/v1beta";
	return "https://api.openai.com/v1";
}

function modelContext(provider: string, api: string, modelId: string, apiKey: string): ProviderContext {
	const model: ProviderModel = {
		id: modelId,
		provider,
		api,
		baseUrl: modelBaseUrlForProvider(provider),
	};
	return {
		model,
		modelRegistry: {
			getModels: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey }),
		},
	};
}

function providerFor(id: SmokeProvider): { readonly provider: Provider; readonly context: ProviderContext; readonly secret: string; readonly requiredEnv: readonly string[] } {
	switch (id) {
		case "openai": {
			const key = required("PI_SEARCH_LIVE_OPENAI_API_KEY");
			const model = required("PI_SEARCH_LIVE_OPENAI_MODEL");
			return { provider: createOpenAIProvider({ provider: "openai" }), context: modelContext("openai", "openai-responses", model, key), secret: key, requiredEnv: ["PI_SEARCH_LIVE_OPENAI_API_KEY", "PI_SEARCH_LIVE_OPENAI_MODEL"] };
		}
		case "openai-codex": {
			const token = required("PI_SEARCH_LIVE_CODEX_TOKEN");
			const model = required("PI_SEARCH_LIVE_CODEX_MODEL");
			return { provider: createOpenAIProvider({ provider: "openai-codex" }), context: modelContext("openai-codex", "openai-codex-responses", model, token), secret: token, requiredEnv: ["PI_SEARCH_LIVE_CODEX_TOKEN", "PI_SEARCH_LIVE_CODEX_MODEL"] };
		}
		case "gemini": {
			const key = required("PI_SEARCH_LIVE_GEMINI_API_KEY");
			const model = required("PI_SEARCH_LIVE_GEMINI_MODEL");
			return { provider: createGeminiProvider(), context: modelContext("google", "google-generative-ai", model, key), secret: key, requiredEnv: ["PI_SEARCH_LIVE_GEMINI_API_KEY", "PI_SEARCH_LIVE_GEMINI_MODEL"] };
		}
		case "xai":
		case "xai-x": {
			const key = required("PI_SEARCH_LIVE_XAI_API_KEY");
			const model = required("PI_SEARCH_LIVE_XAI_MODEL");
			const tool = id === "xai-x" ? "x_search" : "web_search";
			return { provider: createXAIProvider({ tool }), context: modelContext("xai", "openai-responses", model, key), secret: key, requiredEnv: ["PI_SEARCH_LIVE_XAI_API_KEY", "PI_SEARCH_LIVE_XAI_MODEL"] };
		}
		case "x": {
			const token = required("PI_SEARCH_LIVE_X_API_BEARER_TOKEN");
			return { provider: createXProvider({ bearerToken: token }), context: {}, secret: token, requiredEnv: ["PI_SEARCH_LIVE_X_API_BEARER_TOKEN"] };
		}
		case "brave": {
			const key = required("PI_SEARCH_LIVE_BRAVE_API_KEY");
			return { provider: createBraveProvider({ apiKey: key, capacityTracker: new BraveQuotaTracker() }), context: {}, secret: key, requiredEnv: ["PI_SEARCH_LIVE_BRAVE_API_KEY"] };
		}
		case "exa": {
			const key = required("PI_SEARCH_LIVE_EXA_API_KEY");
			return { provider: createExaProvider({ apiKey: key }), context: {}, secret: key, requiredEnv: ["PI_SEARCH_LIVE_EXA_API_KEY"] };
		}
		case "parallel": {
			const key = required("PI_SEARCH_LIVE_PARALLEL_API_KEY");
			return { provider: createParallelProvider({ apiKey: key }), context: {}, secret: key, requiredEnv: ["PI_SEARCH_LIVE_PARALLEL_API_KEY"] };
		}
	}
}

function redacted(value: string, secret: string): string {
	const withoutSecret = secret.length === 0 ? value : value.split(secret).join("[redacted]");
	return withoutSecret
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-token]");
}

function domainMatches(hostname: string, domain: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const expected = domain.toLowerCase().replace(/\.$/, "");
	return host === expected || host.endsWith(`.${expected}`);
}

function assertEvidence(response: SearchResponse, provider: SmokeProvider): void {
	if (response.provider !== provider) throw new Error(`response provider was ${response.provider}, expected ${provider}`);
	if (response.results.length === 0) throw new Error("provider returned no inspectable results");
	if (response.results.length > LIVE_MAX_RESULTS) throw new Error("provider exceeded maxResults");
	for (const result of response.results) {
		const url = new URL(result.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("provider returned a non-HTTP source URL");
		if (url.username || url.password) throw new Error("provider returned a URL with embedded credentials");
		if (result.url.length > 8_192 || result.searchQuery !== LIVE_QUERY || result.domain !== url.hostname.toLowerCase().replace(/\.$/, "")) {
			throw new Error("provider returned unbounded or inconsistent normalized evidence");
		}
		if (["openai", "openai-codex", "xai", "brave", "exa"].includes(provider) && !domainMatches(url.hostname, LIVE_DOMAIN)) {
			throw new Error(`${provider} returned a result outside the requested ${LIVE_DOMAIN} domain`);
		}
	}
}

function printDryRun(provider: SmokeProvider): void {
	const requiredEnv = provider === "openai" ? ["PI_SEARCH_LIVE_OPENAI_API_KEY", "PI_SEARCH_LIVE_OPENAI_MODEL"]
		: provider === "openai-codex" ? ["PI_SEARCH_LIVE_CODEX_TOKEN", "PI_SEARCH_LIVE_CODEX_MODEL"]
			: provider === "gemini" ? ["PI_SEARCH_LIVE_GEMINI_API_KEY", "PI_SEARCH_LIVE_GEMINI_MODEL"]
				: provider === "xai" || provider === "xai-x" ? ["PI_SEARCH_LIVE_XAI_API_KEY", "PI_SEARCH_LIVE_XAI_MODEL"]
					: provider === "x" ? ["PI_SEARCH_LIVE_X_API_BEARER_TOKEN"]
						: [`PI_SEARCH_LIVE_${provider.toUpperCase()}_API_KEY`];
	console.log(JSON.stringify({
		provider,
		liveOptIn: env("PI_SEARCH_LIVE") === "1",
		meteredOptIn: env("PI_SEARCH_LIVE_ALLOW_METERED") === "1",
		required: Object.fromEntries(requiredEnv.map((name) => [name, env(name) !== undefined])),
		query: LIVE_QUERY,
		maxResults: LIVE_MAX_RESULTS,
		domainFilter: ["openai", "openai-codex", "xai", "brave", "exa"].includes(provider),
	}, null, 2));
}

async function main(): Promise<void> {
	if (env("PI_SEARCH_LIVE") !== "1") throw new Error("Live smoke is disabled; set PI_SEARCH_LIVE=1 explicitly");
	const providerId = selectedProvider();
	if (isDryRun()) {
		printDryRun(providerId);
		return;
	}
	if (env("PI_SEARCH_LIVE_ALLOW_METERED") !== "1") throw new Error("Live smoke requires PI_SEARCH_LIVE_ALLOW_METERED=1 because providers may bill per request");
	const selected = providerFor(providerId);
	const request: SearchRequest = {
		query: LIVE_QUERY,
		maxResults: LIVE_MAX_RESULTS,
		...( ["openai", "openai-codex", "xai", "brave", "exa"].includes(providerId) ? { domains: { include: [LIVE_DOMAIN] } } : {}),
	};
	const response = await executeSearch(selected.provider, request, { timeoutMs: LIVE_TIMEOUT_MS, context: selected.context });
	assertEvidence(response, providerId);
	console.log(JSON.stringify({
		status: "PASS",
		provider: response.provider,
		results: response.results.map((result) => ({ url: result.url, title: result.title, domain: result.domain, publishedAt: result.publishedAt })),
		warnings: response.warnings.map((warning) => warning.code),
		requestId: response.requestId,
		usage: response.usage,
	}, null, 2));
}

function secretFor(provider: string): string {
	const name = provider === "openai-codex" ? "PI_SEARCH_LIVE_CODEX_TOKEN"
		: provider === "openai" ? "PI_SEARCH_LIVE_OPENAI_API_KEY"
			: provider === "gemini" ? "PI_SEARCH_LIVE_GEMINI_API_KEY"
				: provider === "xai" || provider === "xai-x" ? "PI_SEARCH_LIVE_XAI_API_KEY"
					: provider === "x" ? "PI_SEARCH_LIVE_X_API_BEARER_TOKEN"
						: provider === "brave" ? "PI_SEARCH_LIVE_BRAVE_API_KEY"
						: provider === "exa" ? "PI_SEARCH_LIVE_EXA_API_KEY"
							: provider === "parallel" ? "PI_SEARCH_LIVE_PARALLEL_API_KEY" : "";
	return env(name) ?? "";
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		const provider = process.argv.find((value) => value.startsWith("--provider="))?.slice("--provider=".length) ?? env("PI_SEARCH_LIVE_PROVIDER") ?? "unknown";
		const secret = secretFor(provider);
		const message = error instanceof Error ? error.message : String(error);
		console.error(JSON.stringify({ status: "FAIL", provider, error: redacted(message, secret) }, null, 2));
		process.exitCode = 1;
	}
}
