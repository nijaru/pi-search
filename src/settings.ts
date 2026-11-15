import { SEARCH_PROVIDER_HINT_IDS, type SearchProviderHintId } from "./contracts";

export interface SearchPreferences {
	readonly primary?: SearchProviderHintId;
	readonly executionModel?: string;
	readonly fallbacks?: readonly SearchProviderHintId[];
	readonly researchEnabled: boolean;
}

function provider(value: string | undefined, name: string): SearchProviderHintId | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (name === "PI_SEARCH_PROVIDER" && normalized === "auto") return undefined;
	const id = SEARCH_PROVIDER_HINT_IDS.find(id => id === normalized);
	if (id === undefined) throw new Error(`${name} must name a supported search provider${name === "PI_SEARCH_PROVIDER" ? " or auto" : ""}`);
	return id;
}

/** Capture installation preferences once; never persist credentials or chat state. */
export function searchPreferences(env: Readonly<Record<string, string | undefined>>): SearchPreferences {
	const primary = provider(env.PI_SEARCH_PROVIDER, "PI_SEARCH_PROVIDER");
	const order = env.PI_SEARCH_FALLBACK_PROVIDERS;
	const fallbacks = order === undefined ? undefined : order.trim() === "" ? []
		: order.split(",").map(id => provider(id, "PI_SEARCH_FALLBACK_PROVIDERS")!);
	if (fallbacks !== undefined && new Set(fallbacks).size !== fallbacks.length) throw new Error("PI_SEARCH_FALLBACK_PROVIDERS must not contain duplicates");
	const model = env.PI_SEARCH_MODEL?.trim();
	if (model !== undefined && (model.length === 0 || model.length > 500)) throw new Error("PI_SEARCH_MODEL must contain 1-500 characters");
	if (model !== undefined && primary === undefined) throw new Error("PI_SEARCH_MODEL requires an explicit PI_SEARCH_PROVIDER");
	const research = env.PI_SEARCH_ENABLE_RESEARCH;
	if (research !== undefined && research !== "0" && research !== "1") throw new Error("PI_SEARCH_ENABLE_RESEARCH must be 0 or 1");
	return { primary, fallbacks, executionModel: model, researchEnabled: research === "1" };
}
