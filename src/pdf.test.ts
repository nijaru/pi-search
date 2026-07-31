import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { extractPdfText } from "./pdf";

function fakeSpawn(text: string, seen: { args?: readonly string[]; killed?: boolean }) {
	return (_command: string, args: readonly string[]) => {
		seen.args = args;
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => { seen.killed = true; };
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from(text));
			child.emit("close", 0);
		});
		return child;
	};
}

describe("local PDF extraction", () => {
	it("parses bounded text through a temporary file and removes it afterward", async () => {
		const seen: { args?: readonly string[] } = {};
		const result = await extractPdfText(new TextEncoder().encode("%PDF-test"), {
			signal: new AbortController().signal,
			maxPages: 3,
			spawnImpl: fakeSpawn("A PDF passage\n", seen),
		});
		expect(result.text).toBe("A PDF passage");
		expect(seen.args).toContain("-enc");
		expect(seen.args).toContain("3");
	const inputPath = seen.args?.at(-2);
		expect(inputPath).toBeDefined();
		await expect(Bun.file(inputPath!).exists()).resolves.toBe(false);
	});

	it("cancels the parser process", async () => {
		const seen: { spawned?: boolean; killed?: boolean } = {};
		const controller = new AbortController();
		const pending = extractPdfText(new TextEncoder().encode("%PDF-test"), {
			signal: controller.signal,
			spawnImpl: (_command, _args) => {
				seen.spawned = true;
				const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.kill = () => { seen.killed = true; queueMicrotask(() => child.emit("close", -1)); };
				return child;
			},
		});
		for (let attempt = 0; attempt < 20 && !seen.spawned; attempt += 1) await Bun.sleep(1);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "canceled" });
		expect(seen.killed).toBe(true);
	});
});
