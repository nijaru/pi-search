import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { XBrowserAccess, type XBrowserName } from "./x-browser";
import { SafeFetchError } from "./fetch-errors";
import { createAnthropicProvider } from "./anthropic";
import { createBraveProvider, BraveQuotaTracker } from "./brave";
import { createBraveAnswersProvider } from "./brave-answers";
import { createCodexProvider } from "./codex";
import { createDeepSeekProvider } from "./deepseek";
import { createExaProvider } from "./exa";
import { createCloudflareProvider, type CloudflareUpstream } from "./cloudflare";
import { createGeminiProvider } from "./gemini";
import { registerWebFetch } from "./fetch-tool";
import { createOpenAIProvider } from "./openai";
import { createParallelProvider } from "./parallel";
import { createParallelResponsesProvider } from "./parallel-responses";
import { createMetaProvider } from "./meta";
import { createSearchRouter } from "./router";
import { createXProvider } from "./x";
import { createXAIProvider } from "./xai";
import { availableProviderHints } from "./provider-availability";
import { registerWebResearch } from "./research-tool";
import { registerWebSearch } from "./search-tool";

/**
 * Native grounding is selected for supported active models. Exa is the
 * metered non-native default only when explicitly allowed, DeepSeek is the
 * cheaper second metered path, and Brave is the paced last-resort keyword
 * path. Automatic availability failures may use one visible fallback.
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
	const deepseekKey = process.env.DEEPSEEK_API_KEY;
	const parallelKey = process.env.PARALLEL_API_KEY;
	const xToken = process.env.X_API_BEARER_TOKEN;
	const exa = createExaProvider({ apiKey: exaKey });
	const deepseek = createDeepSeekProvider({ apiKey: deepseekKey });
	const cloudflareUpstream = process.env.PI_SEARCH_CLOUDFLARE_PROVIDER;
	const cloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
	const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
	// Credentials alone do not enable gateway spending or select Ceramic.
	const cloudflareConfigured = ["ceramic", "exa", "linkup"].includes(cloudflareUpstream ?? "")
		&& Boolean(cloudflareAccount?.trim()) && Boolean(cloudflareToken?.trim());
	const cloudflare = cloudflareConfigured ? createCloudflareProvider({
		upstream: cloudflareUpstream as CloudflareUpstream,
		accountId: cloudflareAccount,
		apiToken: cloudflareToken,
		gatewayId: process.env.PI_SEARCH_CLOUDFLARE_GATEWAY_ID,
		byokAlias: process.env.PI_SEARCH_CLOUDFLARE_BYOK_ALIAS,
	}) : undefined;
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
		deepseek,
		cloudflare,
		cloudflareConfigured,
		parallel,
		parallelResponses,
		braveAnswers,
		x,
		brave,
		braveConfigured: braveKey !== undefined && braveKey.trim().length > 0,
		exaConfigured: exaKey !== undefined && exaKey.trim().length > 0,
		deepseekConfigured: deepseekKey !== undefined && deepseekKey.trim().length > 0,
		parallelConfigured: parallelKey !== undefined && parallelKey.trim().length > 0,
		parallelResponsesConfigured: parallelResponsesEnabled,
		braveAnswersConfigured: braveAnswersEnabled,
		xConfigured: xToken !== undefined && xToken.trim().length > 0,
		braveFreeCapacityConfigured,
		braveCapacity,
		billingPolicy,
	});
	// Expose only provider hints this installation can actually dispatch so
	// the tool schemas never advertise options whose keys or gates are absent.
	const availableHints = availableProviderHints({
		brave: braveKey !== undefined && braveKey.trim().length > 0,
		braveAnswers: braveAnswersEnabled,
		exa: exaKey !== undefined && exaKey.trim().length > 0,
		deepseek: deepseekKey !== undefined && deepseekKey.trim().length > 0,
		cloudflare: cloudflareConfigured,
		parallel: parallelKey !== undefined && parallelKey.trim().length > 0,
		parallelResponses: parallelResponsesEnabled,
		x: xToken !== undefined && xToken.trim().length > 0,
	});
	const xBrowser = new XBrowserAccess(join(getAgentDir(), "pi-search", "x"));
	registerWebSearch(pi, route, { availableProviderHints: availableHints, fetcherOptions: { xBrowser } });
	registerWebFetch(pi, { xBrowser });
	registerWebResearch(pi, route, { availableProviderHints: availableHints, xBrowser });
	pi.on("session_shutdown", async () => { await xBrowser.shutdown(); });
	pi.registerCommand("search-x", {
		description: "X access: connect [brave|chrome|chromium], disconnect, status, auto, public, or direct",
		handler: async (args, ctx) => {
			try {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const [command = "status", browser = "brave"] = parts;
				if (parts.length > (command === "connect" ? 2 : 1)) throw new SafeFetchError({ kind: "invalidRequest", message: "Unexpected X command arguments" });
				switch (command) {
					case "connect": {
						if (!ctx.hasUI) throw new SafeFetchError({ kind: "extraction", message: "Run /search-x connect in an interactive Pi session to authorize your existing browser" });
						if (!["brave", "chrome", "chromium"].includes(browser)) throw new SafeFetchError({ kind: "invalidRequest", message: "Choose brave, chrome, or chromium" });
						const authorized = await xBrowser.connect(() => ctx.ui.confirm("Use your existing X login", `Allow pi-search to use ${browser} for read-only X extraction? Enable remote debugging in its inspect page and approve its native connection prompt. Only temporary X tabs are used; no browser is launched and no cookies are copied.`), browser as XBrowserName);
						ctx.ui.notify(authorized ? "Browser connected. Automatic X reads now use its existing login; no paid API is used." : "X browser authorization canceled.", "info");
						break;
					}
					case "disconnect":
						await xBrowser.disconnect();
						ctx.ui.notify(`X browser access disabled. Your browser and X login are unchanged. ${await xBrowser.status()}`, "info");
						break;
					case "auto": case "public": case "direct":
						await xBrowser.setMode(command);
						ctx.ui.notify(await xBrowser.status(), "info");
						break;
					case "status": ctx.ui.notify(await xBrowser.status(), "info"); break;
					default: ctx.ui.notify("Usage: /search-x connect [brave|chrome|chromium] | disconnect | status | auto | public | direct", "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof SafeFetchError ? error.message : "X browser operation failed. Check remote debugging and approve the connection in your running browser.", "error");
			}
		},
	});
}
