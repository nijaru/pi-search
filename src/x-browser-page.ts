import { SafeFetchError } from "./fetch-errors";
import { validateRemoteUrl, type Lookup } from "./ssrf";
import { extractXDom, type XDomDocument } from "./x-dom.mjs";
import { parseXUrl, type XUrl } from "./x-public";
import type { XBrowserConnection } from "./x-cdp";

export interface XBrowserDocument extends XDomDocument { readonly bytesRead: number }
const HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "api.x.com", "api.twitter.com", "abs.twimg.com", "pbs.twimg.com", "video.twimg.com", "ton.twitter.com"]);
const READ_OPERATIONS = new Set([
	"TweetDetail", "TweetResultByRestId", "TweetResultsByRestIds", "TweetResultById",
	"ConversationTimeline", "UserByScreenName", "UserResultByScreenName", "Viewer",
	// The shared X application shell needs these reads before rendering conversations.
	"DataSaverMode", "CreatorStudioTabBarItemQuery", "useFetchProductSubscriptionsQuery",
	"getAltTextPromptPreference", "ExploreSidebar",
]);
const PAGE_POLICY = "frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'";

export function browserRequestAllowed(value: string, method: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.port || !HOSTS.has(url.hostname)) return false;
		if (method === "GET" || method === "HEAD") {
			if (/^\/i\/api\/graphql\//.test(url.pathname)) return READ_OPERATIONS.has(url.pathname.split("/").at(-1)!);
			return !/^\/(?:logout|i\/flow\/logout)(?:\/|$)/.test(url.pathname);
		}
		return method === "POST" && ["x.com", "api.x.com", "api.twitter.com"].includes(url.hostname) && /^\/i\/api\/graphql\//.test(url.pathname) && READ_OPERATIONS.has(url.pathname.split("/").at(-1)!);
	} catch { return false; }
}

interface TargetInfo { targetId: string; type: string; url: string; browserContextId?: string }
interface Snapshot { url: string; document: XDomDocument | null }
function canceled(): SafeFetchError { return new SafeFetchError({ kind: "canceled", message: "X browser read canceled" }); }
function delay(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (): void => { signal.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, 150);
		const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(canceled()); };
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

/** A background tab in the user's existing profile, never an existing tab or shared context. */
export async function readXBrowserPage(connection: XBrowserConnection, target: XUrl, signal: AbortSignal, maxBytes: number, lookup?: Lookup): Promise<XBrowserDocument> {
	let targetId: string | undefined;
	let sessionId: string | undefined;
	let closeTask: Promise<unknown> | undefined;
	let failure: Error | undefined;
	let bytesRead = 0;
	let lastActivity = Date.now();
	let previousHtml: string | undefined;
	let documentChangedAt = Date.now();
	const loading = new Set<string>();
	const completed = new Set<string>();
	const removeHandlers: (() => void)[] = [];
	const pendingGuards = new Set<Promise<void>>();
	const resolvedHosts = new Map<string, Promise<unknown>>();
	const close = (): Promise<unknown> => {
		if (!targetId) return Promise.resolve();
		return closeTask ??= connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
	};
	const fail = (error: Error): void => { failure ??= error; void close(); };
	const check = (): void => { if (failure) throw failure; if (signal.aborted) throw canceled(); };
	const abort = (): void => { void close(); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		check();
		// Inspect only target metadata to find an unambiguous X profile. Never attach to or read other tabs.
		const { targetInfos } = await connection.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
		const contexts = new Set(targetInfos.filter((info) => info.type === "page" && /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//.test(info.url)).map((info) => info.browserContextId));
		if (contexts.size > 1) throw new Error("Multiple X browser profiles are open; close the other X profiles before connecting");
		const browserContextId = contexts.values().next().value;
		check();
		// Keep creation awaited even after cancellation so a late-created tab is still closed in finally.
		const created = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true, ...(browserContextId ? { browserContextId } : {}) }, undefined, {
			onLateResult: ({ targetId }) => { void connection.send("Target.closeTarget", { targetId }).catch(() => undefined); },
		});
		targetId = created.targetId;
		check();
		({ sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
		const send = <T = Record<string, never>>(method: string, params: object = {}): Promise<T> => connection.send<T>(method, params, sessionId);
		const guard = async (event: any): Promise<void> => {
			const request = event.request;
			const blocked = !browserRequestAllowed(request.url, request.method) || ["Image", "Media", "Font", "WebSocket"].includes(event.resourceType);
			if (blocked || signal.aborted || failure) { await send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }); return; }
			if (event.responseStatusCode === undefined && event.networkId) loading.add(event.networkId);
			const hostname = new URL(request.url).hostname;
			let resolved = resolvedHosts.get(hostname);
			if (!resolved) { resolved = validateRemoteUrl(request.url, { signal, lookup }); resolvedHosts.set(hostname, resolved); }
			await resolved;
			if (event.responseStatusCode !== undefined) {
				const headers = event.responseHeaders as { name: string; value: string }[] ?? [];
				const header = (name: string): string | undefined => headers.find((h) => h.name.toLowerCase() === name)?.value;
				if (event.responseStatusCode >= 300 && event.responseStatusCode < 400 && header("location")) {
					const redirect = new URL(header("location")!, request.url);
					if (!browserRequestAllowed(redirect.href, "GET")) {
						const error = new SafeFetchError({ kind: "redirect", message: "X browser redirect left the allowed HTTPS hosts" });
						failure ??= error;
						await send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
						throw error;
					}
					await validateRemoteUrl(redirect, { signal, lookup });
				}
				const declared = Number(header("content-length"));
				if (Number.isFinite(declared) && declared > maxBytes - bytesRead) throw new SafeFetchError({ kind: "responseTooLarge", message: "X browser response exceeds its byte limit" });
				if (event.resourceType === "Document") {
					if (/attachment/i.test(header("content-disposition") ?? "")) throw new Error("X browser refused a download");
					await send("Fetch.continueResponse", { requestId: event.requestId, responseCode: event.responseStatusCode, responseHeaders: [...headers, { name: "Content-Security-Policy", value: PAGE_POLICY }] });
					return;
				}
				await send("Fetch.continueResponse", { requestId: event.requestId });
			} else await send("Fetch.continueRequest", { requestId: event.requestId });
		};
		removeHandlers.push(connection.on("Fetch.requestPaused", (event, id) => {
			if (id !== sessionId) return;
			const task = guard(event).catch((error: Error) => {
				// X may cancel a request between interception and our continuation.
				// A browser-confirmed completion makes that interception obsolete.
				if (!event.networkId || !completed.has(event.networkId)) fail(error);
			}).finally(() => pendingGuards.delete(task));
			pendingGuards.add(task);
		}));
		for (const event of ["Network.loadingFinished", "Network.loadingFailed"]) {
			removeHandlers.push(connection.on(event, (event, id) => {
				if (id !== sessionId) return;
				loading.delete(event.requestId);
				completed.add(event.requestId);
				lastActivity = Date.now();
			}));
		}
		removeHandlers.push(connection.on("Network.dataReceived", (event, id) => {
			if (id !== sessionId) return;
			lastActivity = Date.now();
			bytesRead += event.dataLength;
			if (bytesRead > maxBytes) fail(new SafeFetchError({ kind: "responseTooLarge", message: "X browser exceeded its observed response-byte limit" }));
		}));
		// X defers conversation rendering in hidden tabs. Emulate focus only in our
		// owned tab, without activating a window or changing the user's selected tab.
		await send("Emulation.setFocusEmulationEnabled", { enabled: true });
		await send("Network.enable");
		await send("Network.setBypassServiceWorker", { bypass: true });
		await send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
		await send("Page.enable");
		await send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperties(window, {open: {value: () => null, configurable: false, writable: false}, WebSocket: {value: undefined, configurable: false, writable: false}});" });
		await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
		check();
		const navigation = await send<{ errorText?: string }>("Page.navigate", { url: target.url });
		if (navigation.errorText) { check(); throw new Error("X browser navigation failed"); }
		const expression = `(() => ({url: location.href, document: (${extractXDom.toString()})(document, ${JSON.stringify(target)}, ${Math.min(maxBytes, 1_000_000)})}))()`;
		const evaluate = async <T>(source: string): Promise<T | undefined> => {
			const reply = await send<{ result: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: source, returnByValue: true, timeout: 1_000 });
			if (reply.exceptionDetails) throw new Error("X page could not be extracted");
			return reply.result.value;
		};
		for (;;) {
			check();
			const snapshot = await evaluate<Snapshot>(expression);
			check();
			if (snapshot?.document) {
				const actual = parseXUrl(snapshot.url);
				if (!actual || actual.postId !== target.postId || actual.articleId !== target.articleId) throw new Error("X navigated away from the requested content");
				if (snapshot.document.html !== previousHtml) {
					previousHtml = snapshot.document.html;
					documentChangedAt = Date.now();
				}
				if (snapshot.document.collapsedPostIds?.length) {
					// Only expand text controls inside selected author posts. Never click links or account actions.
					await evaluate(`(() => { const ids = ${JSON.stringify(snapshot.document.collapsedPostIds)}; for (const el of document.querySelectorAll('article[data-testid="tweet"]')) { const href = el.querySelector('time')?.closest('a')?.getAttribute('href'); if (href && ids.some(id => new RegExp('/status/' + id + '(?:[/?]|$)').test(href))) el.querySelector('[data-testid="tweet-text-show-more-link"]')?.click(); } })()`);
				} else if (!loading.size && Date.now() - Math.max(lastActivity, documentChangedAt) >= 750) {
					// The server-rendered focal post can appear before the conversation hydrates.
					// Wait for bounded network/DOM quiescence rather than returning that preview.
					if (!snapshot.document.html || new TextEncoder().encode(snapshot.document.html).byteLength > maxBytes) throw new SafeFetchError({ kind: "responseTooLarge", message: "X browser extracted content exceeds its byte limit" });
					return { ...snapshot.document, bytesRead };
				}
			}
			if (snapshot && /\/i\/flow\/login|\/login(?:[/?]|$)/.test(snapshot.url)) throw new Error("X is not signed in in this browser profile");
			await delay(signal);
		}
	} catch (error) {
		if (failure) throw failure;
		if (signal.aborted) throw canceled();
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		// Leave interception installed until the owned tab has stopped all requests.
		await close();
		for (const remove of removeHandlers) remove();
		await Promise.allSettled(pendingGuards);
	}
}
