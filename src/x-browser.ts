import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeFetchError } from "./fetch-errors";
import type { Lookup } from "./ssrf";
import type { XReadMode } from "./contracts";
import type { XUrl } from "./x-public";
import { browserEndpoint, XBrowserConnection } from "./x-cdp";
import { readXBrowserPage, type XBrowserDocument } from "./x-browser-page";
export type { XBrowserDocument } from "./x-browser-page";

export type XBrowserName = "brave" | "chrome" | "chromium";
interface Preferences { mode: Exclude<XReadMode, "browser">; browser?: XBrowserName }
export interface XBrowserSelection {
	readonly mode: XReadMode;
	read(target: XUrl, signal: AbortSignal, maxBytes: number, lookup?: Lookup): Promise<XBrowserDocument | undefined>;
}
export interface XBrowserReader {
	select(signal: AbortSignal): Promise<XBrowserSelection>;
}
export function browserDirectories(): Record<XBrowserName, string> {
	const home = homedir();
	if (process.platform === "darwin") {
		const root = join(home, "Library", "Application Support");
		return { brave: join(root, "BraveSoftware", "Brave-Browser"), chrome: join(root, "Google", "Chrome"), chromium: join(root, "Chromium") };
	}
	if (process.platform === "win32") {
		const root = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		return { brave: join(root, "BraveSoftware", "Brave-Browser", "User Data"), chrome: join(root, "Google", "Chrome", "User Data"), chromium: join(root, "Chromium", "User Data") };
	}
	const root = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
	return { brave: join(root, "BraveSoftware", "Brave-Browser"), chrome: join(root, "google-chrome"), chromium: join(root, "chromium") };
}
function canceled(): SafeFetchError { return new SafeFetchError({ kind: "canceled", message: "X browser operation canceled" }); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(canceled());
	return new Promise((resolve, reject) => {
		const abort = (): void => reject(canceled());
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Explicit authorization for an existing browser. Owns only its connection and temporary X tabs. */
export class XBrowserAccess implements XBrowserReader {
	private queue: Promise<unknown> = Promise.resolve();
	private connection?: XBrowserConnection;
	private connectedBrowser?: XBrowserName;
	private active?: AbortController;
	private stopped = false;
	private revision = 0;
	constructor(private readonly directory: string, private readonly browsers = browserDirectories()) {}

	private async preferences(): Promise<Preferences> {
		let value: unknown;
		try { value = JSON.parse(await readFile(join(this.directory, "preferences.json"), "utf8")); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "auto" };
			throw new SafeFetchError({ kind: "extraction", message: "Could not read X access preferences", cause: error });
		}
		const p = value as Partial<Preferences> | null;
		if (!p || !["auto", "public", "direct"].includes(p.mode ?? "") || p.browser !== undefined && !["brave", "chrome", "chromium"].includes(p.browser)) throw new SafeFetchError({ kind: "extraction", message: "Invalid X access preferences" });
		return { mode: p.mode!, ...(p.browser ? { browser: p.browser } : {}) };
	}
	private async save(preferences: Preferences, signal?: AbortSignal): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		const temporary = join(this.directory, `preferences-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600, flag: "wx" });
			if (signal?.aborted) throw canceled();
			await rename(temporary, join(this.directory, "preferences.json"));
		} finally { await rm(temporary, { force: true }); }
	}
	select(signal: AbortSignal): Promise<XBrowserSelection> {
		const revision = this.revision;
		return this.serialized(async () => {
			const preferences = await this.preferences();
			return {
				mode: preferences.mode,
				// Bind the read to this policy, so revocation between routing and reading
				// cannot turn an authorized request into a public fallback.
				read: (target, signal, maxBytes, lookup) => this.read(preferences, revision, target, signal, maxBytes, lookup),
			};
		}, signal, revision);
	}
	async status(): Promise<string> {
		const p = await this.preferences();
		return `X access: ${p.mode}; ${p.browser ? `${p.browser} authorized${this.connection?.connected ? " and connected" : " (browser approval may be needed)"}` : "browser not authorized"}. ${p.mode === "direct" ? "Only direct X HTTP is allowed." : "Public extraction uses free FxTwitter."} No paid retrieval or separate browser profile.`;
	}
	private serialized<T>(task: () => Promise<T>, signal: AbortSignal, revision = this.revision): Promise<T> {
		const check = (): void => { if (signal.aborted || this.stopped || revision !== this.revision) throw canceled(); };
		const pending = this.queue.catch(() => undefined).then(async () => {
			check();
			const result = await task();
			check();
			return result;
		});
		this.queue = pending;
		return abortable(pending, signal);
	}
	private async attach(browser: XBrowserName, signal: AbortSignal): Promise<XBrowserConnection> {
		if (this.connection?.connected && this.connectedBrowser === browser) return this.connection;
		this.connection?.close();
		const endpoint = await browserEndpoint(this.browsers[browser]);
		this.connection = await XBrowserConnection.open(endpoint, signal);
		this.connectedBrowser = browser;
		return this.connection;
	}
	async connect(confirm: () => Promise<boolean>, browser: XBrowserName = "brave"): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 300_000);
		try {
			return await this.serialized(async () => {
				this.active = controller;
				let authorized = false;
				try {
					if (!(await abortable(confirm(), controller.signal))) return false;
					await this.attach(browser, controller.signal);
					await this.save({ mode: "auto", browser }, controller.signal);
					authorized = true;
					return true;
				} finally {
					if (!authorized) this.detach();
					this.active = undefined;
				}
			}, controller.signal);
		} finally { clearTimeout(timeout); }
	}
	private async read(preferences: Preferences, revision: number, target: XUrl, signal: AbortSignal, maxBytes: number, lookup?: Lookup): Promise<XBrowserDocument | undefined> {
		return this.serialized(async () => {
			const controller = new AbortController();
			this.active = controller;
			const abort = (): void => controller.abort();
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			try {
				if (controller.signal.aborted) throw canceled();
				if (!preferences.browser) return undefined;
				if (preferences.mode === "direct") throw canceled();
				const connection = await this.attach(preferences.browser, controller.signal);
				const document = await readXBrowserPage(connection, target, controller.signal, maxBytes, lookup);
				if (controller.signal.aborted) throw canceled();
				return document;
			} catch (error) {
				if (controller.signal.aborted) throw canceled();
				if (error instanceof SafeFetchError) throw error;
				throw new SafeFetchError({ kind: "extraction", message: "Authenticated X read failed. Check that X is signed in in your connected browser. Use public mode only if you intend to disclose this post ID to FxTwitter", cause: error });
			} finally { signal.removeEventListener("abort", abort); this.active = undefined; }
		}, signal, revision);
	}
	private change(task: () => Promise<void>): Promise<void> {
		this.revision++;
		this.active?.abort();
		const pending = this.queue.catch(() => undefined).then(task);
		this.queue = pending;
		return pending;
	}
	private detach(): void {
		this.connection?.close();
		this.connection = undefined;
		this.connectedBrowser = undefined;
	}
	async setMode(mode: Preferences["mode"]): Promise<void> {
		await this.change(async () => {
			if (mode !== "auto") this.detach();
			await this.save({ ...await this.preferences(), mode });
		});
	}
	async disconnect(): Promise<void> {
		await this.change(async () => {
			this.detach();
			await this.save({ mode: (await this.preferences()).mode });
		});
	}
	async shutdown(): Promise<void> {
		this.stopped = true;
		await this.change(async () => this.detach());
	}
}
