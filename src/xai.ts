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
		? { semantic: true, freshness: true, excerpts: true, social: true, nativeGrounding: true }
		: { semantic: true, freshness: true, excerpts: true, domainFilter: true, nativeGrounding: true };
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
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "keyword") warnings.push({ code: "unsupported-option", option: "mode", message: `xAI ${tool === "x_search" ? "X" : "web"} search is semantic and does not guarantee keyword-only ranking` });
	if (normalized.mode === "fresh") warnings.push({ code: "unsupported-option", option: "mode", message: `xAI ${tool === "x_search" ? "X" : "web"} search can use current sources but does not guarantee a freshness-only ranking` });
	const searchTool: Record<string, unknown> = { type: tool };
	if (tool === "web_search") {
		if (normalized.domains?.include?.length) searchTool.allowed_domains = [...normalized.domains.include];
		if (normalized.domains?.exclude?.length) searchTool.excluded_domains = [...normalized.domains.exclude];
	}
	return {
		body: {
			model: "",
			input: normalized.mode === "fresh" ? `Prefer current sources. ${normalized.query}` : normalized.query,
			tools: [searchTool],
		},
		appliedOptions: ["maxResults", "mode", ...(normalized.domains?.include?.length || normalized.domains?.exclude?.length ? ["domains" as const] : [])],
		warnings,
	};
}

function endpointFor(model: ProviderModel, override?: string): string {
	const base = (override ?? (model.baseUrl.trim().length > 0 ? model.baseUrl : XAI_RESPONSES_ENDPOINT)).replace(/\/+$/, "");
	return base.endsWith("/responses") ? base : `${base}/responses`;
}

async function authHeaders(context: ProviderContext, provider: "xai" | "xai-x"): Promise<Readonly<Record<string, string>>> {
	const model = context.model;
	if (model === undefined || model.provider !== "xai" || model.api !== "openai-responses") {
		throw createProviderError({ provider, kind: "unsupported", message: "Active Pi model is not an xAI Responses model", retryable: false });
	}
	if (context.modelRegistry === undefined) throw createProviderError({ provider, kind: "auth", message: "Pi model authentication is unavailable", retryable: false });
	let auth;
	try {
		auth = await context.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error) {
		throw createProviderError({ provider, kind: "auth", message: "Pi model authentication could not be resolved", retryable: false, cause: error });
	}
	if (!auth.ok) throw createProviderError({ provider, kind: "auth", message: "Pi model authentication is not configured", retryable: false });
	const headers = new Headers();
	for (const source of [model.headers, auth.headers]) {
		if (source === undefined) continue;
		for (const [key, value] of Object.entries(source)) headers.set(key, value);
	}
	if (auth.apiKey !== undefined && auth.apiKey.trim().length > 0) headers.set("authorization", `Bearer ${auth.apiKey}`);
	if (!headers.has("authorization")) throw createProviderError({ provider, kind: "auth", message: "xAI authentication returned no authorization header", retryable: false });
	return Object.fromEntries(headers.entries());
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
					if (!appendCitation(results, seen, annotation.url, normalized.query, optionalString(annotation.title, 500))) discarded += 1;
				}
			}
		}
	}
	if (discarded > 0 && results.length === 0) {
			throw createProviderError({ provider: tool === "x_search" ? "xai-x" : "xai", kind: "malformed", message: "xAI returned no parseable citation URLs", retryable: false });
	}
	const provider = tool === "x_search" ? "xai-x" : "xai";
	const warnings: SearchWarning[] = discarded > 0 ? [{ code: "partial-results", message: `xAI discarded ${discarded} malformed citation entr${discarded === 1 ? "y" : "ies"}` }] : [];
	const normalizedResults = results.slice(0, normalized.maxResults ?? 10).map((result) => ({ ...result, provider }));
	const answerText = answerParts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_XAI_ANSWER_LENGTH);
	const answer = normalized.answerMode !== "evidence" && answerText.length > 0 && normalizedResults.length > 0
		? { text: answerText, contentTrust: "untrusted" as const, provider, citations: normalizedResults.map((result) => ({ url: result.url, ...(result.title === undefined ? {} : { title: result.title }) })) }
		: undefined;
	const usage = root.usage;
	const usageRecord = usage !== null && typeof usage === "object" && !Array.isArray(usage) ? usage as Record<string, unknown> : undefined;
	const billedUnits = typeof usageRecord?.total_tokens === "number" && Number.isFinite(usageRecord.total_tokens) ? usageRecord.total_tokens : undefined;
	return {
		query: normalized.query,
		results: normalizedResults,
		...(answer === undefined ? {} : { answer }),
		provider,
		appliedOptions: [],
		warnings,
		...(optionalString(root.id, 500) === undefined ? {} : { requestId: optionalString(root.id, 500) }),
		...(billedUnits === undefined ? {} : { usage: { billedUnits, billedUnit: "tokens", totalTokens: billedUnits } }),
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
		const model = context.model;
		if (model === undefined || model.provider !== "xai" || model.api !== "openai-responses") throw createProviderError({ provider: this.id, kind: "unsupported", message: "Active Pi model is not an xAI Responses model", retryable: false });
		const result = await postJson({
			provider: this.id,
			url: endpointFor(model, this.endpoint),
			headers: await authHeaders(context, this.id),
			body: { ...plan.body, model: model.id },
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeXAIResponse(result.payload, normalized, this.tool);
		const usage = response.usage === undefined && result.rateLimits === undefined
			? undefined
			: { ...response.usage, ...(result.rateLimits === undefined ? {} : { rateLimits: result.rateLimits }) };
		return {
			...response,
			...(response.answer === undefined ? {} : { answer: { ...response.answer, executionModel: model.id } }),
			...(response.requestId === undefined && result.requestId === undefined ? {} : { requestId: response.requestId ?? result.requestId }),
			...(usage === undefined ? {} : { usage }),
			executionModel: model.id,
			appliedOptions: plan.appliedOptions,
			warnings: [...plan.warnings, ...response.warnings],
		};
	}
}

export function createXAIProvider(options: XAIAdapterOptions): XAIProvider {
	return new XAIProvider(options);
}
