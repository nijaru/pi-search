import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBraveProvider, BraveQuotaTracker } from "./brave";
import { createExaProvider } from "./exa";
import { createGeminiProvider } from "./gemini";
import { registerWebFetch } from "./fetch-tool";
import { createOpenAIProvider } from "./openai";
import { createParallelProvider } from "./parallel";
import { createSearchRouter } from "./router";
import { createXProvider } from "./x";
import { createXAIProvider } from "./xai";
import { adaptLocalLlamaPayload, isLocalOpenAICompatibleModel } from "./local-llama-compat";
import { registerWebResearch } from "./research-tool";
import { registerWebSearch } from "./search-tool";

/**
 * Native grounding is selected for supported active models. Exa is the
 * configured non-native default when its key is present; Brave is the paced
 * last-resort keyword path. Automatic availability failures may use one
 * visible fallback.
 */
export default function (pi: ExtensionAPI): void {
	const braveKey = process.env.BRAVE_API_KEY;
	// Brave is a conservative last-resort path: pace starts at 1 RPS and never claims
	// to know the account's billing balance. Set `=0` only with explicit metered
	// opt-in when that pacing is intentionally not wanted.
	const braveFreeOnly = process.env.PI_SEARCH_BRAVE_FREE_ONLY !== "0";
	const braveCapacity = new BraveQuotaTracker({ minimumIntervalMs: braveFreeOnly ? 1_000 : 0 });
	const brave = createBraveProvider({ apiKey: braveKey, capacityTracker: braveCapacity });
	const openai = createOpenAIProvider({ provider: "openai" });
	const codex = createOpenAIProvider({ provider: "openai-codex" });
	const gemini = createGeminiProvider();
	const xai = createXAIProvider({ tool: "web_search" });
	const xaiX = createXAIProvider({ tool: "x_search" });
	const exaKey = process.env.EXA_API_KEY;
	const parallelKey = process.env.PARALLEL_API_KEY;
	const xToken = process.env.X_API_BEARER_TOKEN;
	const exa = createExaProvider({ apiKey: exaKey });
	const parallel = createParallelProvider({ apiKey: parallelKey });
	const x = createXProvider({ bearerToken: xToken });
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
		x,
		brave,
		braveConfigured: braveKey !== undefined && braveKey.trim().length > 0,
		exaConfigured: exaKey !== undefined && exaKey.trim().length > 0,
		parallelConfigured: parallelKey !== undefined && parallelKey.trim().length > 0,
		xConfigured: xToken !== undefined && xToken.trim().length > 0,
		braveFreeCapacityConfigured,
		braveCapacity,
		billingPolicy,
	});
	pi.on("before_provider_request", (event, context) => {
		if (!isLocalOpenAICompatibleModel(context.model)) return;
		return adaptLocalLlamaPayload(event.payload);
	});
	registerWebSearch(pi, route);
	registerWebFetch(pi);
	registerWebResearch(pi, route);
}
