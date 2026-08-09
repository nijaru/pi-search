const LLAMA_NESTED_MAX_LENGTH_THRESHOLD = 2_000;
export const LLAMA_SAFE_NESTED_MAX_LENGTH = LLAMA_NESTED_MAX_LENGTH_THRESHOLD - 1;

const OPENAI_COMPATIBLE_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

export interface ModelEndpointIdentity {
	readonly api: string;
	readonly baseUrl: string;
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [first, second] = parts;
	return first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function isLocalEndpoint(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const hostname = url.hostname.toLowerCase();
		return hostname === "localhost" || hostname.endsWith(".local") || !hostname.includes(".") || isPrivateIpv4(hostname) || isPrivateIpv6(hostname);
	} catch {
		return false;
	}
}

/**
 * Pi does not expose the upstream server implementation. Local/private
 * OpenAI-compatible endpoints are therefore the safe compatibility boundary:
 * llama.cpp is fixed without changing schemas sent to hosted providers.
 */
export function isLocalOpenAICompatibleModel(model: ModelEndpointIdentity | undefined): boolean {
	if (model === undefined || !OPENAI_COMPATIBLE_APIS.has(model.api)) return false;
	return isLocalEndpoint(model.baseUrl);
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adaptResearchParameters(parameters: unknown): unknown {
	if (!isJsonObject(parameters) || !isJsonObject(parameters.properties)) return parameters;
	const queries = parameters.properties.queries;
	if (!isJsonObject(queries) || !isJsonObject(queries.items) || queries.items.type !== "string") return parameters;
	const maxLength = queries.items.maxLength;
	if (typeof maxLength !== "number" || maxLength < LLAMA_NESTED_MAX_LENGTH_THRESHOLD) return parameters;
	return {
		...parameters,
		properties: {
			...parameters.properties,
			queries: {
				...queries,
				items: { ...queries.items, maxLength: LLAMA_SAFE_NESTED_MAX_LENGTH },
			},
		},
	};
}

function rewritePayload(value: unknown): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		const rewritten = value.map((item) => {
			const result = rewritePayload(item);
			changed ||= result.changed;
			return result.value;
		});
		return { value: changed ? rewritten : value, changed };
	}
	if (!isJsonObject(value)) return { value, changed: false };

	let changed = false;
	let rewritten: JsonObject = value;
	for (const [key, child] of Object.entries(value)) {
		const result = rewritePayload(child);
		if (result.changed) {
			if (!changed) rewritten = { ...value };
			rewritten[key] = result.value;
			changed = true;
		}
	}

	const toolName = typeof rewritten.name === "string" ? rewritten.name : undefined;
	if (toolName === "web_research") {
		const directParameters = adaptResearchParameters(rewritten.parameters);
		if (directParameters !== rewritten.parameters) {
			if (!changed) rewritten = { ...rewritten };
			rewritten.parameters = directParameters;
			changed = true;
		}
		const functionDefinition = rewritten.function;
		if (isJsonObject(functionDefinition)) {
			const functionParameters = adaptResearchParameters(functionDefinition.parameters);
			if (functionParameters !== functionDefinition.parameters) {
				if (!changed) rewritten = { ...rewritten };
				rewritten.function = { ...functionDefinition, parameters: functionParameters };
				changed = true;
			}
		}
	}

	return { value: rewritten, changed };
}

/**
 * Adapt only the outgoing JSON schema for local llama-compatible tool calls.
 * The input is treated as immutable and returned by identity when unchanged.
 */
export function adaptLocalLlamaPayload(payload: unknown): unknown {
	return rewritePayload(payload).value;
}
