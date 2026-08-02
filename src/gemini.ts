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
import { selectModelExecution, modelAuthHeaders, type ModelExecution } from "./model-selection";
import { validateSearchRequest } from "./search";

export const GEMINI_GENERATE_CONTENT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_GEMINI_ANSWER_LENGTH = 8_000;

export interface GeminiAdapterOptions {
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = {
	freshness: true,
	semantic: true,
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
	if (normalized.dateRange !== undefined || normalized.social !== undefined) {
		throw createProviderError({ provider: "gemini", kind: "unsupported", message: "Gemini grounding does not expose exact date-range or dedicated social/X constraints", retryable: false });
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

function authHeaders(execution: ModelExecution): Readonly<Record<string, string>> {
	const headers = modelAuthHeaders(execution, { bearerApiKey: false });
	if (execution.auth.apiKey !== undefined && execution.auth.apiKey.trim().length > 0) headers.set("x-goog-api-key", execution.auth.apiKey);
	if (!headers.has("x-goog-api-key")) {
		throw createProviderError({ provider: "gemini", kind: "auth", message: "Gemini authentication returned no API key", retryable: false });
	}
	return Object.fromEntries(headers.entries());
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
	const answerParts: string[] = [];
	const answerCitationUrls = new Set<string>();
	const groundingQueries = new Set<string>();
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
		const content = candidate.content;
		if (content !== null && typeof content === "object" && !Array.isArray(content)) {
			const parts = (content as Record<string, unknown>).parts;
			if (Array.isArray(parts)) {
				for (const part of parts) {
					if (part !== null && typeof part === "object" && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === "string") answerParts.push((part as Record<string, unknown>).text as string);
				}
			}
		}
		const metadata = candidate.groundingMetadata;
		if (metadata === undefined) continue;
		const grounding = objectValue(metadata, "groundingMetadata", "gemini");
		if (Array.isArray(grounding.webSearchQueries)) {
			for (const query of grounding.webSearchQueries) if (typeof query === "string" && query.trim().length > 0) groundingQueries.add(query.trim());
		}
		if (!Array.isArray(grounding.groundingChunks)) continue;
		const chunkUrls: Array<string | undefined> = [];
		for (const chunkValue of grounding.groundingChunks) {
			const chunk = objectValue(chunkValue, "groundingChunks[]", "gemini");
			const web = chunk.web;
			if (web === undefined) {
				chunkUrls.push(undefined);
				continue;
			}
			const source = objectValue(web, "groundingChunks[].web", "gemini");
			const parsed = httpSource(source.uri ?? source.url, "gemini");
			if (parsed === undefined) {
				discarded += 1;
				chunkUrls.push(undefined);
				continue;
			}
			chunkUrls.push(parsed.url);
			if (seen.has(parsed.url)) continue;
			seen.add(parsed.url);
			if (results.length < maxResults) {
				results.push({
					url: parsed.url,
					title: optionalString(source.title, 500),
					domain: parsed.domain,
					provider: "gemini",
					searchQuery: normalized.query,
				});
			}
		}
		if (Array.isArray(grounding.groundingSupports)) {
			for (const supportValue of grounding.groundingSupports) {
				if (supportValue === null || typeof supportValue !== "object" || Array.isArray(supportValue)) continue;
				const indices = (supportValue as Record<string, unknown>).groundingChunkIndices;
				if (!Array.isArray(indices)) continue;
				for (const index of indices) {
					if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
						const url = chunkUrls[index];
						if (url !== undefined) answerCitationUrls.add(url);
					}
				}
			}
		}
	}
	if (results.length === 0) {
		throw createProviderError({ provider: "gemini", kind: "malformed", message: "Gemini returned no parseable grounding URLs", retryable: false });
	}
	if (discarded > 0) warnings.push({ code: "partial-results", message: `Gemini discarded ${discarded} malformed grounding entr${discarded === 1 ? "y" : "ies"}` });
	const usage = root.usageMetadata;
	const usageRecord = usage === undefined ? undefined : objectValue(usage, "usageMetadata", "gemini");
	const inputTokens = typeof usageRecord?.promptTokenCount === "number" && Number.isFinite(usageRecord.promptTokenCount) ? usageRecord.promptTokenCount : undefined;
	const outputTokens = typeof usageRecord?.candidatesTokenCount === "number" && Number.isFinite(usageRecord.candidatesTokenCount) ? usageRecord.candidatesTokenCount : undefined;
	const totalTokens = typeof usageRecord?.totalTokenCount === "number" && Number.isFinite(usageRecord.totalTokenCount) ? usageRecord.totalTokenCount : undefined;
	const answerText = answerParts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_GEMINI_ANSWER_LENGTH);
	const resultByUrl = new Map(results.map((result) => [result.url, result]));
	const citations = [...answerCitationUrls].map((url) => resultByUrl.get(url)).filter((result): result is SearchResult => result !== undefined).map((result) => ({ url: result.url, ...(result.title === undefined ? {} : { title: result.title }) }));
	const answer = normalized.answerMode !== "evidence" && answerText.length > 0 && citations.length > 0
		? { text: answerText, contentTrust: "untrusted" as const, provider: "gemini" as const, citations }
		: undefined;
	const usageDetails = inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && groundingQueries.size === 0
		? undefined
		: {
			...(inputTokens === undefined ? {} : { inputTokens }),
			...(outputTokens === undefined ? {} : { outputTokens }),
			...(totalTokens === undefined ? {} : { totalTokens }),
			...(groundingQueries.size === 0 ? {} : { searchQueries: groundingQueries.size }),
		};
	return {
		query: normalized.query,
		results,
		...(answer === undefined ? {} : { answer }),
		provider: "gemini",
		appliedOptions: [],
		warnings,
		...(usageDetails === undefined ? {} : { usage: usageDetails }),
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
		if (signal.aborted) throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false });
		const execution = await selectModelExecution({ searchProvider: "gemini", modelProvider: "google", api: "google-generative-ai", request: normalized, context });
		if (signal.aborted) throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false });
		const result = await postJson({
			provider: this.id,
			url: endpointFor(execution.model, this.endpoint),
			headers: authHeaders(execution),
			body: plan.body,
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeGeminiResponse(result.payload, normalized);
		const usage = response.usage === undefined && result.rateLimits === undefined
			? undefined
			: { ...response.usage, ...(result.rateLimits === undefined ? {} : { rateLimits: result.rateLimits }) };
		return {
			...response,
			...(response.answer === undefined ? {} : { answer: { ...response.answer, executionModel: execution.model.id } }),
			...(response.requestId === undefined && result.requestId === undefined ? {} : { requestId: response.requestId ?? result.requestId }),
			...(usage === undefined ? {} : { usage }),
			executionModel: execution.model.id,
			appliedOptions: plan.appliedOptions,
			warnings: [...plan.warnings, ...response.warnings],
		};
	}
}

export function createGeminiProvider(options: GeminiAdapterOptions = {}): GeminiProvider {
	return new GeminiProvider(options);
}
