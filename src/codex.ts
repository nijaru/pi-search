import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderModel,
	ProviderProfile,
	ProviderUsage,
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

export const CODEX_SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
export const DEFAULT_CODEX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_ANSWER_LENGTH = 8_000;
const MAX_CODEX_SOURCE_LENGTH = 8_192;

export interface CodexAdapterOptions {
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = {
	semantic: true,
	freshness: true,
	excerpts: true,
	domainFilter: true,
	nativeGrounding: true,
	searchContextSize: true,
	externalWebAccess: true,
	userLocation: true,
	searchContentTypes: true,
	imageSettings: true,
};

const profile: ProviderProfile = {
	auth: "modelRegistry",
	costModel: "unknown",
};

export interface CodexRequestPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

function endpointFor(model: ProviderModel, override?: string): string {
	const candidate = override ?? (model.baseUrl.trim().length > 0 ? model.baseUrl : CODEX_SEARCH_ENDPOINT);
	let url: URL;
	try {
		url = new URL(candidate);
	} catch (error) {
		throw createProviderError({ provider: "openai-codex", kind: "badRequest", message: "Codex search endpoint is not a valid URL", retryable: false, cause: error });
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw createProviderError({ provider: "openai-codex", kind: "badRequest", message: "Codex search endpoint must use HTTP or HTTPS", retryable: false });
	}
	const path = url.pathname.replace(/\/+$/, "");
	if (path.endsWith("/alpha/search")) return url.toString();
	const basePath = path.endsWith("/responses") ? path.slice(0, -"/responses".length) : path;
	if (basePath.endsWith("/codex")) url.pathname = `${basePath}/alpha/search`;
	else if (basePath.endsWith("/backend-api")) url.pathname = `${basePath}/codex/alpha/search`;
	else url.pathname = `${basePath}/alpha/search`;
	return url.toString();
}

function userLocation(value: SearchRequest["userLocation"]): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	return {
		type: value.type,
		...(value.country === undefined ? {} : { country: value.country }),
		...(value.region === undefined ? {} : { region: value.region }),
		...(value.city === undefined ? {} : { city: value.city }),
		...(value.timezone === undefined ? {} : { timezone: value.timezone }),
	};
}

function buildSettings(request: SearchRequest): Record<string, unknown> | undefined {
	const filters = {
		...(request.domains?.include?.length ? { allowed_domains: [...request.domains.include] } : {}),
		...(request.domains?.exclude?.length ? { blocked_domains: [...request.domains.exclude] } : {}),
	};
	const imageSettings = request.imageSettings === undefined ? undefined : {
		...(request.imageSettings.maxResults === undefined ? {} : { max_results: request.imageSettings.maxResults }),
		...(request.imageSettings.caption === undefined ? {} : { caption: request.imageSettings.caption }),
	};
	const location = userLocation(request.userLocation);
	const settings = {
		...(request.searchContextSize === undefined ? {} : { search_context_size: request.searchContextSize }),
		...(Object.keys(filters).length === 0 ? {} : { filters }),
		...(location === undefined ? {} : { user_location: location }),
		...(imageSettings === undefined ? {} : { image_settings: imageSettings }),
		...(request.externalWebAccess === undefined ? {} : { external_web_access: request.externalWebAccess }),
	};
	return Object.keys(settings).length === 0 ? undefined : settings;
}

export function buildCodexRequest(request: SearchRequest): CodexRequestPlan {
	const normalized = validateSearchRequest(request);
	if (normalized.dateRange !== undefined || normalized.social !== undefined) {
		throw createProviderError({ provider: "openai-codex", kind: "unsupported", message: "Codex standalone search does not expose exact date-range or dedicated social/X constraints", retryable: false });
	}
	if (normalized.returnTokenBudget !== undefined) {
		throw createProviderError({ provider: "openai-codex", kind: "unsupported", message: "Codex standalone search does not expose return-token-budget control", retryable: false });
	}
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "keyword") warnings.push({ code: "unsupported-option", option: "mode", message: "Codex standalone search is semantic and does not guarantee keyword-only ranking" });
	if (normalized.mode === "fresh") warnings.push({ code: "unsupported-option", option: "mode", message: "Codex standalone search can use current sources but does not guarantee a freshness-only ranking" });
	const contentTypes = normalized.searchContentTypes ?? ["text"];
	const commands: Record<string, unknown> = {};
	if (contentTypes.includes("text")) commands.search_query = [{
		q: normalized.query,
		...(normalized.mode === "fresh" ? { recency: 7 } : {}),
		...(normalized.domains?.include?.length ? { domains: [...normalized.domains.include] } : {}),
	}];
	if (contentTypes.includes("image")) commands.image_query = [{ q: normalized.query }];
	const settings = buildSettings(normalized);
	const appliedOptions: SearchOption[] = ["maxResults", "mode"];
	if (normalized.domains?.include?.length || normalized.domains?.exclude?.length) appliedOptions.push("domains");
	if (normalized.searchContextSize !== undefined) appliedOptions.push("searchContextSize");
	if (normalized.userLocation !== undefined) appliedOptions.push("userLocation");
	if (normalized.searchContentTypes !== undefined) appliedOptions.push("searchContentTypes");
	if (normalized.imageSettings !== undefined) appliedOptions.push("imageSettings");
	if (normalized.externalWebAccess !== undefined) appliedOptions.push("externalWebAccess");
	return {
		body: {
			id: `pi-search-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			model: "",
			input: normalized.query,
			commands,
			...(settings === undefined ? {} : { settings }),
			max_output_tokens: 2_048,
		},
		appliedOptions,
		warnings,
	};
}

function parseUsage(value: unknown): ProviderUsage | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const usage = value as Record<string, unknown>;
	const number = (key: string): number | undefined => typeof usage[key] === "number" && Number.isFinite(usage[key]) && (usage[key] as number) >= 0 ? usage[key] as number : undefined;
	const inputTokens = number("input_tokens");
	const outputTokens = number("output_tokens");
	const totalTokens = number("total_tokens");
	if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(totalTokens === undefined ? {} : { totalTokens, billedUnits: totalTokens, billedUnit: "tokens" }),
	};
}

function sourceFromRecord(value: unknown, query: string): SearchResult | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const rawUrl = record.url ?? record.image_url ?? record.source_website_url;
	const parsed = httpSource(rawUrl, "openai-codex");
	if (parsed === undefined || parsed.url.length > MAX_CODEX_SOURCE_LENGTH) return undefined;
	const sourcePage = httpSource(record.source_website_url, "openai-codex");
	const title = optionalString(record.title ?? record.caption, 500);
	const excerpt = optionalString(record.snippet ?? record.text ?? record.description ?? record.caption, 4_000);
	const publishedAt = optionalString(record.published_at ?? record.published_date, 100);
	const sourceId = optionalString(record.ref_id ?? record.id ?? record.source_id, 500);
	return {
		url: parsed.url,
		...(title === undefined ? {} : { title }),
		domain: parsed.domain,
		...(excerpt === undefined ? {} : { excerpt }),
		...(publishedAt === undefined ? {} : { publishedAt }),
		provider: "openai-codex",
		searchQuery: query,
		...(sourceId === undefined ? {} : { sourceId }),
		...(sourcePage === undefined || sourcePage.url === parsed.url ? {} : { sourcePageUrl: sourcePage.url }),
	};
}

function trimExtractedUrl(value: string): string {
	let candidate = value;
	while (candidate.length > 0) {
		const trailing = candidate.match(/[)\]}>.,;:!?\u0027"`]+\/$/);
		if (trailing !== null) {
			candidate = candidate.slice(0, -trailing[0].length);
			continue;
		}
		const stripped = candidate.replace(/[)\]}>.,;:!?\u0027"`]+$/, "");
		if (stripped === candidate) break;
		candidate = stripped;
	}
	return candidate;
}

function urlsFromText(text: string): readonly string[] {
	return [...text.matchAll(/https?:\/\/[^\s<>\]]+/gi)]
		.map((match) => trimExtractedUrl(match[0]!))
		.filter((url) => url.length > 0)
		.slice(0, 20);
}

function normalizeCodexResponse(payload: unknown, request: SearchRequest): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "openai-codex");
	const answerText = optionalString(root.output, MAX_CODEX_ANSWER_LENGTH) ?? "";
	const rawResults = Array.isArray(root.results) ? root.results : [];
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const value of rawResults) {
		const result = sourceFromRecord(value, normalized.query);
		if (result !== undefined && !seen.has(result.url)) {
			seen.add(result.url);
			results.push(result);
		}
	}
	for (const url of urlsFromText(answerText)) {
		const parsed = httpSource(url, "openai-codex");
		if (parsed === undefined || seen.has(parsed.url)) continue;
		seen.add(parsed.url);
		results.push({ url: parsed.url, domain: parsed.domain, provider: "openai-codex", searchQuery: normalized.query });
	}
	const limitedResults = results.slice(0, normalized.maxResults ?? 10);
	if (limitedResults.length === 0) throw createProviderError({ provider: "openai-codex", kind: "malformed", message: "Codex standalone search returned no inspectable HTTP sources", retryable: false });
	const byRef = new Map(limitedResults.flatMap((result) => result.sourceId === undefined ? [] : [[result.sourceId, result] as const]));
	const cited = new Set<string>();
	for (const ref of answerText.matchAll(/\bturn\d+(?:search|image)\d+\b/g)) {
		const result = byRef.get(ref[0]);
		if (result !== undefined) cited.add(result.url);
	}
	for (const result of limitedResults) if (answerText.includes(result.url)) cited.add(result.url);
	const citations = limitedResults.filter((result) => cited.has(result.url)).map((result) => ({ url: result.url, ...(result.title === undefined ? {} : { title: result.title }), ...(result.sourceId === undefined ? {} : { sourceId: result.sourceId }) }));
	const answer = normalized.answerMode !== "evidence" && answerText.length > 0 && citations.length > 0
		? { text: answerText, contentTrust: "untrusted" as const, provider: "openai-codex" as const, citations }
		: undefined;
	return {
		query: normalized.query,
		results: limitedResults,
		...(answer === undefined ? {} : { answer }),
		provider: "openai-codex",
		appliedOptions: [],
		warnings: [],
		...(optionalString(root.id, 500) === undefined ? {} : { requestId: optionalString(root.id, 500) }),
		...(parseUsage(root.usage) === undefined ? {} : { usage: parseUsage(root.usage) }),
	};
}

function codexHeaders(execution: ModelExecution): Readonly<Record<string, string>> {
	const headers = modelAuthHeaders(execution);
	if (execution.auth.apiKey === undefined || execution.auth.apiKey.trim().length === 0) {
		throw createProviderError({ provider: "openai-codex", kind: "auth", message: "Codex authentication returned no token", retryable: false });
	}
	const parts = execution.auth.apiKey.split(".");
	if (parts.length === 3 && parts[1] !== undefined) {
		try {
			const decoded = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "="), "base64").toString("utf8")) as Record<string, unknown>;
			const auth = decoded["https://api.openai.com/auth"];
			if (auth !== null && typeof auth === "object" && !Array.isArray(auth)) {
				const accountId = optionalString((auth as Record<string, unknown>).chatgpt_account_id, 500);
				if (accountId !== undefined) headers.set("chatgpt-account-id", accountId);
			}
		} catch {
			// The backend may authenticate non-JWT tokens through headers alone.
		}
	}
	headers.set("originator", "pi");
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	return Object.fromEntries(headers.entries());
}

export class CodexProvider implements Provider {
	readonly id = "openai-codex" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly endpoint?: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: CodexAdapterOptions = {}) {
		this.endpoint = options.endpoint;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_CODEX_RESPONSE_BYTES;
		if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error("Codex maxResponseBytes must be a positive integer");
	}

	async search(request: SearchRequest, signal: AbortSignal, context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildCodexRequest(normalized);
		if (signal.aborted) throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false });
		const execution = await selectModelExecution({ searchProvider: this.id, modelProvider: "openai-codex", api: "openai-codex-responses", request: normalized, context });
		const result = await postJson({ provider: this.id, url: endpointFor(execution.model, this.endpoint), headers: codexHeaders(execution), body: { ...plan.body, model: execution.model.id }, signal, fetchImpl: this.fetchImpl, maxResponseBytes: this.maxResponseBytes });
		const response = normalizeCodexResponse(result.payload, normalized);
		return {
			...response,
			...(response.answer === undefined ? {} : { answer: { ...response.answer, executionModel: execution.model.id } }),
			...(response.requestId === undefined && result.requestId === undefined ? {} : { requestId: response.requestId ?? result.requestId }),
			...(response.usage === undefined && result.rateLimits === undefined ? {} : { usage: { ...response.usage, ...(result.rateLimits === undefined ? {} : { rateLimits: result.rateLimits }) } }),
			executionModel: execution.model.id,
			appliedOptions: plan.appliedOptions,
			warnings: [...plan.warnings, ...response.warnings],
		};
	}
}

export function createCodexProvider(options: CodexAdapterOptions = {}): CodexProvider {
	return new CodexProvider(options);
}
