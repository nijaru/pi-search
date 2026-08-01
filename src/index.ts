import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBraveProvider, BraveQuotaTracker } from "./brave";
import { createExaProvider } from "./exa";
import { createGeminiProvider } from "./gemini";
import { registerWebFetch } from "./fetch-tool";
import { createOpenAIProvider } from "./openai";
import { createParallelProvider } from "./parallel";
import { createSearchRouter } from "./router";
import { createXAIProvider } from "./xai";
import { registerWebResearch } from "./research-tool";
import { registerWebSearch } from "./search-tool";

/**
 * Native grounding is selected for supported active models. Brave is optional
 * for local/non-native models, while Exa and Parallel are explicit metered
 * providers; no provider failure triggers a fallback.
 */
export default function (pi: ExtensionAPI): void {
	const braveKey = process.env.BRAVE_API_KEY;
	const braveFreeOnly = process.env.PI_SEARCH_BRAVE_FREE_ONLY === "1";
	const braveCapacity = new BraveQuotaTracker({ minimumIntervalMs: braveFreeOnly ? 1_000 : 0 });
	const brave = createBraveProvider({ apiKey: braveKey, capacityTracker: braveCapacity });
	const openai = createOpenAIProvider({ provider: "openai" });
	const codex = createOpenAIProvider({ provider: "openai-codex" });
	const gemini = createGeminiProvider();
	const xai = createXAIProvider({ tool: "web_search" });
	const xaiX = createXAIProvider({ tool: "x_search" });
	const exaKey = process.env.EXA_API_KEY;
	const parallelKey = process.env.PARALLEL_API_KEY;
	const exa = createExaProvider({ apiKey: exaKey });
	const parallel = createParallelProvider({ apiKey: parallelKey });
	const billingPolicy = process.env.PI_SEARCH_ALLOW_METERED === "1" ? "allow-configured-metered" : "free-only";
	const braveFreeCapacityConfigured = braveFreeOnly;
	const route = createSearchRouter({
		openai,
		openaiCodex: codex,
		gemini,
		xai,
		xaiX,
		exa,
		parallel,
		brave,
		braveConfigured: braveKey !== undefined && braveKey.trim().length > 0,
		exaConfigured: exaKey !== undefined && exaKey.trim().length > 0,
		parallelConfigured: parallelKey !== undefined && parallelKey.trim().length > 0,
		braveFreeCapacityConfigured,
		braveCapacity,
		billingPolicy,
	});
	registerWebSearch(pi, route);
	registerWebFetch(pi);
	registerWebResearch(pi, route);
}
