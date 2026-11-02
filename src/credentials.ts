import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SECRET_NAMES = [
	"BRAVE_API_KEY",
	"EXA_API_KEY",
	"DEEPSEEK_API_KEY",
	"PARALLEL_API_KEY",
	"X_API_BEARER_TOKEN",
	"CLOUDFLARE_API_TOKEN",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export interface DirectCredentials {
	/** A validated command reference or a nonempty inherited key, not a live auth probe. */
	has(name: SecretName): boolean;
	get(name: SecretName, signal: AbortSignal): Promise<string | undefined>;
	shutdown(): Promise<void>;
}
const TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 16_384;

function configError(message: string): Error {
	// Never attach original errors: JSON parsers and subprocess errors can include secrets.
	return new Error(`pi-search credentials.json: ${message}`);
}

async function killProcessTree(child: ChildProcess): Promise<void> {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
				timeout: 1_000, windowsHide: true, maxBuffer: 1_024,
			}, () => resolve());
		});
	} else {
		// The shell and its ordinary descendants share a dedicated process group.
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
	}
	try { child.kill("SIGKILL"); } catch { /* process already gone */ }
}

function resolveCommand(name: SecretName, command: string, agentDir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(configError(`${name} command canceled`));
		let child: ChildProcess;
		try {
			child = spawn(command, {
				shell: true,
				cwd: agentDir,
				env,
				stdio: ["ignore", "pipe", "ignore"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch {
			reject(configError(`${name} command could not start`));
			return;
		}
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failure: Error | undefined;
		let cleanup: Promise<void> | undefined;
		let settled = false;
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = (): Promise<void> => cleanup ??= killProcessTree(child);
		const finish = async (code: number | null): Promise<void> => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
			await stop();
			child.stdout?.destroy();
			if (failure !== undefined) return reject(failure);
			if (code !== 0) return reject(configError(`${name} command failed`));
			const value = Buffer.concat(chunks, bytes).toString("utf8").trim();
			if (value.length === 0) return reject(configError(`${name} command returned empty output`));
			resolve(value);
		};
		const fail = (reason: string): void => {
			if (settled || failure !== undefined) return;
			failure = configError(`${name} command ${reason}`);
			void stop();
			child.stdout?.destroy();
			// A detached descendant can retain a pipe after the shell has exited.
			cleanupTimer = setTimeout(() => { void finish(null); }, 1_500);
		};
		const onAbort = (): void => fail("canceled");
		const timer = setTimeout(() => fail("timed out (10s limit)"), TIMEOUT_MS);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		child.stdout?.on("data", (chunk: Buffer) => {
			if (failure !== undefined || settled) return;
			bytes += chunk.length;
			if (bytes > MAX_STDOUT_BYTES) return fail("exceeded the stdout limit (16 KiB)");
			chunks.push(chunk);
		});
		child.stdout?.once("error", () => fail("output could not be read"));
		child.once("error", () => fail("could not start"));
		// Clean up background children even when the shell exits successfully.
		child.once("exit", () => { void stop(); });
		child.once("close", (code) => { void finish(code); });
	});
}

function waitForCredential(pending: Promise<string>, signal: AbortSignal): Promise<string> {
	if (signal.aborted) return Promise.reject(configError("credential resolution canceled"));
	return new Promise((resolve, reject) => {
		const abort = (): void => reject(configError("credential resolution canceled"));
		signal.addEventListener("abort", abort, { once: true });
		pending.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error) => { signal.removeEventListener("abort", abort); reject(error); },
		);
	});
}

/** Validate only user config at load; defer command execution until a provider needs its key. */
export async function loadDirectCredentials(agentDir: string, env: NodeJS.ProcessEnv = process.env): Promise<DirectCredentials> {
	const inherited = { ...env };
	const inheritedKeys: Partial<Record<SecretName, string>> = {};
	for (const name of SECRET_NAMES) {
		// Keep existing env semantics: whitespace-only values are unavailable, but
		// nonempty values are passed to adapters unchanged.
		if (inherited[name] !== undefined) inheritedKeys[name] = inherited[name];
	}
	let text = "{}";
	try {
		text = await readFile(join(agentDir, "pi-search", "credentials.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw configError("could not read configuration");
	}
	let config: unknown;
	try { config = JSON.parse(text); } catch { throw configError("invalid JSON"); }
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		throw configError("expected a flat object of credential commands");
	}
	const commands = new Map<SecretName, string>();
	for (const [name, value] of Object.entries(config)) {
		if (!SECRET_NAMES.includes(name as SecretName)) throw configError("unsupported credential name");
		if (typeof value !== "string" || !value.startsWith("!") || value.slice(1).trim().length === 0 || value.includes("\0")) {
			throw configError(`${name} must be a nonempty !<shell command> reference, not a literal secret`);
		}
		commands.set(name as SecretName, value.slice(1));
	}
	const lifetime = new AbortController();
	const pending = new Map<SecretName, Promise<string>>();
	return {
		has: (name) => commands.has(name) || Boolean(inheritedKeys[name]?.trim()),
		async get(name, signal) {
			if (lifetime.signal.aborted || signal.aborted) throw configError("credential resolution canceled");
			const command = commands.get(name);
			if (command === undefined) return inheritedKeys[name];
			let result = pending.get(name);
			if (result === undefined) {
				result = resolveCommand(name, command, agentDir, inherited, lifetime.signal);
				pending.set(name, result);
			}
			// A canceled caller stops waiting, not a shared command needed by another
			// call. The bounded command remains owned by this instance until shutdown.
			const value = await waitForCredential(result, signal);
			if (lifetime.signal.aborted || signal.aborted) throw configError("credential resolution canceled");
			return value;
		},
		async shutdown() {
			lifetime.abort();
			await Promise.allSettled(pending.values());
		},
	};
}
