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
			if (tool.name !== "web_fetch") enums.push(tool.parameters.properties.provider!.enum);
		},
	} as never);
	shutdowns.push(shutdown);
	const search = (provider: string, signal?: AbortSignal) => tools.get("web_search")!.execute("test-call", { query: "q", provider } as never, signal, undefined, { modelRegistry: { getAvailable: () => [] } } as never);
	return { names, commands, enums, search, shutdown, xCommand: xCommand! };
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

	it("registers exactly the three public tools", async () => {
		const { names, commands } = await register();
		expect(names).toEqual(["web_search", "web_fetch", "web_research"]);
		expect(commands).toEqual(["search-x"]);
	});

	it("exposes Cloudflare only with credentials and an explicit valid upstream", async () => {
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
		for (const value of [undefined, "   ", "test-key"] as const) {
			if (value === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = value;
			const { enums } = await register();
			expect(enums).toHaveLength(2);
			for (const values of enums) expect(values.includes("deepseek")).toBe(value === "test-key");
		}
	});

	it("exposes command-only direct providers in both schemas without bypassing enable gates or mutating env", async () => {
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
		await expect(search("brave")).rejects.toMatchObject({ code: "WEB_SEARCH_AUTH", fallbackSafe: false });
		expect(keys).toHaveLength(3);
		await shutdown();
		await expect(search("exa")).rejects.toMatchObject({ code: "WEB_SEARCH_CANCELED" });
		expect(keys).toHaveLength(3);
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

	it("fails extension loading before registering tools on invalid user credentials", async () => {
		await mkdir(join(dir, "pi-search"));
		await writeFile(join(dir, "pi-search", "credentials.json"), '{"EXA_API_KEY":"literal-secret-canary"}');
		let registered = false;
		await expect(extension({ registerTool() { registered = true; } } as never)).rejects.toThrow("nonempty !<shell command>");
		expect(registered).toBe(false);
	});
});
