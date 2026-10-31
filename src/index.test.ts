import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index";

const envNames = [
	"PI_CODING_AGENT_DIR", "BRAVE_API_KEY", "EXA_API_KEY", "DEEPSEEK_API_KEY", "PARALLEL_API_KEY",
	"X_API_BEARER_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PI_SEARCH_CLOUDFLARE_PROVIDER",
	"PI_SEARCH_ENABLE_BRAVE_ANSWERS", "PI_SEARCH_ENABLE_PARALLEL_RESPONSES",
] as const;

async function register() {
	const names: string[] = [];
	const commands: string[] = [];
	const enums: string[][] = [];
	await extension({
		on() {},
		registerCommand(name: string) { commands.push(name); },
		registerTool(tool: { name: string; parameters: { properties: { provider?: { enum: string[] } } } }) {
			names.push(tool.name);
			if (tool.name !== "web_fetch") enums.push(tool.parameters.properties.provider!.enum);
		},
	} as never);
	return { names, commands, enums };
}

describe("extension registration", () => {
	let dir: string;
	let previous: (string | undefined)[];
	beforeEach(async () => {
		previous = envNames.map((key) => process.env[key]);
		for (const key of envNames) delete process.env[key];
		dir = await mkdtemp(join(tmpdir(), "pi-search-registration-test-"));
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(async () => {
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
		const quote = (value: string) => process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
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

	it("fails extension loading before registering tools on invalid user credentials", async () => {
		await mkdir(join(dir, "pi-search"));
		await writeFile(join(dir, "pi-search", "credentials.json"), '{"EXA_API_KEY":"literal-secret-canary"}');
		let registered = false;
		await expect(extension({ registerTool() { registered = true; } } as never)).rejects.toThrow("nonempty !<shell command>");
		expect(registered).toBe(false);
	});
});
