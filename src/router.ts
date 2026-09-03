import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider, ProviderId, SearchProviderSelection, SearchRequest } from "./contracts";
import { createProviderError } from "./errors";
import type { BraveCapacityTracker } from "./brave";
import { validateSearchRequest } from "./search";

/** Billing choices are an installation policy, not provider fallbacks. */
export type SearchBillingPolicy = "free-only" | "prefer-free" | "allow-configured-metered";

export interface SearchRouterOptions {
	readonly openai?: Provider;
	readonly openaiCodex?: Provider;
	readonly gemini?: Provider;
	readonly xai?: Provider;
	readonly xaiX?: Provider;
	readonly anthropic?: Provider;
	readonly meta?: Provider;
	readonly brave?: Provider;
	readonly exa?: Provider;
	readonly parallel?: Provider;
	readonly x?: Provider;
	/** Credential presence is supplied by the construction boundary. */
	readonly braveConfigured?: boolean;
	readonly exaConfigured?: boolean;
	readonly parallelConfigured?: boolean;
	readonly xConfigured?: boolean;
	/** Explicit user assertion that Brave calls are covered by free capacity. */
	readonly braveFreeCapacityConfigured?: boolean;
	readonly braveCapacity?: BraveCapacityTracker;
	/** Defaults to free-only to prevent an unexpected metered request. */
	readonly billingPolicy?: SearchBillingPolicy;
}

export type SearchProviderResolver = (request: SearchRequest, context: ExtensionContext) => SearchProviderSelection;

function unavailable(message: string, provider: ProviderId = "router"): never {
	throw createProviderError({ provider, kind: "unavailable", message, retryable: false });
}

function canServe(provider: Provider, request: SearchRequest): boolean {
	// Search modes are retrieval hints. Providers that cannot guarantee a hint
	// must report that limitation in their response; hard constraints and
	// explicit model-mediated options must not be silently dropped.
	if ((request.domains?.include?.length || request.domains?.exclude?.length) && provider.capabilities.domainFilter !== true) return false;
	if (request.executionModel !== undefined && provider.profile.auth !== "modelRegistry") return false;
	if (request.dateRange !== undefined && provider.capabilities.dateFilter !== true) return false;
	if (request.social !== undefined) {
		if (provider.capabilities.social !== true) return false;
		if ((request.social.includeHandles !== undefined || request.social.excludeHandles !== undefined) && provider.capabilities.handleFilter !== true) return false;
		if ((request.social.understandImages === true || request.social.understandVideos === true) && provider.capabilities.mediaUnderstanding !== true) return false;
	}
	if (request.searchContextSize !== undefined && provider.capabilities.searchContextSize !== true) return false;
	if (request.returnTokenBudget !== undefined && provider.capabilities.returnTokenBudget !== true) return false;
	if (request.externalWebAccess !== undefined && provider.capabilities.externalWebAccess !== true) return false;
	if (request.userLocation !== undefined && provider.capabilities.userLocation !== true) return false;
	if (request.searchContentTypes !== undefined && provider.capabilities.searchContentTypes !== true) return false;
	if (request.imageSettings !== undefined && provider.capabilities.imageSettings !== true) return false;
	return true;
}

/**
 * Table-driven native registry: adding a model-mediated adapter is one row
 * here plus the option field above. The Pi model-registry `provider`/`api`
 * pair is the join key adapters also use in `selectModelExecution`.
 */
interface NativeRegistryEntry {
	readonly modelProvider: string;
	readonly api: string;
	readonly option: "openai" | "openaiCodex" | "gemini" | "xai" | "xaiX" | "anthropic" | "meta";
	readonly label: string;
}

const NATIVE_REGISTRY: Readonly<Record<string, NativeRegistryEntry>> = {
	openai: { modelProvider: "openai", api: "openai-responses", option: "openai", label: "OpenAI" },
	"openai-codex": { modelProvider: "openai-codex", api: "openai-codex-responses", option: "openaiCodex", label: "Codex" },
	gemini: { modelProvider: "google", api: "google-generative-ai", option: "gemini", label: "Gemini" },
	xai: { modelProvider: "xai", api: "openai-responses", option: "xai", label: "xAI web" },
	"xai-x": { modelProvider: "xai", api: "openai-responses", option: "xaiX", label: "xAI X" },
	anthropic: { modelProvider: "anthropic", api: "anthropic-messages", option: "anthropic", label: "Anthropic" },
	meta: { modelProvider: "meta", api: "openai-responses", option: "meta", label: "Meta" },
};

function nativeEntry(provider: ProviderId): NativeRegistryEntry | undefined {
	return NATIVE_REGISTRY[provider];
}

function nativeModelCompatible(provider: ProviderId, model: ExtensionContext["model"] | undefined): boolean {
	if (model === undefined) return false;
	const entry = nativeEntry(provider);
	if (entry === undefined) return false;
	return model.provider === entry.modelProvider && model.api === entry.api;
}

function availableNativeModel(provider: ProviderId, context: ExtensionContext, requestedModel?: string): boolean {
	const compatible = (model: NonNullable<ExtensionContext["model"]>): boolean => nativeModelCompatible(provider, model);
	if (requestedModel !== undefined && context.model !== undefined && compatible(context.model) && context.model.id === requestedModel) return true;
	if (requestedModel === undefined && nativeModelCompatible(provider, context.model)) return true;
	try {
		return context.modelRegistry.getAvailable().some((model) => compatible(model) && (requestedModel === undefined || model.id === requestedModel));
	} catch {
		return false;
	}
}

function selection(provider: Provider, automatic: boolean, fallbacks: readonly Provider[] = []): SearchProviderSelection {
	return { provider, automatic, fallbacks: fallbacks.slice(0, 1) };
}

function directFallback(
	primary: Provider,
	request: SearchRequest,
	options: SearchRouterOptions,
	policy: SearchBillingPolicy,
): readonly Provider[] {
	if (policy !== "free-only" && primary.id !== "exa" && options.exaConfigured === true && options.exa !== undefined && canServe(options.exa, request)) return [options.exa];
	const braveAllowed = policy === "allow-configured-metered" || options.braveFreeCapacityConfigured === true;
	if (primary.id !== "brave" && options.braveConfigured === true && options.brave !== undefined && braveAllowed && canServe(options.brave, request)) return [options.brave];
	return [];
}

function checkBraveCapacity(options: SearchRouterOptions): void {
	if (options.braveCapacity !== undefined && !options.braveCapacity.canAttempt()) {
		const info = options.braveCapacity.snapshot();
		throw createProviderError({ provider: "brave", kind: "rateLimit", message: "Brave quota window is exhausted", retryable: true, rateLimits: info, retryAfterMs: info?.retryAfterMs });
	}
}

function explicitProvider(
	request: SearchRequest,
	context: ExtensionContext,
	options: SearchRouterOptions,
	policy: SearchBillingPolicy,
): SearchProviderSelection {
	const provider = request.providerHint;
	if (provider === undefined) return unavailable("No provider was selected");
	if (request.executionModel !== undefined && provider === "native") return unavailable("executionModel requires an explicit model-mediated provider, not the native alias", provider);
	if (provider === "native") {
		// Web-first native ids in registry order; xAI resolves last because the
		// active model must choose between its web and X grounding tools.
		for (const id of ["openai", "openai-codex", "gemini", "anthropic", "meta"] as const) {
			const candidate = options[NATIVE_REGISTRY[id]!.option];
			if (candidate !== undefined && nativeModelCompatible(id, context.model) && canServe(candidate, request)) return selection(candidate, false);
		}
		if (nativeModelCompatible("xai", context.model)) {
			const selected = request.social !== undefined || request.dateRange !== undefined ? options.xaiX : options.xai;
			if (selected !== undefined && canServe(selected, request)) return selection(selected, false);
		}
		return unavailable("Native search requires an active supported grounded model that can satisfy the requested constraints", provider);
	}
	const native = nativeEntry(provider);
	if (native !== undefined) {
		const selected = options[native.option];
		if (selected === undefined) return unavailable(`${native.label} search is not registered`, provider);
		if (!nativeModelCompatible(provider, context.model) && request.executionModel === undefined) return unavailable(`Cross-provider ${native.label} search requires an explicit executionModel`, provider);
		if (!availableNativeModel(provider, context, request.executionModel)) {
			return unavailable(
				request.executionModel === undefined
					? `${native.label} native search requires an available model`
					: `Requested ${native.label} executionModel is not available`,
				provider,
			);
		}
		if (!canServe(selected, request)) return unavailable(`${native.label} search cannot satisfy the requested search constraints`, provider);
		return selection(selected, false);
	}
	if (provider === "exa") {
		if (options.exa === undefined || options.exaConfigured !== true) return unavailable("Exa search is not configured", provider);
		if (!canServe(options.exa, request)) return unavailable("Exa cannot satisfy the requested search constraints", provider);
		return selection(options.exa, false);
	}
	if (provider === "parallel") {
		if (options.parallel === undefined || options.parallelConfigured !== true) return unavailable("Parallel search is not configured", provider);
		if (!canServe(options.parallel, request)) return unavailable("Parallel cannot satisfy the requested search constraints", provider);
		return selection(options.parallel, false);
	}
	if (provider === "x") {
		if (options.x === undefined || options.xConfigured !== true) return unavailable("X API search is not configured", provider);
		if (!canServe(options.x, request)) return unavailable("X API search cannot satisfy the requested search constraints", provider);
		return selection(options.x, false);
	}
	if (provider === "brave") {
		if (options.brave === undefined || options.braveConfigured !== true) return unavailable("Brave search is not configured", provider);
		if (policy !== "allow-configured-metered" && options.braveFreeCapacityConfigured !== true) return unavailable("Brave free-mode admission is disabled; set PI_SEARCH_BRAVE_FREE_ONLY=1 or PI_SEARCH_ALLOW_METERED=1", provider);
		checkBraveCapacity(options);
		if (!canServe(options.brave, request)) return unavailable("Brave cannot satisfy the requested search constraints", provider);
		return selection(options.brave, false);
	}
	return unavailable(`Search provider ${provider} is not configured`, provider);
}

/** Select one primary provider plus at most one automatic alternative. */
export function createSearchRouter(options: SearchRouterOptions): SearchProviderResolver {
	const policy = options.billingPolicy ?? "free-only";
	return (request, context) => {
		const normalized = validateSearchRequest(request);
		if (normalized.executionModel !== undefined && (normalized.providerHint === undefined || normalized.providerHint === "native")) {
			return unavailable("executionModel requires an explicit model-mediated provider hint", "router");
		}
		if (normalized.providerHint !== undefined) return explicitProvider(normalized, context, options, policy);

		// A compatible active native model is the primary choice. A model using a
		// different API variant (for example OpenAI chat completions) is not a
		// grounded search backend; continue to registry/native or direct routing
		// instead of making the user configure a provider manually.
		if (context.model?.provider === "openai-codex" && nativeModelCompatible("openai-codex", context.model)) {
			if (options.openaiCodex !== undefined && canServe(options.openaiCodex, normalized)) return selection(options.openaiCodex, true, directFallback(options.openaiCodex, normalized, options, policy));
		}
		if (context.model?.provider === "openai" && nativeModelCompatible("openai", context.model)) {
			if (options.openai !== undefined && canServe(options.openai, normalized)) return selection(options.openai, true, directFallback(options.openai, normalized, options, policy));
		}
		if (context.model?.provider === "google" && nativeModelCompatible("gemini", context.model)) {
			if (options.gemini !== undefined && canServe(options.gemini, normalized)) return selection(options.gemini, true, directFallback(options.gemini, normalized, options, policy));
			// Continue to another eligible provider when Gemini cannot honor a hard
			// constraint instead of selecting it and failing after dispatch.
		}
		if (context.model?.provider === "xai" && nativeModelCompatible("xai", context.model)) {
			const xaiProvider = normalized.social !== undefined || normalized.dateRange !== undefined ? options.xaiX : options.xai;
			if (xaiProvider !== undefined && canServe(xaiProvider, normalized)) return selection(xaiProvider, true, directFallback(xaiProvider, normalized, options, policy));
			// Continue to another eligible provider when the active xAI tool cannot
			// satisfy the requested web/X constraints.
		}
		if (context.model?.provider === "anthropic" && nativeModelCompatible("anthropic", context.model)) {
			if (options.anthropic !== undefined && canServe(options.anthropic, normalized)) return selection(options.anthropic, true, directFallback(options.anthropic, normalized, options, policy));
			// Continue when Anthropic cannot honor a hard constraint.
		}
		if (context.model?.provider === "meta" && nativeModelCompatible("meta", context.model)) {
			if (options.meta !== undefined && canServe(options.meta, normalized)) return selection(options.meta, true, directFallback(options.meta, normalized, options, policy));
			// Continue when Meta cannot honor a hard constraint.
		}

		// Preserve Pi's built-in search when an authenticated same-provider model
		// exists, even if the active model is OpenRouter, Anthropic, or local.
		for (const [providerId, provider] of [["openai-codex", options.openaiCodex], ["openai", options.openai]] as const) {
			if (provider !== undefined && availableNativeModel(providerId, context) && canServe(provider, normalized)) {
				return selection(provider, true, directFallback(provider, normalized, options, policy));
			}
		}

		const mode = normalized.mode ?? "auto";
		const exaConfigured = options.exaConfigured === true;
		const exaAllowed = policy !== "free-only";
		const exaCanMatchMode = exaAllowed && options.exa !== undefined && canServe(options.exa, normalized);

		const braveCanMatchMode = options.brave !== undefined && canServe(options.brave, normalized);
		const braveConfigured = options.braveConfigured === true;
		const braveAllowed = policy === "allow-configured-metered" || options.braveFreeCapacityConfigured === true;
		// prefer-free chooses the admitted Brave path before a metered Exa call.
		if (policy === "prefer-free" && braveCanMatchMode && braveConfigured && braveAllowed) {
			checkBraveCapacity(options);
			return selection(options.brave!, true);
		}
		if (exaConfigured && exaCanMatchMode) return selection(options.exa!, true, directFallback(options.exa!, normalized, options, policy));
		if (exaAllowed && exaConfigured && mode !== "auto" && options.exa !== undefined && !exaCanMatchMode) return unavailable(`Exa cannot satisfy ${mode} search semantics`, "exa");
		if (braveCanMatchMode && braveConfigured && braveAllowed) {
			checkBraveCapacity(options);
			return selection(options.brave!, true);
		}
		if (braveConfigured && !braveAllowed) return unavailable("Brave is configured but free-mode admission is disabled; set PI_SEARCH_BRAVE_FREE_ONLY=1 or PI_SEARCH_ALLOW_METERED=1", "router");
		if (braveConfigured && mode !== "auto" && options.brave !== undefined && !braveCanMatchMode) return unavailable(`Brave cannot satisfy ${mode} search semantics`, "brave");
		return unavailable("No eligible search provider is configured; configure a provider or use an active grounded model", "router");
	};
}
