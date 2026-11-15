import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider, ProviderId, SearchProviderHintId, SearchProviderSelection, SearchRequest } from "./contracts";
import { createProviderError } from "./errors";
import type { BraveCapacityTracker } from "./brave";
import { validateSearchRequest } from "./search";
import { supportsOpenAISearchModel } from "./openai";

/** Admission for automatic API-key search; subscription billing remains unknown. */
export type SearchBillingPolicy = "free-only" | "prefer-free" | "allow-configured-metered";

export interface SearchRouterOptions {
	/** Only configured/enabled adapters belong here. Credentials remain lazy. */
	readonly providers: readonly Provider[];
	/** An explicit installation preference, independent of the active chat model. */
	readonly primary?: SearchProviderHintId;
	readonly executionModel?: string;
	/** No fallback unless the user deliberately names one. */
	readonly fallback?: SearchProviderHintId;
	readonly billingPolicy?: SearchBillingPolicy;
	readonly braveFreeCapacityConfigured?: boolean;
	readonly braveCapacity?: BraveCapacityTracker;
}

export type SearchProviderResolver = (request: SearchRequest, context: ExtensionContext) => SearchProviderSelection;

function unavailable(message: string, provider: ProviderId = "router"): never {
	throw createProviderError({ provider, kind: "unavailable", message, retryable: false });
}

function canServe(provider: Provider, request: SearchRequest): boolean {
	if ((request.domains?.include?.length || request.domains?.exclude?.length) && provider.capabilities.domainFilter !== true) return false;
	if (request.domains?.include?.length && request.domains?.exclude?.length && provider.capabilities.combinedDomainFilters === false) return false;
	if (request.executionModel !== undefined && provider.profile.auth !== "modelRegistry") return false;
	if (request.dateRange !== undefined && provider.capabilities.dateFilter !== true) return false;
	if (request.social !== undefined) {
		const hasHandles = request.social.includeHandles !== undefined || request.social.excludeHandles !== undefined;
		const needsMedia = request.social.understandImages === true || request.social.understandVideos === true;
		if (provider.capabilities.social !== true) return false;
		if (hasHandles && provider.capabilities.handleFilter !== true) return false;
		if (request.social.includeHandles !== undefined && request.social.excludeHandles !== undefined && provider.capabilities.combinedHandleFilters !== true) return false;
		if (needsMedia && provider.capabilities.mediaUnderstanding !== true) return false;
	}
	if (request.searchContextSize !== undefined && provider.capabilities.searchContextSize !== true) return false;
	if (request.returnTokenBudget !== undefined && provider.capabilities.returnTokenBudget !== true) return false;
	if (request.externalWebAccess !== undefined && provider.capabilities.externalWebAccess !== true) return false;
	if (request.userLocation !== undefined && provider.capabilities.userLocation !== true) return false;
	if (request.searchContentTypes !== undefined && provider.capabilities.searchContentTypes !== true) return false;
	if (request.imageSettings !== undefined && provider.capabilities.imageSettings !== true) return false;
	return true;
}

/** These are protocol identities, not model names or credential lookups. */
const MODEL_BACKENDS: Partial<Record<SearchProviderHintId, { provider: string; api: string }>> = {
	openai: { provider: "openai", api: "openai-responses" },
	"openai-codex": { provider: "openai-codex", api: "openai-codex-responses" },
	gemini: { provider: "google", api: "google-generative-ai" },
	xai: { provider: "xai", api: "openai-responses" },
	"xai-x": { provider: "xai", api: "openai-responses" },
	anthropic: { provider: "anthropic", api: "anthropic-messages" },
	meta: { provider: "meta", api: "openai-responses" },
};

function hasModel(id: SearchProviderHintId, context: ExtensionContext, modelId?: string): boolean {
	const backend = MODEL_BACKENDS[id];
	if (backend === undefined) return true;
	return context.modelRegistry.getAvailable().some(model =>
		model.provider === backend.provider && model.api === backend.api && (modelId === undefined || model.id === modelId)
		&& (id !== "openai" || supportsOpenAISearchModel(model, modelId !== undefined)));
}

/** Pin the search execution context, never borrow the active chat model. */
function searchExecution(provider: Provider, modelId?: string): Provider {
	if (provider.profile.auth !== "modelRegistry") return provider;
	return {
		id: provider.id,
		profile: provider.profile,
		capabilities: provider.capabilities,
		search: (request, signal, context) => provider.search(
			modelId === undefined ? request : { ...request, executionModel: modelId },
			signal,
			{ modelRegistry: context.modelRegistry },
		),
	};
}

function constraints(request: SearchRequest): string {
	const names: string[] = [];
	if (request.domains !== undefined) names.push("domain filters");
	if (request.dateRange !== undefined) names.push("a date range");
	if (request.social !== undefined) names.push("social/X constraints");
	if (request.executionModel !== undefined) names.push("an execution model");
	if (request.searchContextSize !== undefined) names.push("search context size");
	if (request.returnTokenBudget !== undefined) names.push("a returned-token budget");
	if (request.externalWebAccess !== undefined) names.push("live-access selection");
	if (request.userLocation !== undefined) names.push("a user location");
	if (request.searchContentTypes !== undefined) names.push("content-type selection");
	if (request.imageSettings !== undefined) names.push("image result settings");
	return names.join(", ") || "search constraints";
}

export function createSearchRouter(options: SearchRouterOptions): SearchProviderResolver {
	const providers = new Map(options.providers.map(provider => [provider.id, provider]));
	if (providers.size !== options.providers.length) throw new Error("Search providers must have unique identities");
	const policy = options.billingPolicy ?? "free-only";
	for (const id of [options.primary, options.fallback]) {
		if (id !== undefined && !providers.has(id)) throw new Error(`Search provider ${id} is not configured or enabled`);
	}
	if (options.executionModel !== undefined && (options.primary === undefined || !MODEL_BACKENDS[options.primary])) {
		throw new Error("PI_SEARCH_MODEL requires an explicit model-mediated PI_SEARCH_PROVIDER");
	}
	if (options.primary !== undefined && options.primary === options.fallback) throw new Error("Search primary and fallback must differ");

	const checkBrave = (): void => {
		if (policy !== "allow-configured-metered" && options.braveFreeCapacityConfigured !== true) {
			unavailable("Brave free-mode admission is disabled; set PI_SEARCH_BRAVE_FREE_ONLY=1 or PI_SEARCH_ALLOW_METERED=1", "brave");
		}
		if (options.braveCapacity?.canAttempt() === false) {
			const info = options.braveCapacity.snapshot();
			throw createProviderError({ provider: "brave", kind: "rateLimit", message: "Brave quota window is exhausted", retryable: true, rateLimits: info, retryAfterMs: info?.retryAfterMs });
		}
	};
	const resolve = (id: SearchProviderHintId, request: SearchRequest, context: ExtensionContext, modelId?: string): Provider => {
		const provider = providers.get(id) ?? unavailable(`Search provider ${id} is not configured or enabled`, id);
		const executionRequest = modelId === undefined ? request : { ...request, executionModel: modelId };
		if (!canServe(provider, executionRequest)) unavailable(`${id} cannot satisfy the requested ${constraints(executionRequest)}`, id);
		if (!hasModel(id, context, modelId)) unavailable(`No available ${id} search model${modelId === undefined ? "" : ` matching ${modelId}`}`, id);
		if (id === "brave") checkBrave();
		return searchExecution(provider, modelId);
	};

	return (request, context) => {
		const normalized = validateSearchRequest(request);
		if (normalized.executionModel !== undefined && (normalized.providerHint === undefined || normalized.providerHint === "native")) {
			unavailable("executionModel requires an explicit model-mediated provider hint");
		}
		if (normalized.providerHint === "native") {
			// This explicit escape hatch deliberately follows the chat model.
			const active = context.model;
			const id = (Object.keys(MODEL_BACKENDS) as SearchProviderHintId[]).find(id => {
				const backend = MODEL_BACKENDS[id]!;
				return backend.provider === active?.provider && backend.api === active.api && id !== "xai-x";
			});
			if (id === undefined) unavailable("Native search requires an active supported grounded model");
			const target = id === "xai" && normalized.social !== undefined ? "xai-x" : id;
			return { provider: resolve(target, normalized, context, active!.id), automatic: false, fallbacks: [] };
		}
		if (normalized.providerHint !== undefined) {
			return { provider: resolve(normalized.providerHint as SearchProviderHintId, normalized, context, normalized.executionModel), automatic: false, fallbacks: [] };
		}

		let primary: Provider;
		if (options.primary !== undefined) {
			primary = resolve(options.primary, normalized, context, options.executionModel);
		} else {
			// Subscription first; API-key backends need automatic metered admission.
			// Capability checks happen before dispatch, not by trial requests.
			const ids: SearchProviderHintId[] = [
				"openai-codex",
				...(policy === "prefer-free" ? ["brave" as const] : []),
				...(policy !== "free-only" ? ["openai", "exa", "deepseek"] as const : []),
				...(policy !== "prefer-free" ? ["brave" as const] : []),
			];
			const id = ids.find(id => {
				const provider = providers.get(id);
				if (provider === undefined || !canServe(provider, normalized) || !hasModel(id, context)) return false;
				return id !== "brave" || ((policy === "allow-configured-metered" || options.braveFreeCapacityConfigured === true) && options.braveCapacity?.canAttempt() !== false);
			});
			if (id === undefined) {
				if (providers.has("brave") && canServe(providers.get("brave")!, normalized)) checkBrave();
				unavailable(`No eligible search provider for ${constraints(normalized)}; configure PI_SEARCH_PROVIDER or admit API-key automatic search with PI_SEARCH_ALLOW_METERED=1`);
			}
			primary = resolve(id, normalized, context);
		}
		const fallbackId = options.fallback;
		// A fallback's availability, constraints, and quota matter only after a
		// safe primary failure. In particular, batches never execute this path.
		const fallback = fallbackId === undefined || fallbackId === primary.id ? undefined : {
			...providers.get(fallbackId)!,
			search: (request: SearchRequest, signal: AbortSignal, execution: Parameters<Provider["search"]>[2]) =>
				resolve(fallbackId, request, context).search(request, signal, execution),
		};
		return { provider: primary, automatic: true, fallbacks: fallback === undefined ? [] : [fallback] };
	};
}
