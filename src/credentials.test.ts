import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDirectCredentials } from "./credentials";

// Execute a real script, not a mocked subprocess or credential store.
function quote(value: string): string {
	return process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

describe("direct credentials", () => {
	let dir: string;
	let configPath: string;
	let scriptId: number;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-search-credentials-test-"));
		await mkdir(join(dir, "pi-search"));
		configPath = join(dir, "pi-search", "credentials.json");
		scriptId = 0;
	});
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
	const configure = async (config: unknown) => writeFile(configPath, JSON.stringify(config));
	const command = async (source: string): Promise<string> => {
		const path = join(dir, `command-${scriptId++}.cjs`);
		await writeFile(path, source);
		return `!${quote(process.execPath)} ${quote(path)}`;
	};
	const stopped = async (pid: number): Promise<void> => {
		for (let attempt = 0; attempt < 100; attempt++) {
			try { process.kill(pid, 0); } catch { return; }
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("Credential command process survived cleanup");
	};

	it("keeps raw env values when the optional file or individual entries are absent", async () => {
		const env = { EXA_API_KEY: "  env-key  ", BRAVE_API_KEY: "   ", CLOUDFLARE_ACCOUNT_ID: "not-a-secret" };
		const expected = { EXA_API_KEY: "  env-key  ", BRAVE_API_KEY: "   " };
		expect(await loadDirectCredentials(dir, env)).toEqual(expected);
		await configure({});
		expect(await loadDirectCredentials(dir, env)).toEqual(expected);
		await configure({ PARALLEL_API_KEY: await command('process.stdout.write("parallel-test");') });
		expect(await loadDirectCredentials(dir, env)).toEqual({ ...expected, PARALLEL_API_KEY: "parallel-test" });
	});

	it("prefers trimmed command stdout, runs once per load, and never mutates global or supplied env", async () => {
		const original = process.env.EXA_API_KEY;
		const env = { EXA_API_KEY: "inherited-test" };
		await configure({ EXA_API_KEY: await command(`
			require("node:fs").appendFileSync("runs", "1");
			process.stdout.write("  " + process.env.EXA_API_KEY + "-command\\n");
		`) });
		const credentials = await loadDirectCredentials(dir, env);
		expect(credentials.EXA_API_KEY).toBe("inherited-test-command");
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("1");
		expect(env.EXA_API_KEY).toBe("inherited-test");
		expect(process.env.EXA_API_KEY).toBe(original);
		await loadDirectCredentials(dir, env);
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("11");
	});

	it("rejects invalid config without exposing names, values, parser context, or running earlier commands", async () => {
		const run = await command('require("node:fs").writeFileSync("must-not-run", "1");');
		for (const config of [
			null, [], "secret-canary", 1,
			{ "secret-canary": "!secret-canary" },
			{ CLOUDFLARE_ACCOUNT_ID: "!secret-canary" },
			{ EXA_API_KEY: 42 }, { EXA_API_KEY: null }, { EXA_API_KEY: {} },
			{ EXA_API_KEY: "secret-canary" }, { EXA_API_KEY: "" },
			{ EXA_API_KEY: "!" }, { EXA_API_KEY: "!  \n\t" },
			{ EXA_API_KEY: "!secret-canary\0" },
			{ EXA_API_KEY: run, BRAVE_API_KEY: "secret-canary" },
		]) {
			await configure(config);
			const error = await loadDirectCredentials(dir, {}).catch((error: Error) => error);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain("pi-search credentials.json:");
			expect(String(error)).not.toContain("secret-canary");
			expect((error as Error).cause).toBeUndefined();
		}
		await expect(readFile(join(dir, "must-not-run"))).rejects.toThrow();
		await writeFile(configPath, '{"secret-canary": invalid-json');
		await expect(loadDirectCredentials(dir, {})).rejects.toThrow("credentials.json: invalid JSON");
		await rm(configPath);
		await mkdir(configPath);
		await expect(loadDirectCredentials(dir, {})).rejects.toThrow("could not read configuration");
	});

	it("fails visibly on empty output, nonzero exit, and missing commands without env fallback or secret diagnostics", async () => {
		for (const [source, reason] of [
			['process.stdout.write(" \\n\\t");', "command returned empty output"],
			['process.stdout.write("stdout-secret-canary"); process.stderr.write("stderr-secret-canary"); process.exit(7);', "command failed"],
		] as const) {
			await configure({ EXA_API_KEY: await command(source) });
			const error = await loadDirectCredentials(dir, { EXA_API_KEY: "env-secret-canary" }).catch((error: Error) => error);
			expect(String(error)).toContain(`EXA_API_KEY ${reason}`);
			expect(String(error)).not.toContain("secret-canary");
			expect((error as Error).cause).toBeUndefined();
		}
		await configure({ EXA_API_KEY: "!missing-credential-command-secret-canary" });
		await expect(loadDirectCredentials(dir, {})).rejects.toThrow("EXA_API_KEY command failed");
	});

	it("bounds stdout and terminates the producing process", async () => {
		await configure({ EXA_API_KEY: await command(`
			require("node:fs").writeFileSync("pid", String(process.pid));
			process.stdout.write("secret-canary".repeat(2000));
			setInterval(() => {}, 1000);
		`) });
		const error = await loadDirectCredentials(dir, {}).catch((error: Error) => error);
		expect(String(error)).toContain("stdout limit");
		expect(String(error)).not.toContain("secret-canary");
		await stopped(Number(await readFile(join(dir, "pid"), "utf8")));
	});

	it.skipIf(process.platform === "win32")("cleans up background descendants even after a successful command", async () => {
		await configure({ EXA_API_KEY: await command(`
			const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			require("node:fs").writeFileSync("pid", String(child.pid));
			process.stdout.write("test-key");
			process.exit(0);
		`) });
		expect((await loadDirectCredentials(dir, {})).EXA_API_KEY).toBe("test-key");
		await stopped(Number(await readFile(join(dir, "pid"), "utf8")));
	});

	it("times out, kills command descendants, and waits for cleanup when a sibling command fails", async () => {
		await configure({
			EXA_API_KEY: await command(`
				const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				require("node:fs").writeFileSync("pids", JSON.stringify([process.pid, child.pid]));
				process.stdout.write("stdout-secret-canary");
				process.stderr.write("stderr-secret-canary");
				setInterval(() => {}, 1000);
			`),
			BRAVE_API_KEY: await command("process.exit(1);"),
		});
		const start = Date.now();
		const error = await loadDirectCredentials(dir, {}).catch((error: Error) => error);
		expect(String(error)).toContain("EXA_API_KEY command timed out");
		expect(String(error)).not.toContain("secret-canary");
		expect(Date.now() - start).toBeLessThan(14_000);
		for (const pid of JSON.parse(await readFile(join(dir, "pids"), "utf8"))) await stopped(pid);
	}, 20_000);
});
