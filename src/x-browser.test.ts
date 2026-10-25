import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHostRules, browserRequestAllowed, XBrowserAccess } from "./x-browser";
import { parseXUrl } from "./x-public";

it("contains automated browser traffic to pinned HTTPS X hosts and read operations", async () => {
	for (const value of ["https://x.com/alice/status/123", "https://abs.twimg.com/client-web/main.js", "https://pbs.twimg.com/media/image.jpg"]) expect(browserRequestAllowed(value, "GET")).toBe(true);
	for (const value of ["http://x.com/alice/status/123", "https://x.com:444/", "https://x.com.evil.test/", "https://localhost/", "https://127.0.0.1/", "https://x.com@evil.test/", "https://x.com/logout", "https://example.com/"]) expect(browserRequestAllowed(value, "GET")).toBe(false);
	for (const operation of ["TweetDetail", "Viewer"]) {
		expect(browserRequestAllowed(`https://x.com/i/api/graphql/hash/${operation}`, "GET")).toBe(true);
		expect(browserRequestAllowed(`https://x.com/i/api/graphql/hash/${operation}`, "POST")).toBe(true);
	}
	for (const method of ["GET", "POST"]) expect(browserRequestAllowed("https://x.com/i/api/graphql/hash/CreateTweet", method)).toBe(false);
	expect(browserRequestAllowed("https://x.com/i/api/friendships/create", "POST")).toBe(false);
	const rules = await browserHostRules(new AbortController().signal, async () => [{ address: "93.184.216.34", family: 4 }]);
	expect(rules).toContain("MAP x.com 93.184.216.34");
	expect(rules.endsWith("MAP * ~NOTFOUND")).toBe(true);
	await expect(browserHostRules(new AbortController().signal, async () => [{ address: "127.0.0.1", family: 4 }])).rejects.toMatchObject({ kind: "ssrf" });
});

describe("X profile consent", () => {
	it("disables authorization but never deletes a profile leased by another session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-search-x-busy-"));
		const access = new XBrowserAccess(directory);
		const lease = join(directory, `lease.${process.pid}.another-session`);
		try {
			await mkdir(join(directory, "profile"));
			await writeFile(join(directory, "preferences.json"), JSON.stringify({ mode: "auto", browserEnabled: true }));
			await writeFile(lease, "");
			await expect(access.read(parseXUrl("https://x.com/alice/status/123")!, new AbortController().signal, 1024)).rejects.toThrow("busy");
			await expect(access.logout()).rejects.toThrow("busy");
			expect((await stat(join(directory, "profile"))).isDirectory()).toBe(true);
			expect(JSON.parse(await readFile(join(directory, "preferences.json"), "utf8")).browserEnabled).toBe(false);
			await rm(lease);
			await access.logout();
			expect((await readdir(directory)).some((name) => name.startsWith("lease."))).toBe(false);
			await expect(stat(join(directory, "profile"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally { await access.shutdown(); await rm(directory, { recursive: true, force: true }); }
	});

	it("keeps profile ownership until a canceled browser launch finishes closing", async () => {
		// Isolate the browser-launch boundary mock; it must not affect other test files.
		const program = `
			import { mock } from "bun:test";
			import assert from "node:assert/strict";
			import * as fs from "node:fs/promises";
			import { join } from "node:path";
			import { tmpdir } from "node:os";
			const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
			const started = deferred(), launched = deferred(), closing = deferred(), closed = deferred();
			mock.module("node:fs/promises", () => ({ ...fs, access: async () => {} }));
			mock.module("playwright-core", () => ({ chromium: { launchPersistentContext: () => { started.resolve(); return launched.promise; } } }));
			const { XBrowserAccess } = await import(${JSON.stringify(new URL("./x-browser.ts", import.meta.url).href)});
			const directory = await fs.mkdtemp(join(tmpdir(), "pi-search-x-launch-"));
			const access = new XBrowserAccess(directory);
			try {
				const login = access.login(async () => true).catch(error => error);
				await started.promise;
				let loggedOut = false;
				const logout = access.logout().then(() => { loggedOut = true; });
				launched.resolve({ close: async () => { closing.resolve(); await closed.promise; } });
				await closing.promise;
				await Bun.sleep(25);
				assert.equal(loggedOut, false);
				assert.equal((await fs.stat(join(directory, "profile"))).isDirectory(), true);
				assert.equal((await fs.readdir(directory)).some(name => name.startsWith("lease.")), true);
				closed.resolve();
				await logout;
				assert.equal((await login).kind, "canceled");
				await assert.rejects(fs.stat(join(directory, "profile")), { code: "ENOENT" });
			} finally { closed.resolve(); await access.shutdown(); await fs.rm(directory, { recursive: true, force: true }); }
		`;
		const child = Bun.spawn([process.execPath, "--eval", program], { stdout: "pipe", stderr: "pipe" });
		const deadline = setTimeout(() => child.kill(), 4_000);
		try {
			const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		} finally { clearTimeout(deadline); }
	});

	it("does not launch or create a profile before authorization; persists modes privately", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-search-x-consent-"));
		const directory = join(root, "x");
		const access = new XBrowserAccess(directory);
		try {
			expect(await access.defaultMode()).toBe("auto");
			expect(await access.read(parseXUrl("https://x.com/alice/status/123")!, new AbortController().signal, 1024)).toBeUndefined();
			await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
			await access.setMode("direct");
			expect(await new XBrowserAccess(directory).defaultMode()).toBe("direct");
			expect(JSON.parse(await readFile(join(directory, "preferences.json"), "utf8"))).toEqual({ mode: "direct", browserEnabled: false });
			if (process.platform !== "win32") expect((await stat(directory)).mode & 0o077).toBe(0);
			await access.logout();
			expect(await access.defaultMode()).toBe("direct");
		} finally { await access.shutdown(); await rm(root, { recursive: true, force: true }); }
	});
});
