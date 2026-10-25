import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserRequestAllowed } from "./x-browser-page";
import { browserEndpoint, XBrowserConnection } from "./x-cdp";
import { XBrowserAccess } from "./x-browser";
import { parseXUrl } from "./x-public";
import { fetchContent } from "./fetcher";

const url = "https://x.com/alice/status/123";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

/** Real local WebSocket boundary; keeps a user tab alive while emulating owned-tab CDP. */
async function browserFixture(scenario: "read" | "assets" | "hydrate" | "canceled-request" | "broken-interception" | "redirect" | "large" | "late-create" = "read") {
	const root = await mkdtemp(join(tmpdir(), "pi-search-x-attach-"));
	const created = deferred(), release = deferred(), preview = deferred();
	let hydrated = false, firstSnapshot = true;
	const tabs = new Set(["user-tab"]);
	let currentUrl = "about:blank";
	let navigation: any;
	let unrelatedTouched = false;
	let unsafeRedirectFollowed = false;
	const sockets = new Set<any>();
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch(request, server) { if (new URL(request.url).pathname === "/devtools/browser/test-browser" && server.upgrade(request)) return; return new Response("Not found", { status: 404 }); },
		websocket: {
			open(socket) { sockets.add(socket); },
			close(socket) { sockets.delete(socket); },
			async message(socket, data) {
				const message = JSON.parse(String(data));
				const reply = (result: object = {}) => socket.send(JSON.stringify({ id: message.id, result }));
				const event = (method: string, params: object) => socket.send(JSON.stringify({ method, params, sessionId: "owned-session" }));
				if (message.sessionId && message.sessionId !== "owned-session" || message.method === "Browser.close" || /[Cc]ookie/.test(message.method)) unrelatedTouched = true;
				switch (message.method) {
					case "Target.getTargets": reply({ targetInfos: [{ targetId: "user-tab", type: "page", url: "https://x.com/home", browserContextId: "existing-profile" }] }); break;
					case "Target.createTarget":
						tabs.add("owned-tab"); created.resolve();
						if (scenario === "late-create") await release.promise;
						reply({ targetId: "owned-tab" }); break;
					case "Target.attachToTarget":
						if (message.params.targetId !== "owned-tab") unrelatedTouched = true;
						reply({ sessionId: "owned-session" }); break;
					case "Target.closeTarget":
						if (message.params.targetId !== "owned-tab") unrelatedTouched = true;
						tabs.delete(message.params.targetId); reply({ success: true }); break;
					case "Page.navigate":
						currentUrl = message.params.url;
						if (scenario === "redirect") {
							navigation = message;
							event("Fetch.requestPaused", { requestId: "redirect", request: { url, method: "GET" }, resourceType: "Document", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: "http://127.0.0.1/private" }] });
						} else {
							if (scenario === "canceled-request" || scenario === "broken-interception") event("Fetch.requestPaused", { requestId: "intercepted", networkId: "network-request", request: { url, method: "GET" }, resourceType: "XHR" });
							if (scenario === "large" || scenario === "assets") event("Network.dataReceived", { dataLength: scenario === "assets" ? 6 * 1024 * 1024 : 2048 });
							reply();
						}
						break;
					case "Fetch.continueRequest":
						if (scenario === "canceled-request" || scenario === "broken-interception") {
							if (scenario === "canceled-request") event("Network.loadingFailed", { requestId: "network-request", canceled: true });
							socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Invalid InterceptionId." } }));
						} else reply();
						break;
					case "Fetch.continueResponse":
						if (scenario === "redirect") { unsafeRedirectFollowed = true; socket.send(JSON.stringify({ id: navigation.id, result: {} })); }
						reply(); break;
					case "Fetch.failRequest":
						reply();
						if (navigation) socket.send(JSON.stringify({ id: navigation.id, result: { errorText: "Blocked" } }));
						break;
					case "Runtime.evaluate": {
						if (scenario === "hydrate" && firstSnapshot) {
							firstSnapshot = false;
							event("Fetch.requestPaused", { requestId: "conversation", networkId: "conversation", request: { url: "https://x.com/i/api/graphql/hash/TweetDetail", method: "GET" }, resourceType: "XHR" });
							preview.resolve();
							void release.promise.then(() => { hydrated = true; event("Network.loadingFinished", { requestId: "conversation" }); });
						}
						const html = scenario === "hydrate" ? hydrated ? "<p>Focal preview</p><p>Author's next post</p>" : "<p>Focal preview</p>" : "<p>Signed-in evidence</p>";
						// Article pages have no account-navigation UI; readable content is authoritative.
						reply({ result: { value: { url: currentUrl, document: { html, title: "X post", postCount: hydrated ? 2 : 1 } } } });
						break;
					}
					default: reply();
				}
			},
		},
	});
	await writeFile(join(root, "DevToolsActivePort"), `${server.port}\n/devtools/browser/test-browser\n`);
	const directory = join(root, "access");
	const access = new XBrowserAccess(directory, { brave: root, chrome: root, chromium: root });
	return {
		access, root, directory, tabs, created, release, preview, sockets, server,
		get unrelatedTouched() { return unrelatedTouched; },
		get unsafeRedirectFollowed() { return unsafeRedirectFollowed; },
		async close() { release.resolve(); await access.shutdown(); await server.stop(true); await rm(root, { recursive: true, force: true }); },
	};
}

it("allows only HTTPS X hosts and read operations, never account writes or logout", () => {
	for (const value of [url, "https://abs.twimg.com/client-web/main.js"]) expect(browserRequestAllowed(value, "GET")).toBe(true);
	for (const value of ["http://x.com/alice/status/123", "https://x.com:444/", "https://x.com.evil.test/", "https://localhost/", "https://127.0.0.1/", "https://x.com@evil.test/", "https://x.com/logout", "https://example.com/"]) expect(browserRequestAllowed(value, "GET")).toBe(false);
	for (const operation of ["TweetDetail", "Viewer", "DataSaverMode", "CreatorStudioTabBarItemQuery", "useFetchProductSubscriptionsQuery", "getAltTextPromptPreference", "ExploreSidebar"]) for (const method of ["GET", "POST"]) expect(browserRequestAllowed(`https://x.com/i/api/graphql/hash/${operation}`, method)).toBe(true);
	for (const operation of ["CreateTweet", "DeleteTweet", "grokAccountJwtQuery"]) for (const method of ["GET", "POST"]) expect(browserRequestAllowed(`https://x.com/i/api/graphql/hash/${operation}`, method)).toBe(false);
	expect(browserRequestAllowed("https://x.com/i/api/friendships/create", "POST")).toBe(false);
});

it("rejects malformed discovery rather than connecting to a supplied remote address", async () => {
	const fixture = await browserFixture();
	try {
		for (const value of ["9222\nws://evil.test/devtools/browser/id", "65536\n/devtools/browser/id", "9222\n/devtools/browser/id\nextra"]) {
			await writeFile(join(fixture.root, "DevToolsActivePort"), value);
			await expect(browserEndpoint(fixture.root)).rejects.toMatchObject({ kind: "extraction" });
		}
		expect(fixture.sockets.size).toBe(0);
	} finally { await fixture.close(); }
});

describe("existing-browser consent and ownership", () => {
	it("does not connect without consent; uses the existing login and preserves user tabs on disconnect", async () => {
		const fixture = await browserFixture();
		try {
			expect(await fixture.access.read(parseXUrl(url)!, new AbortController().signal, 4096)).toBeUndefined();
			expect(await fixture.access.connect(async () => false)).toBe(false);
			expect(fixture.sockets.size).toBe(0);
			await expect(stat(fixture.directory)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fixture.access.connect(async () => true)).toBe(true);
			for (const selected of [url, "https://x.com/alice/article/123"]) {
				const result = await fetchContent({ url: selected }, undefined, { xBrowser: fixture.access, lookup });
				expect(result.extraction).toBe("x-browser");
				expect(result.content).toContain("Signed-in evidence");
			}
			expect([...fixture.tabs]).toEqual(["user-tab"]);
			await fixture.access.setMode("direct");
			await fixture.access.disconnect();
			expect(await fixture.access.defaultMode()).toBe("direct");
			expect(await fixture.access.read(parseXUrl(url)!, new AbortController().signal, 4096)).toBeUndefined();
			expect(fixture.unrelatedTouched).toBe(false);
			expect([...fixture.tabs]).toEqual(["user-tab"]);
			expect(JSON.parse(await readFile(join(fixture.directory, "preferences.json"), "utf8"))).toEqual({ mode: "direct" });
			if (process.platform !== "win32") expect((await stat(fixture.directory)).mode & 0o077).toBe(0);
		} finally { await fixture.close(); }
	});

	it("waits for conversation hydration instead of returning the server-rendered focal preview", async () => {
		const fixture = await browserFixture("hydrate");
		try {
			await fixture.access.connect(async () => true);
			const reading = fetchContent({ url }, undefined, { xBrowser: fixture.access, lookup });
			await fixture.preview.promise;
			fixture.release.resolve();
			expect((await reading).content).toContain("Author's next post");
			expect([...fixture.tabs]).toEqual(["user-tab"]);
		} finally { await fixture.close(); }
	});

	it("ignores a retired interception only after the browser confirms its request ended", async () => {
		for (const scenario of ["canceled-request", "broken-interception"] as const) {
			const fixture = await browserFixture(scenario);
			try {
				await fixture.access.connect(async () => true);
				const reading = fetchContent({ url }, undefined, { xBrowser: fixture.access, lookup });
				if (scenario === "canceled-request") expect((await reading).content).toContain("Signed-in evidence");
				else await expect(reading).rejects.toMatchObject({ kind: "extraction" });
				expect([...fixture.tabs]).toEqual(["user-tab"]);
			} finally { await fixture.close(); }
		}
	});

	it("allows bounded application assets by default but honors an explicit smaller byte limit", async () => {
		const fixture = await browserFixture("assets");
		try {
			await fixture.access.connect(async () => true);
			const result = await fetchContent({ url }, undefined, { xBrowser: fixture.access, lookup });
			expect(result.bytesRead).toBe(6 * 1024 * 1024);
			expect(result.content).toContain("Signed-in evidence");
			await expect(fetchContent({ url }, undefined, { xBrowser: fixture.access, lookup, maxResponseBytes: 1024 })).rejects.toMatchObject({ kind: "responseTooLarge" });
			expect([...fixture.tabs]).toEqual(["user-tab"]);
		} finally { await fixture.close(); }
	});

	it("keeps authorization revoked when disconnect races a queued mode change", async () => {
		const fixture = await browserFixture();
		try {
			await fixture.access.connect(async () => true);
			await Promise.all([fixture.access.disconnect(), fixture.access.setMode("public")]);
			expect(await fixture.access.read(parseXUrl(url)!, new AbortController().signal, 4096)).toBeUndefined();
			expect(await fixture.access.defaultMode()).toBe("public");
		} finally { await fixture.close(); }
	});

	it("waits for a late-created owned tab to close before disconnect completes", async () => {
		const fixture = await browserFixture("late-create");
		try {
			await fixture.access.connect(async () => true);
			const controller = new AbortController();
			const read = fixture.access.read(parseXUrl(url)!, controller.signal, 4096).catch((error) => error);
			await fixture.created.promise;
			controller.abort();
			expect(await read).toMatchObject({ kind: "canceled" });
			let disconnected = false;
			const disconnect = fixture.access.disconnect().then(() => { disconnected = true; });
			await Bun.sleep(10);
			expect(disconnected).toBe(false);
			fixture.release.resolve();
			await disconnect;
			expect([...fixture.tabs]).toEqual(["user-tab"]);
			expect(fixture.unrelatedTouched).toBe(false);
		} finally { await fixture.close(); }
	});

	it("cleans up resource-creation replies that arrive after the command timeout", async () => {
		const fixture = await browserFixture("late-create");
		const connection = await XBrowserConnection.open(await browserEndpoint(fixture.root), AbortSignal.timeout(2000));
		const cleaned = deferred();
		try {
			const creating = connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true }, undefined, {
				timeoutMs: 10,
				onLateResult: ({ targetId }) => { void connection.send("Target.closeTarget", { targetId }).then(cleaned.resolve); },
			});
			await fixture.created.promise;
			await expect(creating).rejects.toThrow("timed out");
			fixture.release.resolve();
			await cleaned.promise;
			expect([...fixture.tabs]).toEqual(["user-tab"]);
			expect(fixture.unrelatedTouched).toBe(false);
		} finally { connection.close(); await fixture.close(); }
	});

	it("does not start browser access when revocation arrives during a preferences read", async () => {
		// Isolate the filesystem scheduling boundary so the real race is deterministic.
		const program = `
			import { mock } from "bun:test";
			import assert from "node:assert/strict";
			import * as fs from "node:fs/promises";
			import { join } from "node:path";
			import { tmpdir } from "node:os";
			let release, started;
			const gate = new Promise(r => { release = r; });
			const reading = new Promise(r => { started = r; });
			let reads = 0, connections = 0;
			const originalReadFile = fs.readFile;
			mock.module("node:fs/promises", () => ({ ...fs, readFile: async (path, ...args) => {
				const value = await originalReadFile(path, ...args);
				if (String(path).endsWith("preferences.json") && ++reads === 1) { started(); await gate; }
				return value;
			} }));
			mock.module(${JSON.stringify(new URL("./x-cdp.ts", import.meta.url).pathname)}, () => ({ browserEndpoint: async () => { connections++; return "unused"; }, XBrowserConnection: { open: async () => { throw new Error("Must not connect"); } } }));
			const { XBrowserAccess } = await import(${JSON.stringify(new URL("./x-browser.ts", import.meta.url).href)});
			const directory = await fs.mkdtemp(join(tmpdir(), "pi-search-revoke-"));
			const access = new XBrowserAccess(directory);
			try {
				await fs.writeFile(join(directory, "preferences.json"), JSON.stringify({ mode: "auto", browser: "brave" }));
				const read = access.read({ url: "${url}", postId: "123", kind: "post" }, new AbortController().signal, 4096).catch(error => error);
				await reading;
				const disconnected = access.disconnect();
				release();
				assert.equal((await read).kind, "canceled");
				await disconnected;
				assert.equal(connections, 0);
			} finally { release(); await access.shutdown(); await fs.rm(directory, { recursive: true, force: true }); }
		`;
		const child = Bun.spawn([process.execPath, "--eval", program], { stdout: "pipe", stderr: "pipe" });
		const deadline = setTimeout(() => child.kill(), 4000);
		try {
			const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		} finally { clearTimeout(deadline); }
	});

	it("does not send an authorized target to FxTwitter when the browser becomes unavailable", async () => {
		const fixture = await browserFixture();
		let calls = 0;
		try {
			await fixture.access.connect(async () => true);
			for (const socket of fixture.sockets) socket.close();
			await fixture.server.stop(true);
			await expect(fetchContent({ url }, undefined, { xBrowser: fixture.access, lookup, transport: async () => { calls++; throw new Error("Private target leaked"); } })).rejects.toMatchObject({ kind: "extraction" });
			expect(calls).toBe(0);
		} finally { await fixture.close(); }
	});
});

for (const [scenario, kind] of [["redirect", "redirect"], ["large", "responseTooLarge"]] as const) {
	it(`closes only the owned tab after an unsafe ${scenario}`, async () => {
		const fixture = await browserFixture(scenario);
		try {
			await fixture.access.connect(async () => true);
			await expect(fixture.access.read(parseXUrl(url)!, AbortSignal.timeout(2000), 1024, lookup)).rejects.toMatchObject({ kind });
			expect(fixture.unsafeRedirectFollowed).toBe(false);
			expect(fixture.unrelatedTouched).toBe(false);
			expect([...fixture.tabs]).toEqual(["user-tab"]);
		} finally { await fixture.close(); }
	});
}
