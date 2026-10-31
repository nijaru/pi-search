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
type SecretName = (typeof SECRET_NAMES)[number];
export type DirectCredentials = Readonly<Partial<Record<SecretName, string>>>;
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

function resolveCommand(name: SecretName, command: string, agentDir: string, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
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
		const timer = setTimeout(() => fail("timed out (10s limit)"), TIMEOUT_MS);
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

/** Load only the user agent directory; never consult project config or mutate the environment. */
export async function loadDirectCredentials(agentDir: string, env: NodeJS.ProcessEnv = process.env): Promise<DirectCredentials> {
	const inherited = { ...env };
	const credentials: Partial<Record<SecretName, string>> = {};
	for (const name of SECRET_NAMES) {
		// Keep existing env semantics: whitespace-only values are unavailable, but
		// nonempty values are passed to adapters unchanged.
		if (inherited[name] !== undefined) credentials[name] = inherited[name];
	}
	let text: string;
	try {
		text = await readFile(join(agentDir, "pi-search", "credentials.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return credentials;
		throw configError("could not read configuration");
	}
	let config: unknown;
	try { config = JSON.parse(text); } catch { throw configError("invalid JSON"); }
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		throw configError("expected a flat object of credential commands");
	}
	const commands: [SecretName, string][] = [];
	for (const [name, value] of Object.entries(config)) {
		if (!SECRET_NAMES.includes(name as SecretName)) throw configError("unsupported credential name");
		if (typeof value !== "string" || !value.startsWith("!") || value.slice(1).trim().length === 0 || value.includes("\0")) {
			throw configError(`${name} must be a nonempty !<shell command> reference, not a literal secret`);
		}
		commands.push([name as SecretName, value.slice(1)]);
	}
	// Validate everything first, then wait for every bounded command to clean up,
	// including when another command fails. At most six commands run concurrently.
	const results = await Promise.allSettled(commands.map(([name, command]) => resolveCommand(name, command, agentDir, inherited)));
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") throw result.reason;
		credentials[commands[index]![0]] = result.value;
	}
	return credentials;
}
