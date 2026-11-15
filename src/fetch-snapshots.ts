import { randomUUID } from "node:crypto";
import type { FetchRequest, FetchedContent } from "./contracts";
import { SafeFetchError } from "./fetch-errors";
import { normalizeSearchUrl } from "./search-cleanup";
import { MAX_X_REPLIES } from "./x-public";

/** Page length and offset do not affect extraction identity. */
export type FetchSnapshotRequest = Pick<FetchRequest,
	"url" | "format" | "readable" | "allowRawHtmlFallback" | "maxPages" | "captionLanguage" | "xMode" | "xReplies"
>;
type SnapshotControls = Omit<FetchSnapshotRequest, "url">;
const CONTROL_KEYS = ["format", "readable", "allowRawHtmlFallback", "maxPages", "captionLanguage", "xMode", "xReplies"] as const;

export interface FetchSnapshots {
	/** Retain an unsliced, extraction-bounded result. Oversized results are not retained. */
	retain(request: FetchSnapshotRequest, content: FetchedContent): string | undefined;
	/** No I/O or live fallback. Omitted controls inherit the retained extraction. */
	read(id: string, request: FetchSnapshotRequest): FetchedContent;
	has(id: string): boolean;
	discard(id: string): void;
	clear(): void;
	/** Terminal, idempotent shutdown: also prevents late fetches from repopulating the store. */
	close(): void;
}

export interface FetchSnapshotOptions {
	readonly maxCount?: number;
	/** Accounted UTF-16 content plus conservative serialized metadata, not exact heap usage. */
	readonly maxBytes?: number;
	readonly ttlMs?: number;
	readonly now?: () => number;
}

function snapshotUrl(request: FetchSnapshotRequest): string {
	const url = normalizeSearchUrl(request.url)?.url;
	if (url === undefined) throw new SafeFetchError({ kind: "invalidRequest", message: "Snapshot URL must be a valid HTTP(S) URL" });
	return url;
}

function extractionControls(request: FetchSnapshotRequest): SnapshotControls {
	return {
		format: request.format ?? "markdown", readable: request.readable ?? true,
		allowRawHtmlFallback: request.allowRawHtmlFallback ?? true, maxPages: request.maxPages,
		captionLanguage: request.captionLanguage?.trim() ?? "en", xMode: request.xMode,
		xReplies: request.xMode === "public" ? request.xReplies ?? MAX_X_REPLIES : request.xReplies,
	};
}

/** Instance-local, lazy-expiring FIFO store. Reads do not extend retention. No timers or disk. */
export function createFetchSnapshots(options: FetchSnapshotOptions = {}): FetchSnapshots {
	const maxCount = options.maxCount ?? 8;
	const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
	const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
	for (const [name, value] of Object.entries({ maxCount, maxBytes, ttlMs })) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	}
	const now = options.now ?? Date.now;
	const entries = new Map<string, { url: string; controls: SnapshotControls; result: FetchedContent; expiresAt: number; bytes: number }>();
	let bytes = 0;
	let closed = false;
	const remove = (id: string): void => {
		const entry = entries.get(id);
		if (entry) { bytes -= entry.bytes; entries.delete(id); }
	};
	const prune = (): void => {
		const time = now();
		for (const [id, entry] of entries) if (entry.expiresAt <= time) remove(id);
	};
	const clear = (): void => { entries.clear(); bytes = 0; };
	return {
		retain(request, content) {
			if (closed) return undefined;
			prune();
			const url = snapshotUrl(request);
			const controls = extractionControls(request);
			const id = randomUUID();
			const { content: text, ...metadata } = content;
			const size = text.length * 2 + JSON.stringify({ id, url, controls, metadata }).length * 2;
			if (size > maxBytes) return undefined;
			// Clone only admitted content. Callers cannot mutate retained metadata.
			const result = structuredClone(content);
			while (entries.size >= maxCount || bytes + size > maxBytes) remove(entries.keys().next().value!);
			entries.set(id, { url, controls, result, expiresAt: now() + ttlMs, bytes: size });
			bytes += size;
			return id;
		},
		read(id, request) {
			prune();
			const entry = entries.get(id);
			if (!entry) throw new SafeFetchError({ kind: "snapshotUnavailable", message: "Fetch snapshot is unknown, expired, evicted, or closed; fetch the URL without snapshotId to create a new extraction" });
			if (entry.url !== snapshotUrl(request)) throw new SafeFetchError({ kind: "snapshotMismatch", message: "Fetch snapshot URL does not match the original requested URL (not the redirected URL)" });
			const controls = extractionControls(request);
			if (CONTROL_KEYS.some(key => request[key] !== undefined && controls[key] !== entry.controls[key])) throw new SafeFetchError({ kind: "snapshotMismatch", message: "Explicit extraction controls do not match the snapshot; omit them to page the retained extraction or fetch without snapshotId" });
			return structuredClone(entry.result);
		},
		has(id) { prune(); return entries.has(id); },
		discard: remove,
		clear,
		close() { closed = true; clear(); },
	};
}

/** Release hidden pages and never advertise an ID already evicted by this batch. */
export function finalizeFetchSnapshots(all: readonly FetchedContent[], visible: readonly FetchedContent[], snapshots?: FetchSnapshots): readonly FetchedContent[] {
	if (snapshots === undefined) return visible;
	const shown = new Set(visible.map(page => page.snapshotId));
	for (const page of all) if (page.snapshotId !== undefined && !shown.has(page.snapshotId)) snapshots.discard(page.snapshotId);
	return visible.map(page => {
		if (page.snapshotId === undefined || snapshots.has(page.snapshotId)) return page;
		const { snapshotId, ...content } = page;
		return content;
	});
}
