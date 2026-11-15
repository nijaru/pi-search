import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider, ProviderContext, ProviderId, SearchProviderHintId, SearchPlan, SearchRequest } from "./contracts";
import { createProviderError, isProviderError } from "./errors";
import type { BraveCapacityTracker } from "./brave";
import { validateSearchRequest } from "./search";
import { supportsOpenAISearchModel } from "./openai";

/** Off-provider automatic spending; the active provider keeps its own authentication. */
export type SearchBillingPolicy = "free-only" | "prefer-free" | "allow-configured-metered";

export interface SearchRouterOptions {
	readonly providers: readonly Provider[];
	readonly primary?: SearchProviderHintId;
	readonly executionModel?: string;
	/** Explicit ordered allowlist replaces defaults; empty disables alternatives. */
	readonly fallbacks?: readonly SearchProviderHintId[];
	readonly billingPolicy?: SearchBillingPolicy;
	readonly braveFreeCapacityConfigured?: boolean;
	readonly braveCapacity?: BraveCapacityTracker;
}

export type SearchProviderResolver = (request: SearchRequest, context: ExtensionContext) => SearchPlan;

function unavailable(message: string, provider: ProviderId = "router"): never {
	throw createProviderError({ provider, kind: "unavailable", fallbackSafe: true, message, retryable: false });
}

function unsupportedConstraint(provider: Provider, request: SearchRequest): string | undefined {
	if ((request.domains?.include?.length || request.domains?.exclude?.length) && provider.capabilities.domainFilter !== true) return "domain filters";
	if (request.domains?.include?.length && request.domains?.exclude?.length && provider.capabilities.combinedDomainFilters === false) return "combined domain filters";
	if (request.executionModel !== undefined && provider.profile.auth !== "modelRegistry") return "an execution model";
	if (request.dateRange !== undefined && provider.capabilities.dateFilter !== true) return "a date range";
	if (request.social !== undefined) {
		const hasHandles = request.social.includeHandles !== undefined || request.social.excludeHandles !== undefined;
		const needsMedia = request.social.understandImages === true || request.social.understandVideos === true;
		if (provider.capabilities.social !== true) return "social/X constraints";
		if (hasHandles && provider.capabilities.handleFilter !== true) return "social/X handle filters";
		if (request.social.includeHandles !== undefined && request.social.excludeHandles !== undefined && provider.capabilities.combinedHandleFilters !== true) return "combined social/X handle filters";
		if (needsMedia && provider.capabilities.mediaUnderstanding !== true) return "social/X media understanding";
	}
	if (request.searchContextSize !== undefined && provider.capabilities.searchContextSize !== true) return "search context size";
	if (request.returnTokenBudget !== undefined && provider.capabilities.returnTokenBudget !== true) return "a returned-token budget";
	if (request.externalWebAccess !== undefined && provider.capabilities.externalWebAccess !== true) return "live-access selection";
	if (request.userLocation !== undefined && provider.capabilities.userLocation !== true) return "a user location";
	if (request.searchContentTypes !== undefined && provider.capabilities.searchContentTypes !== true) return "content-type selection";
	if (request.imageSettings !== undefined && provider.capabilities.imageSettings !== true) return "image result settings";
	return undefined;
}

/** Protocol identities keep authentication selection out of model-name heuristics. */
const MODEL_BACKENDS: Partial<Record<SearchProviderHintId, { provider: string; api: string }>> = {
	openai: { provider: "openai", api: "openai-responses" },
	"openai-codex": { provider: "openai-codex", api: "openai-codex-responses" },
	gemini: { provider: "google", api: "google-generative-ai" },
	xai: { provider: "xai", api: "openai-responses" },
	"xai-x": { provider: "xai", api: "openai-responses" },
	anthropic: { provider: "anthropic", api: "anthropic-messages" },
	meta: { provider: "meta", api: "openai-responses" },
};

function activeBackend(context: ExtensionContext, request: SearchRequest): SearchProviderHintId | undefined {
	const active = context.model;
	const id = (Object.keys(MODEL_BACKENDS) as SearchProviderHintId[]).find(id => {
		const backend = MODEL_BACKENDS[id]!;
		return id !== "xai-x" && active?.provider === backend.provider && active.api === backend.api;
	});
	return id === "xai" && request.social !== undefined ? "xai-x" : id;
}

function hasModel(id: SearchProviderHintId, context: ExtensionContext, modelId?: string): boolean {
	const backend = MODEL_BACKENDS[id];
	if (backend === undefined) return true;
	return context.modelRegistry.getAvailable().some(model =>
		model.provider === backend.provider && model.api === backend.api && (modelId === undefined || model.id === modelId)
		&& (id !== "openai" || supportsOpenAISearchModel(model, modelId !== undefined)));
}

export function createSearchRouter(options: SearchRouterOptions): SearchProviderResolver {
	const providers = new Map(options.providers.map(provider => [provider.id, provider]));
	if (providers.size !== options.providers.length) throw new Error("Search providers must have unique identities");
	if (options.primary !== undefined && !providers.has(options.primary)) throw new Error(`Search provider ${options.primary} is not configured or enabled`);
	if (options.executionModel !== undefined && (options.primary === undefined || !MODEL_BACKENDS[options.primary])) throw new Error("PI_SEARCH_MODEL requires an explicit model-mediated PI_SEARCH_PROVIDER");
	const policy = options.billingPolicy ?? "free-only";
	const braveAllowed = () => (policy === "allow-configured-metered" || options.braveFreeCapacityConfigured === true) && options.braveCapacity?.canAttempt() !== false;

	return (raw, context) => {
		const request = validateSearchRequest(raw);
		if (request.executionModel !== undefined && (request.providerHint === undefined || request.providerHint === "native")) unavailable("executionModel requires an explicit model-mediated provider hint");

		const eligibilityError = (id: SearchProviderHintId, modelId?: string, call: SearchRequest = request): ReturnType<typeof createProviderError> | undefined => {
			const fail = (message: string) => createProviderError({ provider: id, kind: "unavailable", fallbackSafe: true, message, retryable: false });
			const provider = providers.get(id);
			if (provider === undefined) return fail(`Search provider ${id} is not configured or enabled`);
			const unsupported = unsupportedConstraint(provider, modelId === undefined ? call : { ...call, executionModel: modelId });
			if (unsupported !== undefined) return fail(`${id} cannot satisfy the requested ${unsupported}`);
			try { provider.validateRequest?.(modelId === undefined ? call : { ...call, executionModel: modelId }); }
			catch (error) {
				if (!isProviderError(error) || (error.kind !== "unsupported" && error.kind !== "badRequest")) throw error;
				return createProviderError({ provider: id, kind: error.kind, message: error.message, fallbackSafe: true, retryable: false });
			}
			if (!hasModel(id, context, modelId)) return fail(`No available ${id} search model${modelId === undefined ? "" : ` matching ${modelId}`}`);
			if (id === "brave" && !braveAllowed()) {
				const exhausted = options.braveCapacity?.canAttempt() === false;
				return createProviderError({ provider: id, kind: exhausted ? "rateLimit" : "unavailable", fallbackSafe: true, retryable: exhausted,
					message: exhausted ? "Brave quota window is exhausted" : "Brave free-mode admission is disabled", rateLimits: options.braveCapacity?.snapshot() });
			}
		};
		const rejections: string[] = [];
		const eligible = (id: SearchProviderHintId, modelId?: string): boolean => {
			const error = eligibilityError(id, modelId);
			if (error !== undefined && providers.has(id)) rejections.push(error.message);
			return error === undefined;
		};
		const bind = (id: SearchProviderHintId, modelId?: string): Provider => ({
			...providers.get(id)!,
			search: (call, signal, execution: ProviderContext) => {
				// Quota and registry availability may change after planning.
				const error = eligibilityError(id, modelId, call);
				if (error !== undefined) throw error;
				const provider = providers.get(id)!;
				return provider.search(modelId === undefined ? call : { ...call, executionModel: modelId }, signal,
					provider.profile.auth === "modelRegistry" ? { modelRegistry: execution.modelRegistry } : execution);
			},
		});
		const strict = (id: SearchProviderHintId, modelId?: string): Provider => {
			const error = eligibilityError(id, modelId);
			if (error !== undefined) throw error;
			return bind(id, modelId);
		};

		if (request.providerHint !== undefined) {
			const id = request.providerHint === "native" ? activeBackend(context, request) : request.providerHint as SearchProviderHintId;
			if (id === undefined) unavailable("Native search requires an active supported grounded model");
			return { providers: [strict(id, request.providerHint === "native" ? context.model!.id : request.executionModel)] };
		}

		const active = activeBackend(context, request);
		const preferred = options.primary ?? active;
		const modelId = options.primary !== undefined ? options.executionModel
			: active === "openai" && !supportsOpenAISearchModel(context.model!) ? undefined : context.model?.id;
		const candidates: Provider[] = [];
		if (options.primary !== undefined) candidates.push(strict(options.primary, modelId));
		else if (preferred !== undefined && eligible(preferred, modelId)) candidates.push(bind(preferred, modelId));

		// Dedicated retrieval precedes cross-provider model calls. Subscription
		// quota is unknown, so off-provider native calls also require admission.
		const direct: SearchProviderHintId[] = policy === "free-only" ? ["brave"]
			: policy === "prefer-free" ? ["brave", "exa", "deepseek", "parallel", "cloudflare"]
			: ["exa", "deepseek", "brave", "parallel", "cloudflare"];
		const defaults: SearchProviderHintId[] = [
			...direct,
			...(policy === "free-only" ? [] : [
				...(request.social === undefined ? [] : ["x" as const]),
				"openai-codex", "openai", "gemini", request.social === undefined ? "xai" : "xai-x", "anthropic", "meta",
			] as SearchProviderHintId[]),
		];
		const seen = new Set(candidates.map(provider => provider.id));
		for (const id of options.fallbacks ?? defaults) {
			if (seen.has(id)) continue;
			seen.add(id);
			if (eligible(id)) candidates.push(bind(id));
		}
		const [first, ...rest] = candidates;
		if (first === undefined) unavailable(`No eligible search provider; check authentication, requested constraints, and search spending policy${rejections.length === 0 ? "" : `: ${rejections.join("; ")}`}`);
		return { providers: [first, ...rest] };
	};
}
