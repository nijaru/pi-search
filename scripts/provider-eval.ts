import type { ProviderUsage, SearchResponse } from "../src/contracts";

export interface ProviderEvalCase {
	readonly id: string;
	readonly role: string;
	readonly minResults?: number;
	readonly includeDomains?: readonly string[];
	readonly excludeDomains?: readonly string[];
	readonly requireExcerpt?: boolean;
	readonly requirePublishedAt?: boolean;
	readonly requireSocial?: boolean;
}

export interface ProviderEvalObservation {
	readonly case: ProviderEvalCase;
	readonly response: SearchResponse;
}

export interface ProviderEvalMetrics {
	readonly caseId: string;
	readonly role: string;
	readonly provider: string;
	readonly resultCount: number;
	readonly uniqueResultCount: number;
	readonly inspectableUrlRate: number;
	readonly titleCoverage: number;
	readonly excerptCoverage: number;
	readonly publishedDateCoverage: number;
	readonly provenanceCoverage: number;
	readonly hardConstraintCompliance: number;
	readonly socialResultRate: number;
	readonly passes: boolean;
	readonly usage?: ProviderUsage;
	readonly latencyMs?: number;
}

export interface ProviderEvalSummary {
	readonly provider: string;
	readonly cases: number;
	readonly passedCases: number;
	readonly average: Omit<ProviderEvalMetrics, "caseId" | "role" | "provider" | "passes" | "usage" | "latencyMs">;
	readonly usage: ProviderUsage;
}

function domainMatches(hostname: string, domain: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const expected = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
	return host === expected || host.endsWith(`.${expected}`);
}

function resultUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
		return url;
	} catch {
		return undefined;
	}
}

function fraction(value: number, total: number): number {
	return total === 0 ? 0 : value / total;
}

function constraintCompliance(response: SearchResponse, testCase: ProviderEvalCase): number {
	const include = testCase.includeDomains ?? [];
	const exclude = testCase.excludeDomains ?? [];
	if (include.length === 0 && exclude.length === 0) return 1;
	if (response.results.length === 0) return 0;
	let compliant = 0;
	for (const result of response.results) {
		const url = resultUrl(result.url);
		if (url === undefined) continue;
		const included = include.length === 0 || include.some((domain) => domainMatches(url.hostname, domain));
		const excluded = exclude.some((domain) => domainMatches(url.hostname, domain));
		if (included && !excluded) compliant += 1;
	}
	return fraction(compliant, response.results.length);
}

function socialResult(resultUrlValue: string): boolean {
	const url = resultUrl(resultUrlValue);
	if (url === undefined) return false;
	return ["x.com", "twitter.com", "mobile.twitter.com", "t.co"].some((domain) => domainMatches(url.hostname, domain));
}

/** Measure inspectability and contract compliance without judging relevance. */
export function evaluateProviderResponse(observation: ProviderEvalObservation): ProviderEvalMetrics {
	const { case: testCase, response } = observation;
	const results = response.results;
	const inspectable = results.filter((result) => resultUrl(result.url) !== undefined);
	const uniqueUrls = new Set(inspectable.map((result) => result.url));
	const provenance = results.filter((result) => result.provider === response.provider && result.searchQuery.trim().length > 0);
	const excerptCount = results.filter((result) => result.excerpt?.trim().length).length;
	const titleCount = results.filter((result) => result.title?.trim().length).length;
	const dateCount = results.filter((result) => result.publishedAt !== undefined).length;
	const socialCount = results.filter((result) => socialResult(result.url)).length;
	const hardConstraintCompliance = constraintCompliance(response, testCase);
	const passes =
		results.length >= (testCase.minResults ?? 1) &&
		hardConstraintCompliance === 1 &&
		(!testCase.requireExcerpt || excerptCount === results.length) &&
		(!testCase.requirePublishedAt || dateCount === results.length) &&
		(!testCase.requireSocial || socialCount > 0);
	return {
		caseId: testCase.id,
		role: testCase.role,
		provider: response.provider,
		resultCount: results.length,
		uniqueResultCount: uniqueUrls.size,
		inspectableUrlRate: fraction(inspectable.length, results.length),
		titleCoverage: fraction(titleCount, results.length),
		excerptCoverage: fraction(excerptCount, results.length),
		publishedDateCoverage: fraction(dateCount, results.length),
		provenanceCoverage: fraction(provenance.length, results.length),
		hardConstraintCompliance,
		socialResultRate: fraction(socialCount, results.length),
		passes,
		...(response.usage === undefined ? {} : { usage: response.usage }),
		...(response.latencyMs === undefined ? {} : { latencyMs: response.latencyMs }),
	};
}

function average(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Aggregate role metrics without turning incomparable providers into one score. */
export function summarizeProviderEvaluations(observations: readonly ProviderEvalObservation[]): readonly ProviderEvalSummary[] {
	const metrics = observations.map(evaluateProviderResponse);
	const byProvider = new Map<string, ProviderEvalMetrics[]>();
	for (const metric of metrics) byProvider.set(metric.provider, [...(byProvider.get(metric.provider) ?? []), metric]);
	return [...byProvider.entries()].map(([provider, entries]) => ({
		provider,
		cases: entries.length,
		passedCases: entries.filter((entry) => entry.passes).length,
		average: {
			resultCount: average(entries.map((entry) => entry.resultCount)),
			uniqueResultCount: average(entries.map((entry) => entry.uniqueResultCount)),
			inspectableUrlRate: average(entries.map((entry) => entry.inspectableUrlRate)),
			titleCoverage: average(entries.map((entry) => entry.titleCoverage)),
			excerptCoverage: average(entries.map((entry) => entry.excerptCoverage)),
			publishedDateCoverage: average(entries.map((entry) => entry.publishedDateCoverage)),
			provenanceCoverage: average(entries.map((entry) => entry.provenanceCoverage)),
			hardConstraintCompliance: average(entries.map((entry) => entry.hardConstraintCompliance)),
			socialResultRate: average(entries.map((entry) => entry.socialResultRate)),
		},
		usage: entries.reduce<ProviderUsage>((total, entry) => ({
			...(total.costUsd === undefined && entry.usage?.costUsd === undefined ? {} : { costUsd: (total.costUsd ?? 0) + (entry.usage?.costUsd ?? 0) }),
			...(total.inputTokens === undefined && entry.usage?.inputTokens === undefined ? {} : { inputTokens: (total.inputTokens ?? 0) + (entry.usage?.inputTokens ?? 0) }),
			...(total.outputTokens === undefined && entry.usage?.outputTokens === undefined ? {} : { outputTokens: (total.outputTokens ?? 0) + (entry.usage?.outputTokens ?? 0) }),
			...(total.totalTokens === undefined && entry.usage?.totalTokens === undefined ? {} : { totalTokens: (total.totalTokens ?? 0) + (entry.usage?.totalTokens ?? 0) }),
		}), {}),
	}));
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (path === undefined) throw new Error("Usage: bun scripts/provider-eval.ts <observations.json>");
	const input = await Bun.file(path).json() as unknown;
	if (!Array.isArray(input)) throw new Error("Evaluation input must be an array of {case,response} observations");
	const observations = input as ProviderEvalObservation[];
	console.log(JSON.stringify({ metrics: observations.map(evaluateProviderResponse), summary: summarizeProviderEvaluations(observations) }, null, 2));
}

if (import.meta.main) await main();
