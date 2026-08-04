import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { extractYouTubeTranscript, parseVtt, parseYouTubeUrl } from "./youtube";

function captionSpawn(caption: string, seen: { args?: readonly string[] }) {
	return (_command: string, args: readonly string[]) => {
		seen.args = args;
		const template = String(args[args.indexOf("--output") + 1]);
		const outputPath = template.replace("%(ext)s", "en.vtt");
		writeFileSync(outputPath, caption);
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		queueMicrotask(() => child.emit("close", 0));
		return child;
	};
}

describe("local YouTube captions", () => {
	it("recognizes supported video URL forms and rejects playlists", () => {
		expect(parseYouTubeUrl("https://www.youtube.com/watch?v=abc12345678")).toEqual({ videoId: "abc12345678" });
		expect(parseYouTubeUrl("https://youtu.be/abc12345678")).toEqual({ videoId: "abc12345678" });
		expect(parseYouTubeUrl("https://www.youtube.com/shorts/abc12345678")).toEqual({ videoId: "abc12345678" });
		expect(parseYouTubeUrl("https://www.youtube.com/playlist?list=abc12345678")).toBeUndefined();
		expect(parseYouTubeUrl("http://www.youtube.com/watch?v=abc12345678")).toBeUndefined();
		expect(parseYouTubeUrl("https://user:pass@www.youtube.com/watch?v=abc12345678")).toBeUndefined();
		expect(parseYouTubeUrl("ftp://www.youtube.com/watch?v=abc12345678")).toBeUndefined();
	});

	it("strips VTT metadata, timestamps, markup, and duplicate cues", () => {
		const text = parseVtt("WEBVTT\nKind: captions\nLanguage: en\n\n1\n00:00.000 --> 00:01.000\nHello <b>world</b>\n\n2\n00:01.000 --> 00:02.000\nHello world\n");
		expect(text).toBe("Hello world");
	});

	it("preserves numeric and arrow-containing caption text", () => {
		expect(parseVtt("WEBVTT\n\n00:00.000 --> 00:01.000\n2025\nNOTE\nThis --> stays\n")).toBe("2025\nNOTE\nThis --> stays");
	});

	it("extracts captions with yt-dlp flags and cleans temporary files", async () => {
		const seen: { args?: readonly string[] } = {};
		const result = await extractYouTubeTranscript("https://www.youtube.com/watch?v=abc12345678", {
			signal: new AbortController().signal,
			language: "en.*",
			spawnImpl: captionSpawn("WEBVTT\n\n00:00.000 --> 00:01.000\nA caption\n", seen),
		});
		expect(result.text).toBe("A caption");
		expect(seen.args).toContain("--ignore-config");
		expect(seen.args).not.toContain("--no-netrc");
		expect(seen.args).toContain("--no-playlist");
		expect(seen.args).toContain("--skip-download");
		expect(seen.args).toContain("--write-auto-subs");
		expect(seen.args?.[seen.args!.indexOf("--sub-langs") + 1]).toBe("en.*");
		const template = String(seen.args?.[seen.args!.indexOf("--output") + 1]);
		expect(await Bun.file(template.replace("%(ext)s", "en.vtt")).exists()).toBe(false);
	});
});
