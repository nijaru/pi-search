import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider, ProviderId, SearchRequest } from "./contracts";
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

export type SearchProviderResolver = (request: SearchRequest, context: ExtensionContext) => Provider;

function unavailable(message: string, provider: ProviderId = "router"): never {
	throw createProviderError({ provider, kind: "unavailable", message, retryable: false });
}

function canServe(provider: Provider, request: SearchRequest): boolean {
	// Search modes are retrieval hints. Providers that cannot guarantee a hint
	// must report that limitation in their response rather than being rejected
	// during routing; domain filters remain hard constraints.
	if ((request.domains?.include?.length || request.domains?.exclude?.length) && provider.capabilities.domainFilter !== true) return false;
	return true;
}

function nativeModelCompatible(provider: ProviderId, model: ExtensionContext["model"]): boolean {
	if (model === undefined) return false;
	if (provider === "openai") return model.provider === "openai" && model.api === "openai-responses";
	if (provider === "openai-codex") return model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (provider === "gemini") return model.provider === "google" && model.api === "google-generative-ai";
	if (provider === "xai" || provider === "xai-x") return model.provider === "xai" && model.api === "openai-responses";
	return false;
}

function explicitProvider(
	request: SearchRequest,
	context: ExtensionContext,
	options: SearchRouterOptions,
	policy: SearchBillingPolicy,
): Provider {
	const provider = request.providerHint;
	if (provider === undefined) return unavailable("No provider was selected");
	if (provider === "native") {
		if (nativeModelCompatible("openai", context.model) && options.openai !== undefined) return options.openai;
		if (nativeModelCompatible("openai-codex", context.model) && options.openaiCodex !== undefined) return options.openaiCodex;
		if (nativeModelCompatible("gemini", context.model) && options.gemini !== undefined) return options.gemini;
		if (nativeModelCompatible("xai", context.model) && options.xai !== undefined) return options.xai;
		return unavailable("Native search requires an active supported grounded model", provider);
	}
	if (provider === "openai") {
		if (!nativeModelCompatible("openai", context.model) || options.openai === undefined) return unavailable("OpenAI native search requires an active OpenAI Responses model", provider);
		return options.openai;
	}
	if (provider === "openai-codex") {
		if (!nativeModelCompatible("openai-codex", context.model) || options.openaiCodex === undefined) return unavailable("Codex native search requires an active Codex Responses model", provider);
		return options.openaiCodex;
	}
	if (provider === "gemini") {
		if (!nativeModelCompatible("gemini", context.model) || options.gemini === undefined) return unavailable("Gemini grounding requires an active Gemini model", provider);
		if (!canServe(options.gemini, request)) return unavailable("Gemini grounding cannot satisfy the requested search constraints", provider);
		return options.gemini;
	}
	if (provider === "xai" || provider === "xai-x") {
		const selected = provider === "xai" ? options.xai : options.xaiX;
		if (!nativeModelCompatible(provider, context.model) || selected === undefined) return unavailable(`${provider === "xai" ? "xAI web" : "xAI X"} search requires an active xAI Responses model`, provider);
		if (!canServe(selected, request)) return unavailable(`${provider === "xai" ? "xAI web" : "xAI X"} search cannot satisfy the requested search constraints`, provider);
		return selected;
	}
	if (provider === "exa") {
		if (options.exa === undefined || options.exaConfigured !== true) return unavailable("Exa search is not configured", provider);
		if (!canServe(options.exa, request)) return unavailable("Exa cannot satisfy the requested search constraints", provider);
		return options.exa;
	}
	if (provider === "parallel") {
		if (options.parallel === undefined || options.parallelConfigured !== true) return unavailable("Parallel search is not configured", provider);
		if (!canServe(options.parallel, request)) return unavailable("Parallel cannot satisfy the requested search constraints", provider);
		return options.parallel;
	}
	if (provider === "x") {
		if (options.x === undefined || options.xConfigured !== true) return unavailable("X API search is not configured", provider);
		if (!canServe(options.x, request)) return unavailable("X API search cannot satisfy the requested search constraints", provider);
		return options.x;
	}
	if (provider === "brave") {
		if (options.brave === undefined || options.braveConfigured !== true) return unavailable("Brave search is not configured", provider);
		if (policy !== "allow-configured-metered" && options.braveFreeCapacityConfigured !== true) return unavailable("Brave free-mode admission is disabled; set PI_SEARCH_BRAVE_FREE_ONLY=1 or PI_SEARCH_ALLOW_METERED=1", provider);
		if (options.braveCapacity !== undefined && !options.braveCapacity.canAttempt()) {
			const info = options.braveCapacity.snapshot();
			throw createProviderError({ provider: "brave", kind: "rateLimit", message: "Brave quota window is exhausted", retryable: true, rateLimits: info, retryAfterMs: info?.retryAfterMs });
		}
		if (!canServe(options.brave, request)) return unavailable("Brave cannot satisfy the requested search constraints", provider);
		return options.brave;
	}
	return unavailable(`Search provider ${provider} is not configured`, provider);
}

/** Select exactly one provider before the call. Failures never fall through. */
export function createSearchRouter(options: SearchRouterOptions): SearchProviderResolver {
	const policy = options.billingPolicy ?? "free-only";
	return (request, context) => {
		const normalized = validateSearchRequest(request);
		if (normalized.providerHint !== undefined) return explicitProvider(normalized, context, options, policy);

		// Native subscription capability always wins for its active model.
		if (context.model?.provider === "openai-codex") {
			if (!nativeModelCompatible("openai-codex", context.model)) return unavailable("Active Codex model does not use the Codex Responses API", "openai-codex");
			if (options.openaiCodex === undefined) return unavailable("Codex native search is not registered", "openai-codex");
			return options.openaiCodex;
		}
		if (context.model?.provider === "openai") {
			if (!nativeModelCompatible("openai", context.model)) return unavailable("Active OpenAI model does not use the OpenAI Responses API", "openai");
			if (options.openai === undefined) return unavailable("OpenAI native search is not registered", "openai");
			return options.openai;
		}
		if (context.model?.provider === "google" && nativeModelCompatible("gemini", context.model)) {
			if (options.gemini === undefined) return unavailable("Gemini grounding is not registered", "gemini");
			return options.gemini;
		}
		if (context.model?.provider === "xai" && nativeModelCompatible("xai", context.model)) {
			if (options.xai === undefined) return unavailable("xAI web search is not registered", "xai");
			return options.xai;
		}

		const mode = normalized.mode ?? "auto";
		const exaConfigured = options.exaConfigured === true;
		const exaCanMatchMode = options.exa !== undefined && canServe(options.exa, normalized);
		// Exa is the default non-native semantic path when the user has supplied
		// its key. Selection happens before execution; an Exa failure is final.
		if (exaConfigured && exaCanMatchMode) return options.exa!;
		if (exaConfigured && mode !== "auto" && options.exa !== undefined && !exaCanMatchMode) {
			return unavailable(`Exa cannot satisfy ${mode} search semantics`, "exa");
		}
		const braveCanMatchMode = options.brave !== undefined && canServe(options.brave, normalized);
		const braveConfigured = options.braveConfigured === true;
		const braveAllowed = policy === "allow-configured-metered" || options.braveFreeCapacityConfigured === true;
		if (braveCanMatchMode && braveConfigured && braveAllowed) {
			if (options.braveCapacity !== undefined && !options.braveCapacity.canAttempt()) {
				const info = options.braveCapacity.snapshot();
				throw createProviderError({ provider: "brave", kind: "rateLimit", message: "Brave quota window is exhausted", retryable: true, rateLimits: info, retryAfterMs: info?.retryAfterMs });
			}
			return options.brave!;
		}
		if (braveConfigured && !braveAllowed) {
			return unavailable("Brave is configured but free-mode admission is disabled; set PI_SEARCH_BRAVE_FREE_ONLY=1 or PI_SEARCH_ALLOW_METERED=1", "router");
		}
		if (braveConfigured && mode !== "auto" && options.brave !== undefined && !braveCanMatchMode) {
			return unavailable(`Brave cannot satisfy ${mode} search semantics`, "brave");
		}
		return unavailable("No eligible search provider is configured; configure a provider or use an active grounded model", "router");
	};
}
