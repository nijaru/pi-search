import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBraveProvider, BraveQuotaTracker } from "./brave";
import { createExaProvider } from "./exa";
import { registerWebFetch } from "./fetch-tool";
import { createOpenAIProvider } from "./openai";
import { createSearchRouter } from "./router";
import { registerWebSearch } from "./search-tool";

/**
 * Select native OpenAI/Codex web search for the active Pi model. For other
 * models, Brave is the free-capacity default. Exa is construction-configured
 * but remains disabled unless the user explicitly enables metered providers.
 * No selected-provider failure falls through to another vendor.
 */
export default function (pi: ExtensionAPI): void {
	const braveKey = process.env.BRAVE_API_KEY;
	const exaKey = process.env.EXA_API_KEY;
	const braveCapacity = new BraveQuotaTracker();
	const brave = createBraveProvider({ apiKey: braveKey, capacityTracker: braveCapacity });
	const exa = createExaProvider({ apiKey: exaKey });
	const openai = createOpenAIProvider({ provider: "openai" });
	const codex = createOpenAIProvider({ provider: "openai-codex" });
	const billingPolicy = process.env.PI_SEARCH_ALLOW_METERED === "1" ? "allow-configured-metered" : "free-only";
	const braveFreeCapacityConfigured = process.env.PI_SEARCH_BRAVE_FREE_ONLY === "1";
	const route = createSearchRouter({
		openai,
		openaiCodex: codex,
		brave,
		exa,
		braveConfigured: braveKey !== undefined && braveKey.trim().length > 0,
		braveFreeCapacityConfigured,
		exaConfigured: exaKey !== undefined && exaKey.trim().length > 0,
		braveCapacity,
		billingPolicy,
	});
	registerWebSearch(pi, route);
	registerWebFetch(pi);
}
