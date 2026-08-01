import type { ProviderId, SearchRequest, SearchResponse, SearchResult, SearchWarning } from "./contracts";

export const MAX_SEARCH_URL_LENGTH = 8_192;
export const MAX_SEARCH_TITLE_LENGTH = 500;
export const MAX_SEARCH_EXCERPT_LENGTH = 4_000;
export const MAX_SEARCH_DOMAIN_LENGTH = 253;
export const MAX_SEARCH_SOURCE_ID_LENGTH = 500;
export const MAX_SEARCH_QUERY_LENGTH = 2_000;

export interface CanonicalSearchUrl {
	readonly url: string;
	readonly domain: string;
	readonly sourceUrl?: string;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.slice(0, maxLength);
}

/** Normalize only URL components whose identity is unambiguous. */
export function normalizeSearchUrl(value: unknown): CanonicalSearchUrl | undefined {
	if (typeof value !== "string") return undefined;
	const raw = value.trim();
	if (raw.length === 0 || raw.length > MAX_SEARCH_URL_LENGTH) return undefined;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		if (parsed.username || parsed.password) return undefined;
		parsed.hash = "";
		parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
		const url = parsed.href;
		if (url.length > MAX_SEARCH_URL_LENGTH) return undefined;
		const domain = parsed.hostname.toLowerCase().replace(/\.$/, "");
		if (domain.length === 0 || domain.length > MAX_SEARCH_DOMAIN_LENGTH) return undefined;
		return {
			url,
			domain,
			...(url === raw ? {} : { sourceUrl: raw }),
		};
	} catch {
		return undefined;
	}
}

/** Return the conservative identity used to deduplicate search and fetch URLs. */
export function searchUrlIdentity(value: unknown): string | undefined {
	return normalizeSearchUrl(value)?.url;
}

/** Match a canonical result hostname against an exact host or its subdomains. */
export function matchesSearchDomain(hostname: string, domain: string): boolean {
	const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
	const normalizedDomain = domain.toLowerCase().replace(/\.$/, "");
	return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
}

function resultMatchesDomainFilter(result: SearchResult, request: SearchRequest): boolean {
	const include = request.domains?.include;
	const exclude = request.domains?.exclude;
	if (include !== undefined && include.length > 0 && !include.some((domain) => matchesSearchDomain(result.domain ?? "", domain))) {
		return false;
	}
	return exclude === undefined || !exclude.some((domain) => matchesSearchDomain(result.domain ?? "", domain));
}

function optionalTimestamp(value: unknown): string | undefined {
	const candidate = boundedString(value, 100);
	return candidate !== undefined && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function optionalScore(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

function normalizeResult(value: unknown, request: SearchRequest, provider: ProviderId): SearchResult | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const result = value as Partial<SearchResult>;
	const parsed = normalizeSearchUrl(result.url);
	if (parsed === undefined) return undefined;
	const title = boundedString(result.title, MAX_SEARCH_TITLE_LENGTH);
	const publishedAt = optionalTimestamp(result.publishedAt);
	const excerpt = boundedString(result.excerpt, MAX_SEARCH_EXCERPT_LENGTH);
	const sourceId = boundedString(result.sourceId, MAX_SEARCH_SOURCE_ID_LENGTH);
	const score = optionalScore(result.score);
	const suppliedSource = normalizeSearchUrl(result.sourceUrl);
	const sourceUrl = suppliedSource === undefined
		? parsed.sourceUrl
		: suppliedSource.url === parsed.url
			? parsed.sourceUrl
			: boundedString(result.sourceUrl, MAX_SEARCH_URL_LENGTH);
	return {
		url: parsed.url,
		...(sourceUrl === undefined ? {} : { sourceUrl }),
		...(title === undefined ? {} : { title }),
		domain: parsed.domain,
		...(publishedAt === undefined ? {} : { publishedAt }),
		...(excerpt === undefined ? {} : { excerpt }),
		provider,
		searchQuery: request.query,
		...(sourceId === undefined ? {} : { sourceId }),
		...(score === undefined ? {} : { score }),
	};
}

function mergeResult(current: SearchResult, candidate: SearchResult): SearchResult {
	return {
		...current,
		...(current.sourceUrl === undefined && candidate.sourceUrl !== undefined ? { sourceUrl: candidate.sourceUrl } : {}),
		...(current.title === undefined && candidate.title !== undefined ? { title: candidate.title } : {}),
		...(current.publishedAt === undefined && candidate.publishedAt !== undefined ? { publishedAt: candidate.publishedAt } : {}),
		...(current.excerpt === undefined && candidate.excerpt !== undefined ? { excerpt: candidate.excerpt } : {}),
		...(current.sourceId === undefined && candidate.sourceId !== undefined ? { sourceId: candidate.sourceId } : {}),
		...(current.score === undefined && candidate.score !== undefined ? { score: candidate.score } : {}),
	};
}

/** Normalize provider output once at the shared search boundary. */
export function cleanupSearchResponse(response: SearchResponse, request: SearchRequest, provider: ProviderId): SearchResponse {
	const candidates = Array.isArray(response.results) ? response.results : [];
	const results = new Map<string, SearchResult>();
	let discarded = Array.isArray(response.results) ? 0 : 1;
	let domainDiscarded = 0;
	for (const value of candidates) {
		const normalized = normalizeResult(value, request, provider);
		if (normalized === undefined) {
			discarded += 1;
			continue;
		}
		if (!resultMatchesDomainFilter(normalized, request)) {
			domainDiscarded += 1;
			continue;
		}
		const current = results.get(normalized.url);
		results.set(normalized.url, current === undefined ? normalized : mergeResult(current, normalized));
	}
	const warnings: SearchWarning[] = Array.isArray(response.warnings) ? [...response.warnings] : [];
	if (discarded > 0) {
		warnings.push({
			code: "partial-results",
			message: `Search discarded ${discarded} malformed result entr${discarded === 1 ? "y" : "ies"}`,
		});
	}
	if (domainDiscarded > 0) {
		warnings.push({
			code: "partial-results",
			message: `Search removed ${domainDiscarded} result entr${domainDiscarded === 1 ? "y" : "ies"} outside the requested domain constraints`,
		});
	}
	const appliedOptions = [...response.appliedOptions];
	if ((request.domains?.include?.length ?? 0) > 0 || (request.domains?.exclude?.length ?? 0) > 0) {
		if (!appliedOptions.includes("domains")) appliedOptions.push("domains");
	}
	return {
		...response,
		query: request.query,
		provider,
		results: [...results.values()].slice(0, request.maxResults ?? 10),
		appliedOptions,
		warnings,
	};
}
