import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderModel,
	ProviderProfile,
	SearchOption,
	SearchRequest,
	SearchResponse,
	SearchResult,
	SearchWarning,
} from "./contracts";
import { createProviderError } from "./errors";
import { httpSource, objectValue, optionalString, postJson, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

export const GEMINI_GENERATE_CONTENT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface GeminiAdapterOptions {
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = {
	freshness: true,
	semantic: true,
	excerpts: true,
	nativeGrounding: true,
};

const profile: ProviderProfile = {
	auth: "modelRegistry",
	costModel: "usage-based",
};

export interface GeminiRequestPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

export function buildGeminiRequest(request: SearchRequest): GeminiRequestPlan {
	const normalized = validateSearchRequest(request);
	if (normalized.domains?.include?.length || normalized.domains?.exclude?.length) {
		throw createProviderError({ provider: "gemini", kind: "unsupported", message: "Gemini grounding does not expose hard domain filters", retryable: false });
	}
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "keyword") {
		warnings.push({ code: "unsupported-option", option: "mode", message: "Gemini grounding uses semantic retrieval rather than keyword-only ranking" });
	}
	if (normalized.mode === "fresh") {
		warnings.push({ code: "unsupported-option", option: "mode", message: "Gemini grounding can use current sources but does not guarantee a freshness-only ranking" });
	}
	return {
		body: {
			contents: [{ role: "user", parts: [{ text: normalized.mode === "fresh" ? `Prefer current sources. ${normalized.query}` : normalized.query }] }],
			tools: [{ google_search: {} }],
			generationConfig: { maxOutputTokens: 512 },
		},
		appliedOptions: ["maxResults", "mode"],
		warnings,
	};
}

function endpointFor(model: ProviderModel, override?: string): string {
	const base = (override ?? (model.baseUrl.trim().length > 0 ? model.baseUrl : GEMINI_GENERATE_CONTENT_ENDPOINT)).replace(/\/+$/, "");
	if (base.endsWith(":generateContent")) return base;
	return `${base}/models/${encodeURIComponent(model.id)}:generateContent`;
}

async function authHeaders(context: ProviderContext): Promise<Readonly<Record<string, string>>> {
	const model = context.model;
	if (model === undefined || model.provider !== "google" || model.api !== "google-generative-ai") {
		throw createProviderError({ provider: "gemini", kind: "unsupported", message: "Active Pi model is not a Gemini model", retryable: false });
	}
	if (context.modelRegistry === undefined) {
		throw createProviderError({ provider: "gemini", kind: "auth", message: "Pi model authentication is unavailable", retryable: false });
	}
	let auth;
	try {
		auth = await context.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error) {
		throw createProviderError({ provider: "gemini", kind: "auth", message: "Pi model authentication could not be resolved", retryable: false, cause: error });
	}
	if (!auth.ok) throw createProviderError({ provider: "gemini", kind: "auth", message: "Pi model authentication is not configured", retryable: false });
	const headers: Record<string, string> = { ...(model.headers ?? {}), ...(auth.headers ?? {}) };
	if (auth.apiKey !== undefined && auth.apiKey.trim().length > 0) headers["x-goog-api-key"] = auth.apiKey;
	if (headers["x-goog-api-key"] === undefined && headers["X-Goog-Api-Key"] === undefined) {
		throw createProviderError({ provider: "gemini", kind: "auth", message: "Gemini authentication returned no API key", retryable: false });
	}
	return headers;
}

function normalizeGeminiResponse(payload: unknown, request: SearchRequest): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "gemini");
	const promptFeedback = root.promptFeedback;
	if (promptFeedback !== undefined) {
		const feedback = objectValue(promptFeedback, "promptFeedback", "gemini");
		const blockReason = optionalString(feedback.blockReason);
		if (blockReason !== undefined) {
			throw createProviderError({ provider: "gemini", kind: "http", message: `Gemini grounding was blocked (${blockReason})`, retryable: false });
		}
	}
	if (!Array.isArray(root.candidates)) {
		throw createProviderError({ provider: "gemini", kind: "malformed", message: "Gemini returned no candidates array", retryable: false });
	}
	const results: SearchResult[] = [];
	const maxResults = normalized.maxResults ?? 10;
	const seen = new Set<string>();
	const warnings: SearchWarning[] = [];
	let discarded = 0;
	for (const candidateValue of root.candidates) {
		const candidate = objectValue(candidateValue, "candidates[]", "gemini");
		const finishReason = optionalString(candidate.finishReason);
		if (finishReason !== undefined && finishReason !== "STOP" && finishReason !== "UNSPECIFIED") {
			warnings.push({ code: "partial-results", message: `Gemini grounding candidate finished with ${finishReason}` });
		}
		const metadata = candidate.groundingMetadata;
		if (metadata === undefined) continue;
		const grounding = objectValue(metadata, "groundingMetadata", "gemini");
		if (!Array.isArray(grounding.groundingChunks)) continue;
		for (const chunkValue of grounding.groundingChunks) {
			const chunk = objectValue(chunkValue, "groundingChunks[]", "gemini");
			const web = chunk.web;
			if (web === undefined) continue;
			const source = objectValue(web, "groundingChunks[].web", "gemini");
			const parsed = httpSource(source.uri ?? source.url, "gemini");
			if (parsed === undefined) {
				discarded += 1;
				continue;
			}
			if (seen.has(parsed.url)) continue;
			seen.add(parsed.url);
			results.push({
				url: parsed.url,
				title: optionalString(source.title, 500),
				domain: parsed.domain,
				provider: "gemini",
				searchQuery: normalized.query,
			});
			if (results.length >= maxResults) break;
		}
		if (results.length >= maxResults) break;
	}
	if (discarded > 0 && results.length === 0) {
		throw createProviderError({ provider: "gemini", kind: "malformed", message: "Gemini returned no parseable grounding URLs", retryable: false });
	}
	if (discarded > 0) warnings.push({ code: "partial-results", message: `Gemini discarded ${discarded} malformed grounding entr${discarded === 1 ? "y" : "ies"}` });
	const usage = root.usageMetadata;
	const usageRecord = usage === undefined ? undefined : objectValue(usage, "usageMetadata", "gemini");
	const billedUnits = typeof usageRecord?.totalTokenCount === "number" && Number.isFinite(usageRecord.totalTokenCount) ? usageRecord.totalTokenCount : undefined;
	return {
		query: normalized.query,
		results,
		provider: "gemini",
		appliedOptions: [],
		warnings,
		...(billedUnits === undefined ? {} : { usage: { billedUnits, billedUnit: "tokens" } }),
	};
}

export class GeminiProvider implements Provider {
	readonly id = "gemini" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly endpoint?: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: GeminiAdapterOptions = {}) {
		this.endpoint = options.endpoint;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_GEMINI_RESPONSE_BYTES;
	}

	async search(request: SearchRequest, signal: AbortSignal, context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildGeminiRequest(normalized);
		const model = context.model;
		if (model === undefined || model.provider !== "google" || model.api !== "google-generative-ai") {
			throw createProviderError({ provider: this.id, kind: "unsupported", message: "Active Pi model is not a Gemini model", retryable: false });
		}
		if (signal.aborted) throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false });
		const result = await postJson({
			provider: this.id,
			url: endpointFor(model, this.endpoint),
			headers: await authHeaders(context),
			body: plan.body,
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeGeminiResponse(result.payload, normalized);
		return { ...response, appliedOptions: plan.appliedOptions, warnings: [...plan.warnings, ...response.warnings] };
	}
}

export function createGeminiProvider(options: GeminiAdapterOptions = {}): GeminiProvider {
	return new GeminiProvider(options);
}
