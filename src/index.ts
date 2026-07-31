import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBraveProvider, BraveQuotaTracker } from "./brave";
import { registerWebFetch } from "./fetch-tool";
import { createOpenAIProvider } from "./openai";
import { createSearchRouter } from "./router";
import { registerWebResearch } from "./research-tool";
import { registerWebSearch } from "./search-tool";

/**
 * Native OpenAI/Codex search is the strict default for its active model. Brave
 * is optional for non-native keyword/fresh searches; no paid search provider
 * or remote extraction fallback is enabled implicitly.
 */
export default function (pi: ExtensionAPI): void {
	const braveKey = process.env.BRAVE_API_KEY;
	const braveCapacity = new BraveQuotaTracker();
	const brave = createBraveProvider({ apiKey: braveKey, capacityTracker: braveCapacity });
	const openai = createOpenAIProvider({ provider: "openai" });
	const codex = createOpenAIProvider({ provider: "openai-codex" });
	const billingPolicy = process.env.PI_SEARCH_ALLOW_METERED === "1" ? "allow-configured-metered" : "free-only";
	const braveFreeCapacityConfigured = process.env.PI_SEARCH_BRAVE_FREE_ONLY === "1";
	const route = createSearchRouter({
		openai,
		openaiCodex: codex,
		brave,
		braveConfigured: braveKey !== undefined && braveKey.trim().length > 0,
		braveFreeCapacityConfigured,
		braveCapacity,
		billingPolicy,
	});
	registerWebSearch(pi, route);
	registerWebFetch(pi);
	registerWebResearch(pi, route);
}
