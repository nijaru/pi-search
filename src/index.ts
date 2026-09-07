import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAnthropicProvider } from "./anthropic";
import { createBraveProvider, BraveQuotaTracker } from "./brave";
import { createBraveAnswersProvider } from "./brave-answers";
import { createCodexProvider } from "./codex";
import { createExaProvider } from "./exa";
import { createGeminiProvider } from "./gemini";
import { registerWebFetch } from "./fetch-tool";
import { createOpenAIProvider } from "./openai";
import { createParallelProvider } from "./parallel";
import { createParallelResponsesProvider } from "./parallel-responses";
import { createMetaProvider } from "./meta";
import { createSearchRouter } from "./router";
import { createXProvider } from "./x";
import { createXAIProvider } from "./xai";
import { adaptLocalLlamaPayload, isLocalOpenAICompatibleModel } from "./local-llama-compat";
import { registerWebResearch } from "./research-tool";
import { registerWebSearch } from "./search-tool";

/**
 * Native grounding is selected for supported active models. Exa is the
 * metered non-native default only when explicitly allowed; Brave is the paced
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
	const codex = createCodexProvider();
	const gemini = createGeminiProvider();
	const xai = createXAIProvider({ tool: "web_search" });
	const xaiX = createXAIProvider({ tool: "x_search" });
	const anthropic = createAnthropicProvider();
	const meta = createMetaProvider();
	const exaKey = process.env.EXA_API_KEY;
	const parallelKey = process.env.PARALLEL_API_KEY;
	const xToken = process.env.X_API_BEARER_TOKEN;
	const exa = createExaProvider({ apiKey: exaKey });
	const parallel = createParallelProvider({ apiKey: parallelKey });
	const x = createXProvider({ bearerToken: xToken });
	// Opt-in answer-synthesis providers: the enable gate alone controls
	// registration so each failure names its actual missing piece. A gate
	// without a key dispatches to the adapter, which reports the missing key;
	// a key without the gate never registers the provider at all.
	const parallelResponsesEnabled = process.env.PI_SEARCH_ENABLE_PARALLEL_RESPONSES === "1";
	const braveAnswersEnabled = process.env.PI_SEARCH_ENABLE_BRAVE_ANSWERS === "1";
	const parallelResponses = createParallelResponsesProvider({ apiKey: parallelKey });
	const braveAnswers = createBraveAnswersProvider({ apiKey: braveKey });
	const billingPolicy = process.env.PI_SEARCH_ALLOW_METERED === "1"
		? "allow-configured-metered"
		: process.env.PI_SEARCH_PREFER_FREE === "1" ? "prefer-free" : "free-only";
	const braveFreeCapacityConfigured = braveFreeOnly;
	const route = createSearchRouter({
		openai,
		openaiCodex: codex,
		gemini,
		xai,
		xaiX,
		anthropic,
		meta,
		exa,
		parallel,
		parallelResponses,
		braveAnswers,
		x,
		brave,
		braveConfigured: braveKey !== undefined && braveKey.trim().length > 0,
		exaConfigured: exaKey !== undefined && exaKey.trim().length > 0,
		parallelConfigured: parallelKey !== undefined && parallelKey.trim().length > 0,
		parallelResponsesConfigured: parallelResponsesEnabled,
		braveAnswersConfigured: braveAnswersEnabled,
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
