import type { ProviderAuthResult, ProviderContext, ProviderHeaders, ProviderId, ProviderModel, SearchRequest } from "./contracts";
import { createProviderError, isProviderError } from "./errors";

export interface ModelExecution {
	readonly model: ProviderModel;
	readonly auth: Extract<ProviderAuthResult, { readonly ok: true }>;
}

interface ModelSelectionOptions {
	// Provider strings stay open so new native adapters (Anthropic, Meta,
	// future Responses-family vendors) need no changes here; callers pass
	// the Pi model-registry `provider`/`api` pair the adapter requires.
	readonly searchProvider: ProviderId;
	readonly modelProvider: string;
	readonly api: string;
	readonly request: SearchRequest;
	readonly context: ProviderContext;
	/**
	 * Select an available registry model automatically when the active model
	 * is not a compatible execution target. The router only dispatches here
	 * after confirming a registry model is available, so this preserves the
	 * built-in-search guarantee for non-native active models (DESIGN: backend
	 * resolution step 2). Explicit cross-provider hints never reach this path
	 * without an executionModel; the router rejects those first.
	 */
	readonly allowRegistryFallback?: boolean;
}

function compatible(model: ProviderModel, options: ModelSelectionOptions): boolean {
	return model.provider === options.modelProvider && model.api === options.api;
}

function candidates(options: ModelSelectionOptions): ProviderModel[] {
	const active = options.context.model === undefined ? [] : [options.context.model];
	const registry = options.context.modelRegistry?.getModels?.() ?? [];
	const result: ProviderModel[] = [];
	const seen = new Set<string>();
	for (const model of [...active, ...registry]) {
		if (!compatible(model, options)) continue;
		const key = `${model.provider}:${model.api}:${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(model);
	}
	return result;
}

/**
 * Resolve one explicitly requested, active, or router-sanctioned registry
 * model without reading Pi auth state directly. Cross-provider execution that
 * was not router-initiated still requires an explicit model id so a stored
 * subscription cannot silently create a metered request.
 */
export async function selectModelExecution(options: ModelSelectionOptions): Promise<ModelExecution> {
	const registry = options.context.modelRegistry;
	if (registry === undefined) {
		throw createProviderError({ provider: options.searchProvider, kind: "auth", message: "Pi model authentication is unavailable", retryable: false });
	}
	const available = candidates(options);
	const requested = options.request.executionModel;
	const active = options.context.model;
	const activeMatch = active === undefined
		? undefined
		: available.find((model) => model.provider === active.provider && model.api === active.api && model.id === active.id);
	if (requested !== undefined) {
		const requestedMatch = available.find((model) => model.id === requested);
		if (requestedMatch === undefined) {
			throw createProviderError({
				provider: options.searchProvider,
				kind: "unsupported",
				message: `Model ${requested} is not an available ${options.searchProvider} search model`,
				retryable: false,
			});
		}
		return authenticate(requestedMatch, registry, options);
	}
	if (activeMatch !== undefined) return authenticate(activeMatch, registry, options);
	if (options.allowRegistryFallback === true && available.length > 0) {
		// The router dispatched here because a compatible registry model is
		// available (DESIGN backend-resolution step 2). Try candidates in the
		// registry's own order; Pi lists default models first. Preserve the last
		// auth failure so an unauthenticated registry reports an auth problem,
		// not a misleading model-selection problem.
		let lastAuthError: unknown;
		for (const candidate of available) {
			try {
				return await authenticate(candidate, registry, options);
			} catch (error) {
				if (isProviderError(error) && error.kind === "auth") lastAuthError = error;
			}
		}
		if (lastAuthError !== undefined) throw lastAuthError;
	}
	throw createProviderError({
		provider: options.searchProvider,
		kind: "unsupported",
		message: `An explicit executionModel is required when ${options.searchProvider} is not the active model`,
		retryable: false,
	});
}

async function authenticate(model: ProviderModel, registry: NonNullable<ProviderContext["modelRegistry"]>, options: ModelSelectionOptions): Promise<ModelExecution> {
	let auth: ProviderAuthResult;
	try {
		auth = await registry.getApiKeyAndHeaders(model);
	} catch (error) {
		throw createProviderError({ provider: options.searchProvider, kind: "auth", message: "Pi model authentication could not be resolved", retryable: false, cause: error });
	}
	if (!auth.ok) {
		throw createProviderError({ provider: options.searchProvider, kind: "auth", message: `Pi model authentication is not configured for ${model.id}`, retryable: false });
	}
	return { model, auth };
}

export interface ModelAuthHeaderOptions {
	/** Google Generative AI uses x-goog-api-key rather than a bearer header. */
	readonly bearerApiKey?: boolean;
}

export function applyProviderHeaders(headers: Headers, source: ProviderHeaders | undefined): void {
	if (source === undefined) return;
	for (const [key, value] of Object.entries(source)) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
}

export function modelAuthHeaders(execution: ModelExecution, options: ModelAuthHeaderOptions = {}): Headers {
	const headers = new Headers();
	applyProviderHeaders(headers, execution.model.headers);
	applyProviderHeaders(headers, execution.auth.headers);
	if (options.bearerApiKey !== false && execution.auth.apiKey !== undefined && execution.auth.apiKey.trim().length > 0) headers.set("authorization", `Bearer ${execution.auth.apiKey}`);
	return headers;
}
