import type { ProviderAuthResult, ProviderContext, ProviderHeaders, ProviderModel, SearchRequest } from "./contracts";
import { createProviderError } from "./errors";

export interface ModelExecution {
	readonly model: ProviderModel;
	readonly auth: Extract<ProviderAuthResult, { readonly ok: true }>;
}

interface ModelSelectionOptions {
	readonly searchProvider: "gemini" | "xai" | "xai-x" | "openai-codex";
	readonly modelProvider: "google" | "xai" | "openai-codex";
	readonly api: "google-generative-ai" | "openai-responses" | "openai-codex-responses";
	readonly request: SearchRequest;
	readonly context: ProviderContext;
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
 * Resolve one explicitly requested or active model without reading Pi auth
 * state directly. Cross-provider execution requires an explicit model id so a
 * stored subscription cannot silently create a metered request.
 */
export async function selectModelExecution(options: ModelSelectionOptions): Promise<ModelExecution> {
	const registry = options.context.modelRegistry;
	if (registry === undefined) {
		throw createProviderError({ provider: options.searchProvider, kind: "auth", message: "Pi model authentication is unavailable", retryable: false });
	}
	const available = candidates(options);
	const requested = options.request.executionModel;
	const active = options.context.model;
	const selected = requested === undefined
		? (active === undefined ? undefined : available.find((model) => model.provider === active.provider && model.api === active.api && model.id === active.id))
		: available.find((model) => model.id === requested);
	if (selected === undefined) {
		if (requested === undefined) {
			throw createProviderError({
				provider: options.searchProvider,
				kind: "unsupported",
				message: `An explicit executionModel is required when ${options.searchProvider} is not the active model`,
				retryable: false,
			});
		}
		throw createProviderError({
			provider: options.searchProvider,
			kind: "unsupported",
			message: `Model ${requested} is not an available ${options.searchProvider} search model`,
			retryable: false,
		});
	}
	let auth: ProviderAuthResult;
	try {
		auth = await registry.getApiKeyAndHeaders(selected);
	} catch (error) {
		throw createProviderError({ provider: options.searchProvider, kind: "auth", message: "Pi model authentication could not be resolved", retryable: false, cause: error });
	}
	if (!auth.ok) {
		throw createProviderError({ provider: options.searchProvider, kind: "auth", message: `Pi model authentication is not configured for ${selected.id}`, retryable: false });
	}
	return { model: selected, auth };
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
