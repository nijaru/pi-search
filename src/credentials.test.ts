import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDirectCredentials as openDirectCredentials, type DirectCredentials, type SecretName } from "./credentials";

// Exercise all command security boundaries, explicitly requesting each key.
async function loadDirectCredentials(dir: string, env: NodeJS.ProcessEnv) {
	const source = await openDirectCredentials(dir, env);
	try {
		const names: SecretName[] = ["BRAVE_API_KEY", "EXA_API_KEY", "DEEPSEEK_API_KEY", "PARALLEL_API_KEY", "X_API_BEARER_TOKEN", "CLOUDFLARE_API_TOKEN"];
		const results = await Promise.allSettled(names.map((name) => source.get(name, new AbortController().signal)));
		const credentials: Partial<Record<SecretName, string>> = {};
		for (const [index, result] of results.entries()) {
			if (result.status === "rejected") throw result.reason;
			if (result.value !== undefined) credentials[names[index]!] = result.value;
		}
		return credentials;
	} finally { await source.shutdown(); }
}

// Execute a real script, not a mocked subprocess or credential store.
function quote(value: string): string {
	return process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

describe("direct credentials", () => {
	let dir: string;
	let configPath: string;
	let scriptId: number;
	let sources: DirectCredentials[];
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-search-credentials-test-"));
		await mkdir(join(dir, "pi-search"));
		configPath = join(dir, "pi-search", "credentials.json");
		scriptId = 0;
		sources = [];
	});
	afterEach(async () => {
		await Promise.all(sources.map((source) => source.shutdown()));
		await rm(dir, { recursive: true, force: true });
	});
	const open = async (env: NodeJS.ProcessEnv = {}) => {
		const source = await openDirectCredentials(dir, env);
		sources.push(source);
		return source;
	};
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

	it("discovers command configuration without executing it, resolves only requested keys, and shares concurrent results", async () => {
		await configure({
			EXA_API_KEY: await command('require("node:fs").appendFileSync("runs", "1"); process.stdout.write(process.env.EXA_API_KEY + "-command");'),
			BRAVE_API_KEY: "!exit 7",
		});
		const env = { EXA_API_KEY: "inherited-test", DEEPSEEK_API_KEY: "   " };
		const source = await open(env);
		expect(source.has("EXA_API_KEY")).toBe(true);
		expect(source.has("BRAVE_API_KEY")).toBe(true);
		expect(source.has("DEEPSEEK_API_KEY")).toBe(false);
		expect(source.has("PARALLEL_API_KEY")).toBe(false);
		await expect(readFile(join(dir, "runs"))).rejects.toThrow();
		// Both env and command configuration are snapshots until reload.
		env.EXA_API_KEY = "changed-test";
		await configure({ EXA_API_KEY: "!exit 8" });
		const signal = new AbortController().signal;
		expect(await Promise.all([source.get("EXA_API_KEY", signal), source.get("EXA_API_KEY", signal)])).toEqual(["inherited-test-command", "inherited-test-command"]);
		expect(await source.get("EXA_API_KEY", signal)).toBe("inherited-test-command");
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("1");
		await expect(source.get("BRAVE_API_KEY", signal)).rejects.toThrow("command failed");
	});

	it("caches sanitized command failures until the next load without falling back to env", async () => {
		await configure({ EXA_API_KEY: await command('require("node:fs").appendFileSync("runs", "1"); process.exit(7);') });
		const source = await open({ EXA_API_KEY: "must-not-fallback" });
		const signal = new AbortController().signal;
		for (let i = 0; i < 2; i++) await expect(source.get("EXA_API_KEY", signal)).rejects.toThrow("command failed");
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("1");
		const reloaded = await open();
		await expect(reloaded.get("EXA_API_KEY", signal)).rejects.toThrow("command failed");
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("11");
	});

	it("cancels a waiter without poisoning a shared command and never starts for an already canceled caller", async () => {
		await configure({ EXA_API_KEY: await command(`
			const fs = require("node:fs");
			fs.appendFileSync("runs", "1");
			const timer = setInterval(() => {
				if (fs.existsSync("release")) { clearInterval(timer); process.stdout.write("test-key"); }
			}, 5);
		`) });
		const source = await open();
		const canceled = new AbortController();
		canceled.abort();
		await expect(source.get("EXA_API_KEY", canceled.signal)).rejects.toThrow("canceled");
		await expect(readFile(join(dir, "runs"))).rejects.toThrow();
		const caller = new AbortController();
		const first = source.get("EXA_API_KEY", caller.signal);
		const second = source.get("EXA_API_KEY", new AbortController().signal);
		caller.abort();
		await expect(first).rejects.toThrow("canceled");
		await writeFile(join(dir, "release"), "1");
		expect(await second).toBe("test-key");
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("1");
	});

	it("shutdown cancels and drains pending commands and descendants, is idempotent, and prevents later resolution", async () => {
		await configure({ EXA_API_KEY: await command(`
			const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			require("node:fs").writeFileSync("pids", JSON.stringify([process.pid, child.pid]));
			process.stdout.write("secret-canary");
			setInterval(() => {}, 1000);
		`) });
		const source = await open();
		const pending = source.get("EXA_API_KEY", new AbortController().signal).catch((error: Error) => error);
		let pids: number[] | undefined;
		for (let attempt = 0; attempt < 200 && pids === undefined; attempt++) {
			try { pids = JSON.parse(await readFile(join(dir, "pids"), "utf8")); }
			catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
		}
		expect(pids).toBeDefined();
		await Promise.all([source.shutdown(), source.shutdown()]);
		const error = await pending;
		expect(String(error)).toContain("command canceled");
		expect(String(error)).not.toContain("secret-canary");
		for (const pid of pids!) await stopped(pid);
		await expect(source.get("EXA_API_KEY", new AbortController().signal)).rejects.toThrow("canceled");
	});

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
		const source = await open();
		const start = Date.now();
		const results = await Promise.allSettled(["EXA_API_KEY", "BRAVE_API_KEY"].map((name) => source.get(name as SecretName, new AbortController().signal)));
		expect(results[0]!.status).toBe("rejected");
		expect(results[1]!.status).toBe("rejected");
		const messages = results.map((result) => result.status === "rejected" ? String(result.reason) : "");
		expect(messages[0]).toContain("EXA_API_KEY command timed out");
		expect(messages[1]).toContain("BRAVE_API_KEY command failed");
		expect(messages.join(" ")).not.toContain("secret-canary");
		expect(Date.now() - start).toBeLessThan(14_000);
		for (const pid of JSON.parse(await readFile(join(dir, "pids"), "utf8"))) await stopped(pid);
	}, 20_000);
});
