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
import { executeGroundedSearch } from "./grounding";
import { httpSource, objectValue, optionalString, type SearchHttpFetch } from "./provider-http";
import { modelAuthHeaders, type ModelExecution } from "./model-selection";
import { validateSearchRequest } from "./search";

export const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1";
export const DEFAULT_XAI_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_XAI_ANSWER_LENGTH = 8_000;

type XAITool = "web_search" | "x_search";

export interface XAIAdapterOptions {
	readonly tool: XAITool;
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const profiles: Record<XAITool, ProviderProfile> = {
	web_search: { auth: "modelRegistry", costModel: "usage-based" },
	x_search: { auth: "modelRegistry", costModel: "usage-based" },
};

function capabilities(tool: XAITool): ProviderCapabilities {
	return tool === "x_search"
		? { semantic: true, freshness: true, social: true, dateFilter: true, handleFilter: true, mediaUnderstanding: true, nativeGrounding: true }
		: { semantic: true, freshness: true, domainFilter: true, nativeGrounding: true };
}

export interface XAIRequestPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

export function buildXAIRequest(request: SearchRequest, tool: XAITool): XAIRequestPlan {
	const normalized = validateSearchRequest(request);
	if (tool === "x_search" && (normalized.domains?.include?.length || normalized.domains?.exclude?.length)) {
		throw createProviderError({ provider: "xai-x", kind: "unsupported", message: "xAI X search does not accept web domain filters", retryable: false });
	}
	if (tool === "web_search" && (normalized.dateRange !== undefined || normalized.social !== undefined)) {
		throw createProviderError({ provider: "xai", kind: "unsupported", message: "xAI web search does not accept X date, handle, or media constraints", retryable: false });
	}
	if (tool === "x_search" && normalized.social?.includeHandles !== undefined && normalized.social.excludeHandles !== undefined) {
		throw createProviderError({ provider: "xai-x", kind: "unsupported", message: "xAI X search cannot combine included and excluded handles", retryable: false });
	}
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "keyword") warnings.push({ code: "unsupported-option", option: "mode", message: `xAI ${tool === "x_search" ? "X" : "web"} search is semantic and does not guarantee keyword-only ranking` });
	if (normalized.mode === "fresh") warnings.push({ code: "unsupported-option", option: "mode", message: `xAI ${tool === "x_search" ? "X" : "web"} search can use current sources but does not guarantee a freshness-only ranking` });
	const searchTool: Record<string, unknown> = { type: tool };
	if (tool === "web_search") {
		const filters = {
			...(normalized.domains?.include?.length ? { allowed_domains: [...normalized.domains.include] } : {}),
			...(normalized.domains?.exclude?.length ? { excluded_domains: [...normalized.domains.exclude] } : {}),
		};
		if (Object.keys(filters).length > 0) searchTool.filters = filters;
	} else {
		if (normalized.social?.includeHandles !== undefined) searchTool.allowed_x_handles = [...normalized.social.includeHandles];
		if (normalized.social?.excludeHandles !== undefined) searchTool.excluded_x_handles = [...normalized.social.excludeHandles];
		if (normalized.dateRange?.from !== undefined) searchTool.from_date = normalized.dateRange.from;
		if (normalized.dateRange?.to !== undefined) searchTool.to_date = normalized.dateRange.to;
		if (normalized.social?.understandImages === true) searchTool.enable_image_understanding = true;
		if (normalized.social?.understandVideos === true) searchTool.enable_video_understanding = true;
	}
	return {
		body: {
			model: "",
			input: [{ role: "user", content: normalized.mode === "fresh" ? `Prefer current sources. ${normalized.query}` : normalized.query }],
			tools: [searchTool],
		},
		appliedOptions: [
			"maxResults",
			"mode",
			...(normalized.domains?.include?.length || normalized.domains?.exclude?.length ? ["domains" as const] : []),
			...(normalized.dateRange === undefined ? [] : ["dateRange" as const]),
			...(normalized.social === undefined ? [] : ["social" as const]),
		],
		warnings,
	};
}

function endpointFor(model: ProviderModel, override?: string): string {
	const base = (override ?? (model.baseUrl.trim().length > 0 ? model.baseUrl : XAI_RESPONSES_ENDPOINT)).replace(/\/+$/, "");
	return base.endsWith("/responses") ? base : `${base}/responses`;
}

function authHeaders(execution: ModelExecution, provider: "xai" | "xai-x"): Readonly<Record<string, string>> {
	const headers = modelAuthHeaders(execution);
	if (!headers.has("authorization")) throw createProviderError({ provider, kind: "auth", message: "xAI authentication returned no authorization header", retryable: false });
	return Object.fromEntries(headers.entries());
}

function citationTitle(value: unknown): string | undefined {
	const title = optionalString(value, 500);
	// Responses API inline-citation labels are often numeric display indexes
	// ("1", "2", ...), not useful source titles. Let the renderer fall back to
	// the source domain instead of exposing those labels as titles.
	return title !== undefined && !/^\d+$/.test(title.trim()) ? title : undefined;
}

function appendCitation(results: SearchResult[], seen: Set<string>, value: unknown, query: string, title?: string): boolean {
	const raw = typeof value === "string" ? value : value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).url : undefined;
	const parsed = httpSource(raw, "xai");
	if (parsed === undefined) return false;
	if (seen.has(parsed.url)) return true;
	seen.add(parsed.url);
	results.push({ url: parsed.url, ...(title === undefined ? {} : { title }), domain: parsed.domain, provider: "xai", searchQuery: query });
	return true;
}

function normalizeXAIResponse(payload: unknown, request: SearchRequest, tool: XAITool): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "xai");
	const status = optionalString(root.status);
	if (status !== "completed") {
		throw createProviderError({ provider: tool === "x_search" ? "xai-x" : "xai", kind: status === undefined ? "malformed" : "http", message: status === undefined ? "xAI response has no terminal status" : `xAI response was ${status}`, retryable: status === "incomplete" || status === "in_progress" });
	}
	const results: SearchResult[] = [];
	const answerParts: string[] = [];
	const answerCitationUrls = new Set<string>();
	const seen = new Set<string>();
	let discarded = 0;
	if (Array.isArray(root.citations)) {
		for (const citation of root.citations) {
			if (!appendCitation(results, seen, citation, normalized.query)) discarded += 1;
		}
	}
	if (Array.isArray(root.output)) {
		for (const outputValue of root.output) {
			if (typeof outputValue !== "object" || outputValue === null || Array.isArray(outputValue)) continue;
			const output = outputValue as Record<string, unknown>;
			if (output.type === "web_search_call" || output.type === "x_search_call") {
				const action = output.action !== null && typeof output.action === "object" && !Array.isArray(output.action) ? output.action as Record<string, unknown> : undefined;
				const callStatus = optionalString(output.status) ?? optionalString(action?.status);
				if (callStatus === undefined) {
					throw createProviderError({ provider: tool === "x_search" ? "xai-x" : "xai", kind: "malformed", message: `xAI ${tool} call has no terminal status`, retryable: true });
				}
				if (callStatus !== "completed") {
					throw createProviderError({ provider: tool === "x_search" ? "xai-x" : "xai", kind: "http", message: `xAI ${tool} call was ${callStatus}`, retryable: callStatus === "incomplete" || callStatus === "in_progress" });
				}
			}
			const content = output.content;
			if (!Array.isArray(content)) continue;
			for (const partValue of content) {
				if (typeof partValue === "object" && partValue !== null && !Array.isArray(partValue) && typeof (partValue as Record<string, unknown>).text === "string") answerParts.push((partValue as Record<string, unknown>).text as string);
				if (typeof partValue !== "object" || partValue === null || Array.isArray(partValue)) continue;
				const part = partValue as Record<string, unknown>;
				if (!Array.isArray(part.annotations)) continue;
				for (const annotationValue of part.annotations) {
					if (typeof annotationValue !== "object" || annotationValue === null || Array.isArray(annotationValue)) {
						discarded += 1;
						continue;
					}
					const annotation = annotationValue as Record<string, unknown>;
					const parsed = httpSource(annotation.url, "xai");
					if (parsed === undefined || !appendCitation(results, seen, parsed.url, normalized.query, citationTitle(annotation.title))) {
						discarded += 1;
					} else {
						answerCitationUrls.add(parsed.url);
					}
				}
			}
		}
	}
	if (results.length === 0) {
		throw createProviderError({ provider: tool === "x_search" ? "xai-x" : "xai", kind: "malformed", message: "xAI returned no parseable citation URLs", retryable: false });
	}
	const provider = tool === "x_search" ? "xai-x" : "xai";
	const warnings: SearchWarning[] = discarded > 0 ? [{ code: "partial-results", message: `xAI discarded ${discarded} malformed citation entr${discarded === 1 ? "y" : "ies"}` }] : [];
	const normalizedResults = results.slice(0, normalized.maxResults ?? 10).map((result) => ({ ...result, provider }));
	const answerText = answerParts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_XAI_ANSWER_LENGTH);
	const answerCitations = normalizedResults.filter((result) => answerCitationUrls.has(result.url)).map((result) => ({ url: result.url, ...(result.title === undefined ? {} : { title: result.title }) }));
	const answer = normalized.answerMode !== "evidence" && answerText.length > 0 && answerCitations.length > 0
		? { text: answerText, contentTrust: "untrusted" as const, provider, citations: answerCitations }
		: undefined;
	const usage = root.usage;
	const usageRecord = usage !== null && typeof usage === "object" && !Array.isArray(usage) ? usage as Record<string, unknown> : undefined;
	const inputTokens = typeof usageRecord?.input_tokens === "number" && Number.isFinite(usageRecord.input_tokens) ? usageRecord.input_tokens : undefined;
	const outputTokens = typeof usageRecord?.output_tokens === "number" && Number.isFinite(usageRecord.output_tokens) ? usageRecord.output_tokens : undefined;
	const totalTokens = typeof usageRecord?.total_tokens === "number" && Number.isFinite(usageRecord.total_tokens) ? usageRecord.total_tokens : undefined;
	const usageDetails = inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
		? undefined
		: {
			...(inputTokens === undefined ? {} : { inputTokens }),
			...(outputTokens === undefined ? {} : { outputTokens }),
			...(totalTokens === undefined ? {} : { totalTokens, billedUnits: totalTokens, billedUnit: "tokens" }),
		};
	return {
		query: normalized.query,
		results: normalizedResults,
		...(answer === undefined ? {} : { answer }),
		provider,
		appliedOptions: [],
		warnings,
		...(optionalString(root.id, 500) === undefined ? {} : { requestId: optionalString(root.id, 500) }),
		...(usageDetails === undefined ? {} : { usage: usageDetails }),
	};
}

export class XAIProvider implements Provider {
	readonly id: "xai" | "xai-x";
	readonly capabilities: ProviderCapabilities;
	readonly profile: ProviderProfile;
	private readonly tool: XAITool;
	private readonly endpoint?: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: XAIAdapterOptions) {
		this.tool = options.tool;
		this.id = options.tool === "x_search" ? "xai-x" : "xai";
		this.capabilities = capabilities(options.tool);
		this.profile = profiles[options.tool];
		this.endpoint = options.endpoint;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_XAI_RESPONSE_BYTES;
	}

	async search(request: SearchRequest, signal: AbortSignal, context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildXAIRequest(normalized, this.tool);
		return executeGroundedSearch({
			provider: this.id,
			modelProvider: "xai",
			api: "openai-responses",
			request: normalized,
			signal,
			context,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
			endpointFor: (model) => endpointFor(model, this.endpoint),
			headersFor: (execution) => authHeaders(execution, this.id),
			plan,
			normalize: (payload, current) => normalizeXAIResponse(payload, current, this.tool),
		});
	}
}

export function createXAIProvider(options: XAIAdapterOptions): XAIProvider {
	return new XAIProvider(options);
}
