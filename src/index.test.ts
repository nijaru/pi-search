import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index";
import type { WebSearchTool } from "./search-tool";

const envNames = [
	"PI_CODING_AGENT_DIR", "BRAVE_API_KEY", "EXA_API_KEY", "DEEPSEEK_API_KEY", "PARALLEL_API_KEY",
	"X_API_BEARER_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PI_SEARCH_CLOUDFLARE_PROVIDER",
	"PI_SEARCH_ENABLE_BRAVE_ANSWERS", "PI_SEARCH_ENABLE_PARALLEL_RESPONSES",
	"PI_SEARCH_ALLOW_METERED", "PI_SEARCH_PREFER_FREE", "PI_SEARCH_BRAVE_FREE_ONLY",
	"PI_SEARCH_CLOUDFLARE_GATEWAY_ID", "PI_SEARCH_CLOUDFLARE_BYOK_ALIAS",
	"PI_SEARCH_PROVIDER", "PI_SEARCH_MODEL", "PI_SEARCH_FALLBACK_PROVIDER", "PI_SEARCH_ENABLE_RESEARCH",
] as const;

const shutdowns: (() => Promise<void>)[] = [];
const quote = (value: string) => process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;

async function register() {
	const names: string[] = [];
	const commands: string[] = [];
	const enums: string[][] = [];
	const tools = new Map<string, WebSearchTool>();
	let shutdown = async () => {};
	let xCommand: (args: string, ctx: never) => Promise<void>;
	await extension({
		on(name: string, handler: () => Promise<void>) { if (name === "session_shutdown") shutdown = handler; },
		registerCommand(name: string, options: { handler: typeof xCommand }) { commands.push(name); xCommand = options.handler; },
		registerTool(tool: WebSearchTool) {
			names.push(tool.name);
			tools.set(tool.name, tool);
			if (tool.name !== "web_fetch") enums.push(tool.parameters.properties.advanced.properties.provider.enum);
		},
	} as never);
	shutdowns.push(shutdown);
	const search = (provider: string, signal?: AbortSignal) => tools.get("web_search")!.execute("test-call", { query: "q", advanced: { provider } } as never, signal, undefined, { modelRegistry: { getAvailable: () => [] } } as never);
	return { names, commands, enums, tools, search, shutdown, xCommand: xCommand! };
}

describe("extension registration", () => {
	let dir: string;
	let previous: (string | undefined)[];
	let previousFetch: typeof fetch;
	beforeEach(async () => {
		previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => { throw new Error("Unexpected network request in registration test"); }) as unknown as typeof fetch;
		previous = envNames.map((key) => process.env[key]);
		for (const key of envNames) delete process.env[key];
		dir = await mkdtemp(join(tmpdir(), "pi-search-registration-test-"));
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(async () => {
		await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
		globalThis.fetch = previousFetch;
		envNames.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
		await rm(dir, { recursive: true, force: true });
	});

	it("registers search and fetch by default, and the optional batch only when enabled", async () => {
		const { names, commands } = await register();
		expect(names).toEqual(["web_search", "web_fetch"]);
		expect(commands).toEqual(["search-x"]);
		process.env.PI_SEARCH_ENABLE_RESEARCH = "1";
		expect((await register()).names).toEqual(["web_search", "web_fetch", "web_research"]);
	});

	it("exposes Cloudflare only with credentials and an explicit valid upstream", async () => {
		process.env.PI_SEARCH_ENABLE_RESEARCH = "1";
		process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
		process.env.CLOUDFLARE_API_TOKEN = "test-token";
		for (const upstream of ["", "invalid", "exa"]) {
			process.env.PI_SEARCH_CLOUDFLARE_PROVIDER = upstream;
			const { enums } = await register();
			expect(enums).toHaveLength(2);
			for (const values of enums) expect(values.includes("cloudflare")).toBe(upstream === "exa");
		}
	});

	it("exposes DeepSeek only when its env key is nonempty after trimming", async () => {
		process.env.PI_SEARCH_ENABLE_RESEARCH = "1";
		for (const value of [undefined, "   ", "test-key"] as const) {
			if (value === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = value;
			const { enums } = await register();
			expect(enums).toHaveLength(2);
			for (const values of enums) expect(values.includes("deepseek")).toBe(value === "test-key");
		}
	});

	it("exposes command-only direct providers in both schemas without bypassing enable gates or mutating env", async () => {
		process.env.PI_SEARCH_ENABLE_RESEARCH = "1";
		await mkdir(join(dir, "pi-search"));
		const script = join(dir, "credential.cjs");
		await writeFile(script, 'process.stdout.write("test-key\\n");');
		const command = `!${quote(process.execPath)} ${quote(script)}`;
		await writeFile(join(dir, "pi-search", "credentials.json"), JSON.stringify(Object.fromEntries([
			"BRAVE_API_KEY", "EXA_API_KEY", "DEEPSEEK_API_KEY", "PARALLEL_API_KEY", "X_API_BEARER_TOKEN", "CLOUDFLARE_API_TOKEN",
		].map((name) => [name, command]))));
		for (const enabled of [false, true]) {
			process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
			process.env.PI_SEARCH_CLOUDFLARE_PROVIDER = enabled ? "exa" : "";
			process.env.PI_SEARCH_ENABLE_BRAVE_ANSWERS = enabled ? "1" : "0";
			process.env.PI_SEARCH_ENABLE_PARALLEL_RESPONSES = enabled ? "1" : "0";
			const { enums } = await register();
			expect(enums).toHaveLength(2);
			for (const values of enums) {
				for (const provider of ["brave", "exa", "deepseek", "parallel", "x"]) expect(values).toContain(provider);
				for (const provider of ["cloudflare", "brave-answers", "parallel-responses"]) expect(values.includes(provider)).toBe(enabled);
			}
			for (const name of ["BRAVE_API_KEY", "EXA_API_KEY", "DEEPSEEK_API_KEY", "PARALLEL_API_KEY", "X_API_BEARER_TOKEN", "CLOUDFLARE_API_TOKEN"]) {
				expect(process.env[name]).toBeUndefined();
			}
		}
	});

	it("advertises configured commands without executing them during registration or X status", async () => {
		await mkdir(join(dir, "pi-search"));
		await writeFile(join(dir, "pi-search", "credentials.json"), JSON.stringify({ EXA_API_KEY: "!exit 7" }));
		const { enums, xCommand, shutdown } = await register();
		for (const values of enums) expect(values).toContain("exa");
		const notices: string[] = [];
		await xCommand("status", { ui: { notify: (text: string) => notices.push(text) } } as never);
		expect(notices[0]).toContain("X access: auto");
		await shutdown();
	});

	it("resolves only the selected provider, shares concurrent command results, and preserves command/env precedence", async () => {
		await mkdir(join(dir, "pi-search"));
		const script = join(dir, "credential.cjs");
		await writeFile(script, 'require("node:fs").appendFileSync("runs", "1"); process.stdout.write("  " + process.env.EXA_API_KEY + "-command\\n");');
		process.env.EXA_API_KEY = "env-test";
		await writeFile(join(dir, "pi-search", "credentials.json"), JSON.stringify({
			EXA_API_KEY: `!${quote(process.execPath)} ${quote(script)}`,
			BRAVE_API_KEY: "!exit 7",
		}));
		const keys: string[] = [];
		globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
			keys.push(new Headers(init.headers).get("x-api-key")!);
			return Response.json({ results: [{ url: "https://example.com/", title: "Example" }] });
		}) as unknown as typeof fetch;
		const { search, shutdown } = await register();
		process.env.EXA_API_KEY = "changed-after-load";
		await Promise.all([search("exa"), search("exa")]);
		await search("exa");
		expect(keys).toEqual(["env-test-command", "env-test-command", "env-test-command"]);
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("1");
		expect(process.env.EXA_API_KEY).toBe("changed-after-load");
		await expect(search("brave")).rejects.toMatchObject({ code: "WEB_SEARCH_AUTH", fallbackSafe: true });
		expect(keys).toHaveLength(3);
		await shutdown();
		await expect(search("exa")).rejects.toMatchObject({ code: "WEB_SEARCH_CANCELED" });
		expect(keys).toHaveLength(3);
	});

	it("permits a named fallback after pre-dispatch credential-command failure without weakening explicit selection", async () => {
		await mkdir(join(dir, "pi-search"));
		await writeFile(join(dir, "pi-search", "credentials.json"), JSON.stringify({ EXA_API_KEY: "!exit 7" }));
		process.env.DEEPSEEK_API_KEY = "test-fallback-key";
		process.env.PI_SEARCH_PROVIDER = "exa";
		process.env.PI_SEARCH_FALLBACK_PROVIDER = "deepseek";
		let calls = 0;
		globalThis.fetch = (async () => { calls++; return Response.json({ results: [{ url: "https://example.com/", snippet: "Evidence" }] }); }) as unknown as typeof fetch;
		const { tools, search } = await register();
		const response = await tools.get("web_search")!.execute("call", { query: "q" }, undefined, undefined, {} as never);
		expect(response.details).toMatchObject({ provider: "deepseek", attemptedProviders: ["exa", "deepseek"] });
		expect(calls).toBe(1);
		await expect(search("exa")).rejects.toMatchObject({ code: "WEB_SEARCH_AUTH", fallbackSafe: true });
		expect(calls).toBe(1);
	});

	it("keeps Cloudflare routing, token, and gateway settings captured at load time", async () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
		process.env.CLOUDFLARE_API_TOKEN = "test-token";
		process.env.PI_SEARCH_CLOUDFLARE_PROVIDER = "exa";
		process.env.PI_SEARCH_CLOUDFLARE_GATEWAY_ID = "test-gateway";
		process.env.PI_SEARCH_CLOUDFLARE_BYOK_ALIAS = "test-alias";
		const requests: { url: string; authorization: string | null; body: unknown }[] = [];
		globalThis.fetch = (async (url: unknown, init: RequestInit) => {
			requests.push({ url: String(url), authorization: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
			return Response.json({ items: [{ url: "https://example.com/", title: "Example" }] });
		}) as unknown as typeof fetch;
		const { search } = await register();
		for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "PI_SEARCH_CLOUDFLARE_PROVIDER", "PI_SEARCH_CLOUDFLARE_GATEWAY_ID", "PI_SEARCH_CLOUDFLARE_BYOK_ALIAS"]) process.env[key] = "changed";
		await search("cloudflare");
		expect(requests).toEqual([{
			url: "https://api.cloudflare.com/client/v4/accounts/test-account/ai/websearch/",
			authorization: "Bearer test-token",
			body: { query: "q", provider: "exa", limit: 10, options: { gateway: { id: "test-gateway" } }, byokAlias: "test-alias" },
		}]);
	});

	it("retains Brave quota observations across calls and resets them only on a new extension instance", async () => {
		process.env.BRAVE_API_KEY = "test-key";
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			return Response.json({ web: { results: [{ url: "https://example.com/", title: "Example" }] } }, {
				headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
			});
		}) as unknown as typeof fetch;
		const first = await register();
		await first.search("brave");
		await expect(first.search("brave")).rejects.toMatchObject({ code: "WEB_SEARCH_RATE_LIMIT" });
		expect(requests).toBe(1);
		await first.shutdown();
		const reloaded = await register();
		await reloaded.search("brave");
		expect(requests).toBe(2);
	});

	it("executes registry-backed Codex search independently of the active model and preserves resolved routing/auth", async () => {
		const models = [
			{ id: "search-model", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://catalog.invalid/backend-api/codex" },
			{ id: "pinned-model", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://catalog.invalid/backend-api/codex" },
		];
		const requests: { url: string; model: string; authorization: string | null }[] = [];
		globalThis.fetch = (async (url: unknown, init: RequestInit) => {
			requests.push({ url: String(url), model: JSON.parse(String(init.body)).model, authorization: new Headers(init.headers).get("authorization") });
			return Response.json({ output: "A provider-generated answer: https://example.com/", results: [{ url: "https://example.com/", snippet: "Provider text" }] });
		}) as unknown as typeof fetch;
		const modelRegistry = {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "synthesized-must-not-win", baseUrl: "https://resolved.example/backend-api/codex", headers: { authorization: "Bearer explicit-test-token" } }),
		};
		const { tools } = await register();
		for (const active of [undefined, { ...models[1] }, { id: "local", provider: "local", api: "openai-completions", baseUrl: "https://local.invalid" }]) {
			const result = await tools.get("web_search")!.execute("call", { query: "q" }, undefined, undefined, { model: active, modelRegistry } as never);
			expect(result.details).toMatchObject({ provider: "openai-codex", executionModel: "search-model", attemptedProviders: ["openai-codex"], results: [{ excerpt: "Provider text", excerptKind: "provider-text" }] });
			expect(result.details?.answer).toBeUndefined();
		}
		expect(requests).toEqual(Array.from({ length: 3 }, () => ({ url: "https://resolved.example/backend-api/codex/alpha/search", model: "search-model", authorization: "Bearer explicit-test-token" })));
		process.env.PI_SEARCH_PROVIDER = "openai-codex";
		process.env.PI_SEARCH_MODEL = "pinned-model";
		const pinned = await register();
		await pinned.tools.get("web_search")!.execute("call", { query: "q" }, undefined, undefined, { modelRegistry } as never);
		expect(requests.at(-1)?.model).toBe("pinned-model");
	});

	it("does not use configured direct credentials as an implicit fallback; a named fallback is bounded and visible", async () => {
		process.env.EXA_API_KEY = "test-exa";
		const calls: string[] = [];
		globalThis.fetch = (async (url: unknown) => {
			calls.push(String(url));
			return String(url).includes("alpha/search")
				? new Response("rejected", { status: 401 })
				: Response.json({ results: [{ url: "https://example.com/", highlights: ["Search evidence"] }] });
		}) as unknown as typeof fetch;
		const selected = { id: "search-model", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.example/backend-api/codex" };
		const ctx = { modelRegistry: { getAvailable: () => [selected], find: () => selected, getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-token" }) } } as never;
		const initial = await register();
		await expect(initial.tools.get("web_search")!.execute("call", { query: "q" }, undefined, undefined, ctx)).rejects.toMatchObject({ code: "WEB_SEARCH_AUTH" });
		expect(calls).toHaveLength(1);
		process.env.PI_SEARCH_FALLBACK_PROVIDER = "exa";
		const configured = await register();
		const result = await configured.tools.get("web_search")!.execute("call", { query: "q" }, undefined, undefined, ctx);
		expect(calls).toHaveLength(3);
		expect(result.details).toMatchObject({ provider: "exa", attemptedProviders: ["openai-codex", "exa"], results: [{ excerptKind: "provider-excerpt" }] });
		expect(result.details?.warnings).toContainEqual(expect.objectContaining({ code: "provider-fallback" }));
	});

	it("rejects invalid or unavailable installation preferences before registering tools", async () => {
		for (const [name, value] of [["PI_SEARCH_PROVIDER", "unknown"], ["PI_SEARCH_PROVIDER", "exa"], ["PI_SEARCH_FALLBACK_PROVIDER", "exa"], ["PI_SEARCH_MODEL", "unqualified"], ["PI_SEARCH_ENABLE_RESEARCH", "true"]]) {
			process.env[name] = value;
			let registered = false;
			await expect(extension({ registerTool() { registered = true; } } as never)).rejects.toThrow();
			expect(registered).toBe(false);
			delete process.env[name];
		}
	});

	it("fails extension loading before registering tools on invalid user credentials", async () => {
		await mkdir(join(dir, "pi-search"));
		await writeFile(join(dir, "pi-search", "credentials.json"), '{"EXA_API_KEY":"literal-secret-canary"}');
		let registered = false;
		await expect(extension({ registerTool() { registered = true; } } as never)).rejects.toThrow("nonempty !<shell command>");
		expect(registered).toBe(false);
	});
});
