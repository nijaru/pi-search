import type {
	ProviderContext,
	ProviderId,
	ProviderModel,
	ProviderRateLimitInfo,
	ProviderUsage,
	SearchOption,
	SearchRequest,
	SearchResponse,
	SearchWarning,
} from "./contracts";
import { createProviderError } from "./errors";
import { modelAuthHeaders, selectModelExecution, type ModelExecution } from "./model-selection";
import { postJson, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

/**
 * Shared helpers for model-mediated (native grounding) search adapters.
 *
 * Each native API keeps its own request/response mapping because tool names,
 * citation shapes, and billing fields differ per vendor. What is genuinely
 * common — model resolution through Pi's registry, bearer auth, endpoint
 * joining, usage/rate-limit merging, and final response assembly — lives
 * here so a new adapter is capabilities + build + normalize plus fixtures.
 *
 * OpenAI's streaming Responses transport stays bespoke in `openai.ts`; the
 * `postJson` flow here covers Gemini, xAI, Codex, Anthropic, and Meta.
 */

export interface GroundingPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

/** Token-count usage shared by Responses-family payloads. */
export function tokenUsage(
	inputTokens: unknown,
	outputTokens: unknown,
	totalTokens: unknown,
): ProviderUsage | undefined {
	const clean = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	const input = clean(inputTokens);
	const output = clean(outputTokens);
	const total = clean(totalTokens);
	if (input === undefined && output === undefined && total === undefined) return undefined;
	return {
		...(input === undefined ? {} : { inputTokens: input }),
		...(output === undefined ? {} : { outputTokens: output }),
		...(total === undefined ? {} : { totalTokens: total, billedUnits: total, billedUnit: "tokens" }),
	};
}

/** Merge provider-reported usage with observed transport rate limits. */
export function usageWithRateLimits(
	usage: ProviderUsage | undefined,
	rateLimits: ProviderRateLimitInfo | undefined,
): ProviderUsage | undefined {
	if (usage === undefined && rateLimits === undefined) return undefined;
	return { ...usage, ...(rateLimits === undefined ? {} : { rateLimits }) };
}

/** Join a model base URL with an API suffix without doubling the path. */
export function appendEndpointSuffix(base: string, suffix: string): string {
	const trimmed = base.replace(/\/+$/, "");
	return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

/** Validate a resolved endpoint URL without assuming a vendor path layout. */
export function assertHttpEndpoint(candidate: string, provider: ProviderId, label: string): string {
	let url: URL;
	try {
		url = new URL(candidate);
	} catch (error) {
		throw createProviderError({ provider, kind: "badRequest", message: `${label} is not a valid URL`, retryable: false, cause: error });
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw createProviderError({ provider, kind: "badRequest", message: `${label} must use HTTP or HTTPS`, retryable: false });
	}
	return url.toString();
}

/** Bearer auth derived from the model registry; never reads Pi auth globally. */
export function bearerAuthHeaders(execution: ModelExecution, provider: ProviderId): Readonly<Record<string, string>> {
	const headers = modelAuthHeaders(execution);
	if (!headers.has("authorization")) {
		throw createProviderError({ provider, kind: "auth", message: "Model authentication returned no authorization header", retryable: false });
	}
	return Object.fromEntries(headers.entries());
}

export interface GroundingSearchOptions {
	readonly provider: ProviderId;
	readonly modelProvider: string;
	readonly api: string;
	readonly request: SearchRequest;
	readonly signal: AbortSignal;
	readonly context: ProviderContext;
	readonly fetchImpl: SearchHttpFetch;
	readonly maxResponseBytes: number;
	readonly endpointFor: (model: ProviderModel) => string;
	readonly headersFor: (execution: ModelExecution) => Readonly<Record<string, string>>;
	readonly plan: GroundingPlan;
	readonly normalize: (
		payload: unknown,
		normalized: SearchRequest,
		context: { readonly signal: AbortSignal },
	) => Promise<SearchResponse> | SearchResponse;
}

/**
 * Run one non-streaming grounded-model search: resolve the execution model,
 * POST the plan body with the model id, normalize the payload, and attach
 * execution metadata. Callers supply only vendor-specific pieces.
 */
export async function executeModelGroundingSearch(options: GroundingSearchOptions): Promise<SearchResponse> {
	const normalized = validateSearchRequest(options.request);
	if (options.signal.aborted) {
		throw createProviderError({ provider: options.provider, kind: "canceled", message: "Search canceled", retryable: false });
	}
	const execution = await selectModelExecution({
		searchProvider: options.provider,
		modelProvider: options.modelProvider,
		api: options.api,
		request: normalized,
		context: options.context,
	});
	if (options.signal.aborted) {
		throw createProviderError({ provider: options.provider, kind: "canceled", message: "Search canceled", retryable: false });
	}
	const result = await postJson({
		provider: options.provider,
		url: options.endpointFor(execution.model),
		headers: options.headersFor(execution),
		body: { ...options.plan.body, model: execution.model.id },
		signal: options.signal,
		fetchImpl: options.fetchImpl,
		maxResponseBytes: options.maxResponseBytes,
	});
	const response = await options.normalize(result.payload, normalized, { signal: options.signal });
	return {
		...response,
		...(response.answer === undefined ? {} : { answer: { ...response.answer, executionModel: execution.model.id } }),
		...(response.requestId === undefined && result.requestId === undefined
			? {}
			: { requestId: response.requestId ?? result.requestId }),
		...(usageWithRateLimits(response.usage, result.rateLimits) === undefined
			? {}
			: { usage: usageWithRateLimits(response.usage, result.rateLimits) }),
		executionModel: execution.model.id,
		appliedOptions: options.plan.appliedOptions,
		warnings: [...options.plan.warnings, ...response.warnings],
	};
}
