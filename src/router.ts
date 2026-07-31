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
	readonly brave?: Provider;
	readonly exa?: Provider;
	/** Credential presence is supplied by the construction boundary. */
	readonly braveConfigured?: boolean;
	/** Explicit user assertion that Brave calls are covered by free capacity. */
	readonly braveFreeCapacityConfigured?: boolean;
	readonly exaConfigured?: boolean;
	readonly braveCapacity?: BraveCapacityTracker;
	/** Defaults to free-only to prevent an unexpected metered request. */
	readonly billingPolicy?: SearchBillingPolicy;
}

export type SearchProviderResolver = (request: SearchRequest, context: ExtensionContext) => Provider;

function unavailable(message: string, provider: ProviderId = "router"): never {
	throw createProviderError({ provider, kind: "unavailable", message, retryable: false });
}

function meteredAllowed(policy: SearchBillingPolicy): boolean {
	return policy === "prefer-free" || policy === "allow-configured-metered";
}

function modeCapability(request: SearchRequest): keyof Provider["capabilities"] | undefined {
	switch (request.mode) {
		case "semantic":
			return "semantic";
		case "keyword":
			return "keyword";
		case "fresh":
			return "freshness";
		case "multiHop":
			return "multiHop";
		case "social":
			return "social";
		default:
			return undefined;
	}
}

function canServe(provider: Provider, request: SearchRequest): boolean {
	const mode = modeCapability(request);
	if (mode !== undefined && provider.capabilities[mode] !== true) return false;
	if ((request.domains?.include?.length || request.domains?.exclude?.length) && provider.capabilities.domainFilter !== true) return false;
	if ((request.publishedAfter !== undefined || request.publishedBefore !== undefined) && provider.capabilities.dateFilter !== true) return false;
	return true;
}

function explicitProvider(
	request: SearchRequest,
	context: ExtensionContext,
	options: SearchRouterOptions,
	policy: SearchBillingPolicy,
): Provider {
	const provider = request.providerHint;
	if (provider === undefined) return unavailable("No provider was selected");
	if (provider === "openai") {
		if (context.model?.provider !== "openai" || options.openai === undefined) return unavailable("OpenAI native search requires an active OpenAI model", provider);
		return options.openai;
	}
	if (provider === "openai-codex") {
		if (context.model?.provider !== "openai-codex" || options.openaiCodex === undefined) return unavailable("Codex native search requires an active Codex model", provider);
		return options.openaiCodex;
	}
	if (provider === "brave") {
		if (options.brave === undefined || options.braveConfigured !== true) return unavailable("Brave search is not configured", provider);
		if (policy !== "allow-configured-metered" && options.braveFreeCapacityConfigured !== true) return unavailable("Brave free capacity is not explicitly enabled", provider);
		if (options.braveCapacity !== undefined && !options.braveCapacity.canAttempt()) {
			throw createProviderError({ provider: "brave", kind: "rateLimit", message: "Brave quota window is exhausted", retryable: true, rateLimits: options.braveCapacity.snapshot(), retryAfterMs: options.braveCapacity.snapshot()?.retryAfterMs });
		}
		if (!canServe(options.brave, request)) return unavailable("Brave cannot satisfy the requested search constraints", provider);
		return options.brave;
	}
	if (provider === "exa") {
		if (options.exa === undefined || options.exaConfigured !== true) return unavailable("Exa search is not configured", provider);
		if (!meteredAllowed(policy)) return unavailable("Exa is metered and disabled by the search billing policy", provider);
		if (!canServe(options.exa, request)) return unavailable("Exa cannot satisfy the requested search constraints", provider);
		return options.exa;
	}
	return unavailable(`Search provider ${provider} is not configured`, provider);
}

/**
 * Select exactly one provider before the call. A selected provider's failure
 * is final; this function never retries or silently switches vendors.
 */
export function createSearchRouter(options: SearchRouterOptions): SearchProviderResolver {
	const policy = options.billingPolicy ?? "free-only";
	return (request, context) => {
		const normalized = validateSearchRequest(request);
		if (normalized.providerHint !== undefined) return explicitProvider(normalized, context, options, policy);

		// Native subscription capability always wins for its active model.
		if (context.model?.provider === "openai-codex") {
			if (options.openaiCodex === undefined) return unavailable("Codex native search is not registered", "openai-codex");
			return options.openaiCodex;
		}
		if (context.model?.provider === "openai") {
			if (options.openai === undefined) return unavailable("OpenAI native search is not registered", "openai");
			return options.openai;
		}

		const mode = normalized.mode ?? "auto";
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

		if (options.exa !== undefined && options.exaConfigured === true && meteredAllowed(policy) && canServe(options.exa, normalized)) {
			return options.exa;
		}

		if (braveConfigured && braveAllowed && mode !== "auto" && options.brave !== undefined && !braveCanMatchMode) {
			return unavailable(`Brave cannot satisfy ${mode} search semantics`, "brave");
		}
		return unavailable(
			braveConfigured && !braveAllowed
				? "Brave is configured but free capacity is not explicitly enabled; set PI_SEARCH_BRAVE_FREE_ONLY=1 or PI_SEARCH_ALLOW_METERED=1"
				: braveConfigured
					? "Brave is unavailable for this request and metered fallback is disabled"
					: "No free search provider is configured; set BRAVE_API_KEY or explicitly allow configured metered providers",
			"router",
		);
	};
}
