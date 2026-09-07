import { SEARCH_PROVIDER_HINT_IDS, type SearchProviderHintId } from "./contracts";

/**
 * Provider hints that can actually be dispatched by the current installation.
 *
 * The tool schemas expose only these ids (plus `native`, which any supported
 * grounded active model can serve), so a calling model never sees options
 * whose keys or enable gates are absent. Native grounding adapters are
 * always listed: any of them can serve through an active or registry model
 * without extra configuration.
 */
export interface ProviderHintAvailability {
	readonly brave?: boolean;
	readonly braveAnswers?: boolean;
	readonly exa?: boolean;
	readonly parallel?: boolean;
	readonly parallelResponses?: boolean;
	readonly x?: boolean;
}

/** Native grounding adapters always stay exposed: any can serve through an
 * active or registry model without extra configuration. */
const NATIVE_HINT_IDS = ["openai", "openai-codex", "gemini", "xai", "xai-x", "anthropic", "meta"] as const satisfies readonly SearchProviderHintId[];

/** Compute the dispatchable explicit-hint ids for this installation. */
export function availableProviderHints(availability: ProviderHintAvailability): readonly SearchProviderHintId[] {
	return SEARCH_PROVIDER_HINT_IDS.filter((id) =>
		NATIVE_HINT_IDS.includes(id as (typeof NATIVE_HINT_IDS)[number])
		|| (id === "brave" && availability.brave === true)
		|| (id === "brave-answers" && availability.braveAnswers === true)
		|| (id === "exa" && availability.exa === true)
		|| (id === "parallel" && availability.parallel === true)
		|| (id === "parallel-responses" && availability.parallelResponses === true)
		|| (id === "x" && availability.x === true));
}
