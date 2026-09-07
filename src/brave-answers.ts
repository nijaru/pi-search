import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderProfile,
	ProviderUsage,
	SearchOption,
	SearchRequest,
	SearchResponse,
	SearchResult,
	SearchWarning,
} from "./contracts";
import { createProviderError } from "./errors";
import { cancelResponseBody, readBoundedResponseText } from "./http";
import { httpSource, objectValue, optionalString, requireApiKey, retryAfterMsFromHeaders, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

/**
 * Brave AI Answers — opt-in answer-synthesis provider.
 *
 * POST https://api.search.brave.com/res/v1/chat/completions with model
 * "brave". Citations and usage require streaming, so the request runs with
 * `stream: true` and the adapter accumulates the answer text plus inline
 * `<citation>{…}</citation>` tags and a trailing `<usage>{…}</usage>` tag
 * from the SSE delta stream. Billing is metered separately from Brave search
 * ($4 per 1K requests plus $5 per 1M tokens), so this provider registers
 * only under `PI_SEARCH_ENABLE_BRAVE_ANSWERS=1` and is never covered by the
 * free-mode admission gates that govern Brave search. Explicit provider hint
 * only — never automatic routing, never the `native` alias.
 */

export const BRAVE_ANSWERS_ENDPOINT = "https://api.search.brave.com/res/v1/chat/completions";
export const DEFAULT_BRAVE_ANSWERS_BYTES = 4 * 1024 * 1024;
const MAX_ANSWER_LENGTH = 8_000;
const MAX_SOURCE_URL_LENGTH = 8_192;
const MAX_SOURCE_TITLE_LENGTH = 500;
const MAX_SSE_EVENTS = 5_000;

export interface BraveAnswersAdapterOptions {
	readonly apiKey?: string;
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = {
	semantic: true,
	freshness: true,
	excerpts: false,
	nativeGrounding: true,
	searchContextSize: true,
	userLocation: true,
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "usage-based",
};

export interface BraveAnswersPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

export function buildBraveAnswersRequest(request: SearchRequest): BraveAnswersPlan {
	const normalized = validateSearchRequest(request);
	const hardConstraints: SearchOption[] = [];
	if (normalized.domains?.include?.length || normalized.domains?.exclude?.length) hardConstraints.push("domains");
	if (normalized.dateRange !== undefined) hardConstraints.push("dateRange");
	if (normalized.social !== undefined) hardConstraints.push("social");
	if (normalized.returnTokenBudget !== undefined) hardConstraints.push("returnTokenBudget");
	if (normalized.externalWebAccess !== undefined) hardConstraints.push("externalWebAccess");
	if (normalized.searchContentTypes !== undefined) hardConstraints.push("searchContentTypes");
	if (normalized.imageSettings !== undefined) hardConstraints.push("imageSettings");
	if (hardConstraints.length > 0) {
		throw createProviderError({
			provider: "brave-answers",
			kind: "unsupported",
			message: `Brave Answers does not expose ${hardConstraints.join(", ")} controls`,
			retryable: false,
		});
	}
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "keyword") warnings.push({ code: "unsupported-option", option: "mode", message: "Brave Answers researches the question semantically; keyword-only ranking is not guaranteed" });
	if (normalized.mode === "fresh") warnings.push({ code: "unsupported-option", option: "mode", message: "Brave Answers uses current sources but does not guarantee a freshness-only ranking" });
	if (normalized.maxResults !== undefined) warnings.push({ code: "unsupported-option", option: "maxResults", message: "Brave Answers returns the sources its answer cited; the result count is not configurable" });
	const webSearchOptions = {
		search_context_size: normalized.searchContextSize ?? "medium",
		...(normalized.userLocation === undefined ? {} : {
			user_location: {
				type: normalized.userLocation.type,
				...(normalized.userLocation.country === undefined ? {} : { country: normalized.userLocation.country }),
				...(normalized.userLocation.region === undefined ? {} : { region: normalized.userLocation.region }),
				...(normalized.userLocation.city === undefined ? {} : { city: normalized.userLocation.city }),
				...(normalized.userLocation.timezone === undefined ? {} : { timezone: normalized.userLocation.timezone }),
			},
		}),
	};
	const appliedOptions: SearchOption[] = ["mode", ...(normalized.searchContextSize === undefined ? [] : ["searchContextSize" as const]), ...(normalized.userLocation === undefined ? [] : ["userLocation" as const])];
	return {
		body: {
			model: "brave",
			stream: true,
			enable_citations: true,
			messages: [{ role: "user", content: normalized.query }],
			web_search_options: webSearchOptions,
		},
		appliedOptions,
		warnings,
	};
}

function malformed(message: string): never {
	throw createProviderError({ provider: "brave-answers", kind: "malformed", message: `Brave Answers returned a malformed response (${message})`, retryable: false });
}

interface CitationCandidate {
	readonly url: string;
	readonly title?: string;
	readonly startIndex?: number;
	readonly endIndex?: number;
	readonly snippet?: string;
}

/** Parse one SSE chat-completions chunk body for delta text. */
function deltaTextFromEvent(payload: unknown): string {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "";
	const record = payload as Record<string, unknown>;
	const choices = Array.isArray(record.choices) ? record.choices : [];
	let text = "";
	for (const choice of choices) {
		if (typeof choice !== "object" || choice === null || Array.isArray(choice)) continue;
		const choiceRecord = choice as Record<string, unknown>;
		const delta = choiceRecord.delta;
		if (typeof delta !== "object" || delta === null || Array.isArray(delta)) continue;
		const content = (delta as Record<string, unknown>).content;
		if (typeof content === "string") text += content;
	}
	return text;
}

/**
 * Accumulate answer text, citation tags, and usage from the streamed tags.
 * Citation and usage tags may split across SSE deltas, so tag fragments are
 * buffered until their closing marker arrives.
 */
export function extractTaggedAnswer(streamedText: string): {
	readonly text: string;
	readonly citations: readonly CitationCandidate[];
	readonly usage?: Record<string, unknown>;
} {
	const citations: CitationCandidate[] = [];
	let usage: Record<string, unknown> | undefined;
	let text = "";
	let remainder = streamedText;
	while (remainder.length > 0) {
		const citationStart = remainder.indexOf("<citation>");
		const usageStart = remainder.indexOf("<usage>");
		if (citationStart === -1 && usageStart === -1) {
			text += remainder;
			break;
		}
		const useCitation = citationStart !== -1 && (usageStart === -1 || citationStart < usageStart);
		const tagStart = useCitation ? citationStart : usageStart;
		const tagName = useCitation ? "citation" : "usage";
		const closer = `</${tagName}>`;
		const closeIndex = remainder.indexOf(closer, tagStart);
		if (closeIndex === -1) {
			// Unterminated tag: keep as text; a valid stream always closes tags.
			text += remainder;
			break;
		}
		text += remainder.slice(0, tagStart);
		const inner = remainder.slice(tagStart + tagName.length + 2, closeIndex).trim();
		try {
			const parsed = JSON.parse(inner) as unknown;
			if (useCitation) {
				const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
				const parsedUrl = httpSource(record.url, "brave-answers");
				if (parsedUrl !== undefined && parsedUrl.url.length <= MAX_SOURCE_URL_LENGTH) {
					const title = optionalString(record.favicon, MAX_SOURCE_TITLE_LENGTH) ?? optionalString(record.title, MAX_SOURCE_TITLE_LENGTH);
					citations.push({
						url: parsedUrl.url,
						...(title === undefined ? {} : { title }),
						...(typeof record.start_index === "number" && Number.isFinite(record.start_index) && record.start_index >= 0 ? { startIndex: Math.round(record.start_index) } : {}),
						...(typeof record.end_index === "number" && Number.isFinite(record.end_index) && record.end_index >= 0 ? { endIndex: Math.round(record.end_index) } : {}),
						...(optionalString(record.snippet, 4_000) === undefined ? {} : { snippet: optionalString(record.snippet, 4_000) }),
					});
				}
			} else if (usage === undefined) {
				usage = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
			}
		} catch {
			// Malformed tag JSON: drop the tag, keep the surrounding text.
		}
		remainder = remainder.slice(closeIndex + closer.length);
	}
	return { text: text.trim(), citations, usage };
}

function usageFromTagged(usage: Record<string, unknown> | undefined): ProviderUsage | undefined {
	if (usage === undefined) return undefined;
	const number = (key: string): number | undefined => typeof usage[key] === "number" && Number.isFinite(usage[key] as number) && (usage[key] as number) >= 0 ? usage[key] as number : undefined;
	const inputTokens = number("X-Request-Tokens-In");
	const outputTokens = number("X-Request-Tokens-Out");
	const totalCost = number("X-Request-Total-Cost");
	const searchQueries = number("X-Request-Queries");
	const parts: { inputTokens?: number; outputTokens?: number; searchQueries?: number; costUsd?: number } = {};
	if (inputTokens !== undefined) parts.inputTokens = inputTokens;
	if (outputTokens !== undefined) parts.outputTokens = outputTokens;
	if (searchQueries !== undefined) parts.searchQueries = searchQueries;
	if (totalCost !== undefined) parts.costUsd = totalCost;
	if (Object.keys(parts).length === 0) return undefined;
	return parts;
}

/** Read a bounded SSE stream and collect every `data:` JSON chunk. */
async function readSseChunks(response: Response, provider: "brave-answers", signal: AbortSignal, maxBytes: number): Promise<readonly Record<string, unknown>[]> {
	const text = await readBoundedResponseText(response, maxBytes, signal);
	const events: Record<string, unknown>[] = [];
	let dataLines: string[] = [];
	const flush = (): void => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n").trim();
		dataLines = [];
		if (data.length === 0 || data === "[DONE]") return;
		try {
			const parsed = JSON.parse(data) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed as Record<string, unknown>);
		} catch {
			// Ignore non-JSON keepalive lines.
		}
	};
	for (const rawLine of text.split(/\r?\n/)) {
		if (events.length >= MAX_SSE_EVENTS) break;
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			flush();
			continue;
		}
		if (line.startsWith(":")) continue;
		if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	flush();
	return events;
}

export class BraveAnswersProvider implements Provider {
	readonly id = "brave-answers" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: BraveAnswersAdapterOptions = {}) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? BRAVE_ANSWERS_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_BRAVE_ANSWERS_BYTES;
		if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error("Brave Answers maxResponseBytes must be a positive integer");
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildBraveAnswersRequest(normalized);
		// Validate before dispatch so a missing key is an auth error, not network noise.
		requireApiKey(this.id, this.apiKey);
		if (signal.aborted) {
			throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false });
		}
		let response: Response;
		try {
			response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: {
					"x-subscription-token": requireApiKey(this.id, this.apiKey),
					accept: "text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify(plan.body),
				signal,
			});
		} catch (error) {
			if (signal.aborted) {
				throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false, cause: error });
			}
			throw createProviderError({ provider: this.id, kind: "network", message: `${this.id} network request failed`, retryable: true, cause: error });
		}
		const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
		if (response.status === 401 || response.status === 403) {
			await cancelResponseBody(response);
			throw createProviderError({ provider: this.id, kind: "auth", message: `${this.id} authentication failed (HTTP ${response.status})`, status: response.status, retryable: false, ...(requestId === undefined ? {} : { requestId }) });
		}
		if (response.status === 429) {
			await cancelResponseBody(response);
			const retryAfterMs = retryAfterMsFromHeaders(response.headers);
			throw createProviderError({ provider: this.id, kind: "rateLimit", message: `${this.id} rate limit exceeded`, status: response.status, retryable: true, ...(requestId === undefined ? {} : { requestId }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
		}
		if (response.status < 200 || response.status >= 300) {
			await cancelResponseBody(response);
			throw createProviderError({
				provider: this.id,
				kind: response.status === 400 || response.status === 422 ? "badRequest" : "http",
				message: `${this.id} failed with HTTP ${response.status}`,
				status: response.status,
				retryable: response.status === 408 || response.status === 425 || response.status >= 500,
				...(requestId === undefined ? {} : { requestId }),
			});
		}
		const chunks = await readSseChunks(response, this.id, signal, this.maxResponseBytes);
		const streamedText = chunks.map((chunk) => deltaTextFromEvent(chunk)).join("");
		const { text, citations, usage: usageTag } = extractTaggedAnswer(streamedText);
		if (text.length === 0) malformed("stream contained no answer text");
		const limitedText = text.slice(0, MAX_ANSWER_LENGTH);

		const byUrl = new Map<string, CitationCandidate>();
		for (const citation of citations) {
			if (!byUrl.has(citation.url)) byUrl.set(citation.url, citation);
		}
		const results: SearchResult[] = [];
		for (const citation of byUrl.values()) {
			const parsed = httpSource(citation.url, "brave-answers");
			if (parsed === undefined) continue;
			results.push({
				url: parsed.url,
				...(citation.title === undefined ? {} : { title: citation.title }),
				domain: parsed.domain,
				...(citation.snippet === undefined ? {} : { excerpt: citation.snippet }),
				provider: "brave-answers",
				searchQuery: normalized.query,
			});
		}
		if (results.length === 0) malformed("answer cites no HTTP sources");
		const answer = {
			text: limitedText,
			contentTrust: "untrusted" as const,
			provider: "brave-answers" as const,
			citations: [...byUrl.values()].slice(0, normalized.maxResults ?? 10).map((citation) => ({
				url: citation.url,
				...(citation.title === undefined ? {} : { title: citation.title }),
				...(citation.startIndex === undefined ? {} : { startIndex: citation.startIndex }),
				...(citation.endIndex === undefined ? {} : { endIndex: citation.endIndex }),
			})),
		};
		const usage = usageFromTagged(usageTag);
		return {
			query: normalized.query,
			results,
			...(normalized.answerMode === "evidence" ? {} : { answer }),
			provider: "brave-answers",
			appliedOptions: plan.appliedOptions,
			warnings: plan.warnings,
			...(requestId === undefined ? {} : { requestId }),
			...(usage === undefined ? {} : { usage }),
		};
	}
}

export function createBraveAnswersProvider(options: BraveAnswersAdapterOptions): BraveAnswersProvider {
	return new BraveAnswersProvider(options);
}
