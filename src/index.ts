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
import { loadDirectCredentials, type SecretName } from "./credentials";
import type { Provider } from "./contracts";
import { createProviderError } from "./errors";

/**
 * Native grounding is selected for supported active models. Exa is the
 * metered non-native default only when explicitly allowed, DeepSeek is the
 * cheaper second metered path, and Brave is the paced last-resort keyword
 * path. Automatic availability failures may use one visible fallback.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const credentials = await loadDirectCredentials(agentDir);
	let stopped = false;
	// Routing needs adapter metadata at registration, but only a selected direct
	// provider needs its key. Related adapters share the credential source; each
	// initialized adapter and its quota state live for this extension instance.
	function directProvider(name: SecretName, create: (key: string | undefined) => Provider): Provider {
		const metadata = create(undefined);
		let ready: Provider | undefined;
		return {
			id: metadata.id, capabilities: metadata.capabilities, profile: metadata.profile,
			async search(request, signal, context) {
				if (signal.aborted || stopped) throw createProviderError({ provider: metadata.id, kind: "canceled", message: "Search canceled", retryable: false });
				if (ready === undefined) {
					let key: string | undefined;
					try { key = await credentials.get(name, signal); }
					catch (error) {
						throw createProviderError({ provider: metadata.id, kind: signal.aborted || stopped ? "canceled" : "auth", message: error instanceof Error ? error.message : "Credential resolution failed", retryable: false });
					}
					// Another call may have finished the shared resolution first.
					if (signal.aborted || stopped) throw createProviderError({ provider: metadata.id, kind: "canceled", message: "Search canceled", retryable: false });
					ready ??= create(key);
				}
				return ready.search(request, signal, context);
			},
		};
	}
	// Brave is a conservative last-resort path: pace starts at 1 RPS and never claims
	// to know the account's billing balance. Set `=0` only with explicit metered
	// opt-in when that pacing is intentionally not wanted.
	const braveFreeOnly = process.env.PI_SEARCH_BRAVE_FREE_ONLY !== "0";
	const braveCapacity = new BraveQuotaTracker({ minimumIntervalMs: braveFreeOnly ? 1_000 : 0 });
	const brave = directProvider("BRAVE_API_KEY", (apiKey) => createBraveProvider({ apiKey, capacityTracker: braveCapacity }));
	const openai = createOpenAIProvider({ provider: "openai" });
	const codex = createCodexProvider();
	const gemini = createGeminiProvider();
	const xai = createXAIProvider({ tool: "web_search" });
	const xaiX = createXAIProvider({ tool: "x_search" });
	const anthropic = createAnthropicProvider();
	const meta = createMetaProvider();
	const exa = directProvider("EXA_API_KEY", (apiKey) => createExaProvider({ apiKey }));
	const deepseek = directProvider("DEEPSEEK_API_KEY", (apiKey) => createDeepSeekProvider({ apiKey }));
	const cloudflareUpstream = process.env.PI_SEARCH_CLOUDFLARE_PROVIDER;
	const cloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
	const cloudflareTokenConfigured = credentials.has("CLOUDFLARE_API_TOKEN");
	// Credentials alone do not enable gateway spending or select Ceramic.
	const cloudflareConfigured = ["ceramic", "exa", "linkup"].includes(cloudflareUpstream ?? "")
		&& Boolean(cloudflareAccount?.trim()) && cloudflareTokenConfigured;
	const cloudflareGatewayId = process.env.PI_SEARCH_CLOUDFLARE_GATEWAY_ID;
	const cloudflareByokAlias = process.env.PI_SEARCH_CLOUDFLARE_BYOK_ALIAS;
	const cloudflare = cloudflareConfigured ? directProvider("CLOUDFLARE_API_TOKEN", (apiToken) => createCloudflareProvider({
		upstream: cloudflareUpstream as CloudflareUpstream,
		accountId: cloudflareAccount,
		apiToken,
		gatewayId: cloudflareGatewayId,
		byokAlias: cloudflareByokAlias,
	})) : undefined;
	const parallel = directProvider("PARALLEL_API_KEY", (apiKey) => createParallelProvider({ apiKey }));
	const x = directProvider("X_API_BEARER_TOKEN", (bearerToken) => createXProvider({ bearerToken }));
	// Opt-in answer-synthesis providers: the enable gate alone controls
	// registration so each failure names its actual missing piece. A gate
	// without a key dispatches to the adapter, which reports the missing key;
	// a key without the gate never registers the provider at all.
	const parallelResponsesEnabled = process.env.PI_SEARCH_ENABLE_PARALLEL_RESPONSES === "1";
	const braveAnswersEnabled = process.env.PI_SEARCH_ENABLE_BRAVE_ANSWERS === "1";
	const parallelResponses = directProvider("PARALLEL_API_KEY", (apiKey) => createParallelResponsesProvider({ apiKey }));
	const braveAnswers = directProvider("BRAVE_API_KEY", (apiKey) => createBraveAnswersProvider({ apiKey }));
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
		braveConfigured: credentials.has("BRAVE_API_KEY"),
		exaConfigured: credentials.has("EXA_API_KEY"),
		deepseekConfigured: credentials.has("DEEPSEEK_API_KEY"),
		parallelConfigured: credentials.has("PARALLEL_API_KEY"),
		parallelResponsesConfigured: parallelResponsesEnabled,
		braveAnswersConfigured: braveAnswersEnabled,
		xConfigured: credentials.has("X_API_BEARER_TOKEN"),
		braveFreeCapacityConfigured,
		braveCapacity,
		billingPolicy,
	});
	// Expose only provider hints this installation can actually dispatch so
	// the tool schemas never advertise options whose keys or gates are absent.
	const availableHints = availableProviderHints({
		brave: credentials.has("BRAVE_API_KEY"),
		braveAnswers: braveAnswersEnabled,
		exa: credentials.has("EXA_API_KEY"),
		deepseek: credentials.has("DEEPSEEK_API_KEY"),
		cloudflare: cloudflareConfigured,
		parallel: credentials.has("PARALLEL_API_KEY"),
		parallelResponses: parallelResponsesEnabled,
		x: credentials.has("X_API_BEARER_TOKEN"),
	});
	const xBrowser = new XBrowserAccess(join(agentDir, "pi-search", "x"));
	registerWebSearch(pi, route, { availableProviderHints: availableHints, fetcherOptions: { xBrowser } });
	registerWebFetch(pi, { xBrowser });
	registerWebResearch(pi, route, { availableProviderHints: availableHints, xBrowser });
	pi.on("session_shutdown", async () => {
		stopped = true;
		await Promise.all([credentials.shutdown(), xBrowser.shutdown()]);
	});
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
