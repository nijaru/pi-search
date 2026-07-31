import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeFetchError } from "./fetch-errors";

export const DEFAULT_YOUTUBE_LANGUAGE = "en";
export const MAX_YOUTUBE_LANGUAGE_LENGTH = 32;
export const MAX_YOUTUBE_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export interface YouTubeUrl {
	readonly videoId: string;
}

export interface YouTubeExtractorOptions {
	readonly command?: string;
	readonly language?: string;
	readonly maxOutputBytes?: number;
	readonly signal: AbortSignal;
	readonly spawnImpl?: (command: string, args: readonly string[], options: Record<string, unknown>) => any;
}

export interface YouTubeTranscriptResult {
	readonly text: string;
	readonly bytesRead: number;
	readonly videoId: string;
}

export function parseYouTubeUrl(value: string): YouTubeUrl | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.port.length > 0) return undefined;
		const hostname = url.hostname.toLowerCase();
		if (hostname === "youtu.be") {
			const id = url.pathname.slice(1).split("/", 1)[0];
			return validVideoId(id);
		}
		if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(hostname)) return undefined;
		const id = url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?]+)/)?.[1];
		return validVideoId(id ?? "");
	} catch {
		return undefined;
	}
}

function validVideoId(value: string): YouTubeUrl | undefined {
	return /^[A-Za-z0-9_-]{6,24}$/.test(value) ? { videoId: value } : undefined;
}

function extraction(message: string, cause?: unknown): SafeFetchError {
	return new SafeFetchError({ kind: "extraction", message, cause });
}

function canceled(): SafeFetchError {
	return new SafeFetchError({ kind: "canceled", message: "YouTube transcript extraction canceled" });
}

function boundedCommand(command: string, args: readonly string[], maxOutputBytes: number): { command: string; args: readonly string[]; options: Record<string, unknown> } {
	if (process.platform === "win32") return { command, args, options: { stdio: ["ignore", "ignore", "pipe"] } };
	const blocks = Math.max(1, Math.ceil(maxOutputBytes / 512));
	return {
		command: "/bin/sh",
		args: ["-c", `ulimit -f ${blocks}; exec "$@"`, "pi-search-yt-dlp", command, ...args],
		options: { stdio: ["ignore", "ignore", "pipe"], detached: true },
	};
}

async function runYtDlp(
	command: string,
	args: readonly string[],
	directory: string,
	maxOutputBytes: number,
	signal: AbortSignal,
	spawnImpl: NonNullable<YouTubeExtractorOptions["spawnImpl"]>,
): Promise<void> {
	if (signal.aborted) throw canceled();
	await new Promise<void>((resolve, reject) => {
		let child: any;
		let settled = false;
		let terminationError: SafeFetchError | undefined;
		let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
		let monitorTimer: ReturnType<typeof setInterval> | undefined;
		const finish = (error?: unknown): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
			if (monitorTimer !== undefined) clearInterval(monitorTimer);
			if (error === undefined) resolve(); else reject(error);
		};
		const kill = (): void => {
			try {
				if (child?.pid && process.platform !== "win32") {
					try { process.kill(-child.pid, "SIGKILL"); } catch { /* group may already be gone */ }
				}
				child?.kill?.("SIGKILL");
			} catch { /* best effort */ }
		};
		const terminate = (error: SafeFetchError): void => {
			if (settled || terminationError !== undefined) return;
			terminationError = error;
			kill();
			fallbackTimer = setTimeout(() => finish(error), 1_000);
		};
		const onAbort = (): void => terminate(canceled());
		try {
			const bounded = boundedCommand(command, args, maxOutputBytes);
			child = spawnImpl(bounded.command, bounded.args, bounded.options);
			signal.addEventListener("abort", onAbort, { once: true });
			let diagnostics = "";
			child.stderr?.on("data", (chunk: unknown) => {
				if (diagnostics.length < 8_192) diagnostics += String(chunk).slice(0, 8_192 - diagnostics.length);
			});
			monitorTimer = setInterval(() => {
				void (async () => {
					if (settled || terminationError !== undefined) return;
					try {
						const files = await readdir(directory);
						let total = 0;
						for (const file of files) total += (await stat(join(directory, file))).size;
						if (total > maxOutputBytes) terminate(new SafeFetchError({ kind: "responseTooLarge", message: "YouTube captions exceed the configured extraction limit" }));
					} catch {
						// The process may create the directory entries between polls.
					}
				})();
			}, 50);
			child.once("error", (error: unknown) => finish(extraction(`yt-dlp could not start: ${error instanceof Error ? error.message : String(error)}`, error)));
			child.once("close", (code: number | null) => {
				if (settled) return;
				if (terminationError !== undefined) return finish(terminationError);
				if (signal.aborted) return finish(canceled());
				if (code !== 0) return finish(extraction(diagnostics.trim().slice(0, 500) || `yt-dlp exited with ${code}`));
				finish();
			});
			if (signal.aborted) onAbort();
		} catch (error) {
			finish(extraction(`yt-dlp could not start: ${error instanceof Error ? error.message : String(error)}`, error));
		}
	});
}

/** Strip VTT cue metadata and adjacent duplicate caption lines. */
export function parseVtt(value: string): string {
	const lines = value.replace(/^\uFEFF?WEBVTT[^\n]*\n?/i, "").split(/\r?\n/);
	const output: string[] = [];
	let inNote = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "NOTE" || line.startsWith("NOTE ") || line === "STYLE" || line === "REGION") {
			inNote = true;
			continue;
		}
		if (line === "") {
			inNote = false;
			continue;
		}
		if (inNote || line.includes("-->") || /^\d+$/.test(line)) continue;
		const clean = line.replace(/<\/?[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
		if (clean.length > 0 && output.at(-1) !== clean) output.push(clean);
	}
	return output.join("\n");
}

export async function extractYouTubeTranscript(url: string, options: YouTubeExtractorOptions): Promise<YouTubeTranscriptResult> {
	const parsed = parseYouTubeUrl(url);
	if (parsed === undefined) throw new SafeFetchError({ kind: "invalidRequest", message: "URL is not a supported YouTube video URL" });
	if (options.signal.aborted) throw canceled();
	if (process.platform === "win32") throw extraction("Bounded YouTube caption extraction requires a POSIX process limit on this runtime");
	const language = options.language ?? DEFAULT_YOUTUBE_LANGUAGE;
	if (!/^[A-Za-z0-9,._-]{1,32}$/.test(language) || language.split(",").length > 3) throw new SafeFetchError({ kind: "invalidRequest", message: "captionLanguage is invalid" });
	const maxOutputBytes = options.maxOutputBytes ?? MAX_YOUTUBE_TRANSCRIPT_BYTES;
	if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_YOUTUBE_TRANSCRIPT_BYTES) {
		throw new SafeFetchError({ kind: "invalidRequest", message: "YouTube transcript limit is outside the supported bound" });
	}
	const directory = await mkdtemp(join(tmpdir(), "pi-search-youtube-"));
	try {
		const outputTemplate = join(directory, "captions.%(ext)s");
		const canonicalUrl = `https://www.youtube.com/watch?v=${parsed.videoId}`;
		await runYtDlp(options.command ?? "yt-dlp", [
			"--ignore-config",
			"--no-netrc",
			"--no-playlist",
			"--skip-download",
			"--write-subs",
			"--write-auto-subs",
			"--sub-langs", language,
			"--sub-format", "vtt",
			"--output", outputTemplate,
			"--no-warnings",
			canonicalUrl,
		], directory, maxOutputBytes, options.signal, options.spawnImpl ?? (spawn as unknown as NonNullable<YouTubeExtractorOptions["spawnImpl"]>));
		if (options.signal.aborted) throw canceled();
		const files = (await readdir(directory)).filter((file) => file.endsWith(".vtt")).sort();
		if (files.length === 0) throw extraction("No YouTube captions were available for the requested language");
		if (files.length > 4) throw new SafeFetchError({ kind: "responseTooLarge", message: "Too many YouTube caption tracks were returned" });
		let bytesRead = 0;
		const parts: string[] = [];
		for (const file of files) {
			if (options.signal.aborted) throw canceled();
			const size = (await stat(join(directory, file))).size;
			if (size > maxOutputBytes - bytesRead) throw new SafeFetchError({ kind: "responseTooLarge", message: "YouTube captions exceed the configured extraction limit" });
			const bytes = await readFile(join(directory, file));
			bytesRead += bytes.byteLength;
			if (bytesRead > maxOutputBytes) throw new SafeFetchError({ kind: "responseTooLarge", message: "YouTube captions exceed the configured extraction limit" });
			parts.push(parseVtt(bytes.toString("utf8")));
		}
		const text = parts.filter((part) => part.length > 0).join("\n").trim();
		if (text.length === 0) throw extraction("YouTube captions contained no extractable text");
		return { text, bytesRead, videoId: parsed.videoId };
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}
