import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { SafeFetchError } from "./fetch-errors";
import { validateRemoteUrl, type Lookup } from "./ssrf";
import { extractXDom, type XDomDocument } from "./x-dom.mjs";
import { parseXUrl, type XUrl } from "./x-public";

import type { XReadMode } from "./contracts";
interface Preferences { mode: Exclude<XReadMode, "browser">; browserEnabled: boolean }
export interface XBrowserDocument extends XDomDocument { readonly bytesRead: number }
export interface XBrowserReader {
	defaultMode(): Promise<XReadMode>;
	read(target: XUrl, signal: AbortSignal, maxBytes: number): Promise<XBrowserDocument | undefined>;
}

const HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "api.x.com", "api.twitter.com", "abs.twimg.com", "pbs.twimg.com", "video.twimg.com", "ton.twitter.com"]);
const READ_OPERATIONS = /\/(?:TweetDetail|TweetResultByRestId|TweetResultsByRestIds|TweetResultById|ConversationTimeline|UserByScreenName|UserResultByScreenName|Viewer)(?:Query)?$/;

export function browserRequestAllowed(value: string, method: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.port || !HOSTS.has(url.hostname)) return false;
		if (method === "GET" || method === "HEAD") {
			if (/^\/i\/api\/graphql\//.test(url.pathname)) return READ_OPERATIONS.test(url.pathname);
			return !/^\/(?:logout|i\/flow\/logout)(?:\/|$)/.test(url.pathname);
		}
		return method === "POST" && ["x.com", "api.x.com", "api.twitter.com"].includes(url.hostname) && /^\/i\/api\/graphql\//.test(url.pathname) && READ_OPERATIONS.test(url.pathname);
	} catch { return false; }
}

/** Pin the browser's entire DNS namespace; requests outside this list fail closed. */
export async function browserHostRules(signal: AbortSignal, lookup?: Lookup): Promise<string> {
	const rules: string[] = [];
	for (const host of HOSTS) {
		const resolved = await validateRemoteUrl(`https://${host}/`, { signal, lookup });
		rules.push(`MAP ${host} ${resolved.family === 6 ? `[${resolved.address}]` : resolved.address}`);
	}
	return `${rules.join(", ")}, MAP * ~NOTFOUND`;
}

function browserEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "LOCALAPPDATA", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "LANG", "LC_ALL", "TZ"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key]!;
	}
	return env;
}

export async function findXBrowser(): Promise<string> {
	const paths = process.platform === "darwin" ? [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	] : process.platform === "win32" ? [
		join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
		join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
	] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"];
	for (const path of paths) {
		try { await access(path, constants.X_OK); return path; } catch { /* next installed browser */ }
	}
	throw new SafeFetchError({ kind: "extraction", message: "X browser mode needs an installed Chrome, Chromium, or Brave browser; public mode needs no browser" });
}

function canceled(): SafeFetchError { return new SafeFetchError({ kind: "canceled", message: "X browser read canceled" }); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(canceled());
	return new Promise((resolve, reject) => {
		const abort = (): void => reject(canceled());
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Owns only pi-search's profile. Never attaches to a personal browser or imports cookies. */
export class XBrowserAccess implements XBrowserReader {
	private queue: Promise<unknown> = Promise.resolve();
	private context?: BrowserContext;
	private active?: AbortController;
	private stopped = false;
	private revision = 0;
	constructor(private readonly directory: string) {}

	private async preferences(): Promise<Preferences> {
		let value: unknown;
		try { value = JSON.parse(await readFile(join(this.directory, "preferences.json"), "utf8")); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "auto", browserEnabled: false };
			throw new SafeFetchError({ kind: "extraction", message: "Could not read X access preferences", cause: error });
		}
		const p = value as Partial<Preferences> | null;
		if (!p || !["auto", "public", "direct"].includes(p.mode ?? "") || typeof p.browserEnabled !== "boolean") {
			throw new SafeFetchError({ kind: "extraction", message: "Invalid X access preferences" });
		}
		return p as Preferences;
	}
	private async lease(): Promise<() => Promise<void>> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const name = `lease.${process.pid}.${randomUUID()}`;
		const path = join(this.directory, name);
		await writeFile(path, "", { flag: "wx", mode: 0o600 });
		try {
			for (const entry of await readdir(this.directory)) {
				if (entry === name) continue;
				const match = /^lease\.(\d+)\./.exec(entry);
				if (!match) continue;
				let alive = true;
				try { process.kill(Number(match[1]), 0); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
				if (alive) throw new SafeFetchError({ kind: "extraction", message: "The dedicated X profile is busy in another Pi session; try again when it finishes" });
			}
			return () => rm(path, { force: true });
		} catch (error) { await rm(path, { force: true }); throw error; }
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
	async defaultMode(): Promise<XReadMode> { return (await this.preferences()).mode; }
	async status(): Promise<string> {
		const p = await this.preferences();
		return `X access: ${p.mode}; browser ${p.browserEnabled ? "authorized (login may expire)" : "not authorized"}. ${p.mode === "direct" ? "Only direct X HTTP is allowed." : "Public extraction uses FxTwitter."} No paid retrieval. Profile: ${join(this.directory, "profile")}`;
	}
	async setMode(mode: Preferences["mode"]): Promise<void> {
		this.revision++;
		this.active?.abort();
		await this.context?.close().catch(() => undefined);
		await this.queue.catch(() => undefined);
		await this.save({ ...await this.preferences(), mode });
	}

	private serialized<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
		const revision = this.revision;
		const pending = this.queue.catch(() => undefined).then(async () => {
			if (signal.aborted || this.stopped || revision !== this.revision) throw canceled();
			return task();
		});
		this.queue = pending;
		return abortable(pending, signal);
	}
	private async launch(headless: boolean, signal: AbortSignal, rules?: string): Promise<BrowserContext> {
		const executablePath = await findXBrowser();
		await mkdir(join(this.directory, "profile"), { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		await chmod(join(this.directory, "profile"), 0o700);
		const { chromium } = await import("playwright-core");
		if (signal.aborted) throw canceled();
		const launched = chromium.launchPersistentContext(join(this.directory, "profile"), {
			executablePath, headless, chromiumSandbox: true, serviceWorkers: "block", acceptDownloads: false,
			timeout: 10_000, env: browserEnvironment(),
			args: ["--no-proxy-server", "--disable-quic", ...(rules ? [`--host-resolver-rules=${rules}`] : [])],
		});
		try {
			const context = await abortable(launched, signal);
			this.context = context;
			return context;
		} catch (error) {
			// Keep the profile lease until an in-flight launch has settled and its
			// browser has closed; logout must never delete a still-owned profile.
			const context = await launched.catch(() => undefined);
			await context?.close().catch(() => undefined);
			throw error;
		}
	}

	async read(target: XUrl, signal: AbortSignal, maxBytes: number): Promise<XBrowserDocument | undefined> {
		if (!(await this.preferences()).browserEnabled) return undefined;
		return this.serialized(async () => {
			if (!(await this.preferences()).browserEnabled) return undefined;
			const release = await this.lease();
			const controller = new AbortController();
			this.active = controller;
			const abort = (): void => { controller.abort(); void this.context?.close().catch(() => undefined); };
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			let context: BrowserContext | undefined;
			let bytesRead = 0;
			let tooLarge = false;
			try {
				const rules = await browserHostRules(controller.signal);
				context = await this.launch(true, controller.signal, rules);
				await context.routeWebSocket("**/*", (socket) => socket.close());
				await context.route("**/*", async (route) => {
					const request = route.request();
					if (!browserRequestAllowed(request.url(), request.method()) || ["image", "media", "font"].includes(request.resourceType())) await route.abort();
					else await route.continue();
				});
				context.on("page", (page) => { void page.close().catch(() => undefined); });
				const page = context.pages()[0];
				if (!page) throw new Error("Browser opened no page");
				const session = await context.newCDPSession(page);
				await session.send("Network.enable");
				session.on("Network.dataReceived", (event) => {
					bytesRead += event.dataLength;
					if (bytesRead > maxBytes) { tooLarge = true; abort(); }
				});
				await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
				const actual = parseXUrl(page.url());
				if (!actual || actual.postId !== target.postId || actual.articleId !== target.articleId) throw new Error("X redirected away from the requested content");
				const expression = `(${extractXDom.toString()})(document, ${JSON.stringify(actual)}, 1000000)`;
				await page.waitForFunction(`() => !!(${expression})`, undefined, { timeout: 10_000 });
				if (!(await page.evaluate("/(?:^|;\\s*)twid=/.test(document.cookie)"))) throw new Error("X browser login expired");
				// Expand only text on the selected author posts, never reply/like/follow controls.
				const initial = await page.evaluate(expression) as XDomDocument;
				for (const postId of initial.collapsedPostIds ?? []) {
					const more = page.locator('article[data-testid="tweet"]').filter({ has: page.locator(`a[href$="/status/${postId}"] time, a[href*="/status/${postId}?"] time`) })
						.first().locator('[data-testid="tweet-text-show-more-link"]');
					await more.click({ timeout: 2_000 });
					await more.waitFor({ state: "hidden", timeout: 2_000 });
				}
				const document = await page.evaluate(expression) as XDomDocument | null;
				if (!document || !document.html || document.collapsedPostIds?.length || new TextEncoder().encode(document.html).byteLength > maxBytes) throw new Error("No full, bounded X content found");
				if (page.url() !== actual.url && parseXUrl(page.url())?.url !== actual.url) throw new Error("X navigated away during extraction");
				const preferences = await this.preferences();
				if (!preferences.browserEnabled || preferences.mode === "direct" || controller.signal.aborted) throw canceled();
				return { ...document, bytesRead };
			} catch (error) {
				if (tooLarge) throw new SafeFetchError({ kind: "responseTooLarge", message: "X browser exceeded the aggregate response-byte limit" });
				if (controller.signal.aborted) throw canceled();
				throw new SafeFetchError({ kind: "extraction", message: "Authenticated X read failed or login expired. Run /search-x login; use xMode: public only if you intend to send this post ID to FxTwitter", cause: error });
			} finally {
				signal.removeEventListener("abort", abort);
				await context?.close().catch(() => undefined);
				this.context = undefined;
				this.active = undefined;
				await release();
			}
		}, signal);
	}

	async login(confirm: () => Promise<boolean>): Promise<boolean> {
		const controller = new AbortController();
		return this.serialized(async () => {
			const release = await this.lease();
			this.active = controller;
			let context: BrowserContext | undefined;
			try {
				// Manual login uses a normal headed browser. Automated reads use the pinned,
				// allowlisted network boundary above, not this interactive login context.
				context = await this.launch(false, controller.signal);
				const page = context.pages()[0];
				await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: 20_000 });
				if (!(await abortable(confirm(), controller.signal))) return false;
				const loggedIn = await page.evaluate("/(?:^|;\\s*)twid=/.test(document.cookie)");
				if (!loggedIn || new URL(page.url()).hostname !== "x.com") throw new SafeFetchError({ kind: "extraction", message: "X login was not detected; finish signing in before confirming" });
				await this.save({ mode: "auto", browserEnabled: true }, controller.signal);
				return true;
			} finally { await context?.close().catch(() => undefined); this.context = undefined; this.active = undefined; await release(); }
		}, controller.signal);
	}

	async logout(): Promise<void> {
		this.revision++;
		this.active?.abort();
		await this.save({ ...await this.preferences(), browserEnabled: false });
		await this.context?.close().catch(() => undefined);
		await this.queue.catch(() => undefined);
		const release = await this.lease();
		try {
			// A login save already in flight when canceled must not re-enable access.
			await this.save({ ...await this.preferences(), browserEnabled: false });
			await rm(join(this.directory, "profile"), { recursive: true, force: true });
		}
		finally { await release(); }
	}
	async shutdown(): Promise<void> {
		this.stopped = true;
		this.revision++;
		this.active?.abort();
		await this.context?.close().catch(() => undefined);
		await this.queue.catch(() => undefined);
	}
}
