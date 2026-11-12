import type { XConversationMetadata } from "./contracts";
import { SafeFetchError } from "./fetch-errors";

export interface XUrl {
	url: string;
	postId?: string;
	articleId?: string;
	kind: "post" | "article";
}

export interface XReadResult {
	url: string;
	title?: string;
	content: string;
	warnings: readonly string[];
	postCount: number;
	conversation?: XConversationMetadata;
}

const ID = /^\d{2,20}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const CONTROLS = /[\u0000-\u0020\u007f-\u009f]/;
const MAX_POSTS = 100;
export const MAX_X_REPLIES = 200;
export const MAX_X_CONVERSATION_PAGES = 8;
const MAX_CONVERSATION_POSTS = 1_000;
const MAX_CONVERSATION_CHARACTERS = 3_000_000;
const CONVERSATION_TIMEOUT_MS = 20_000;
const MAX_BLOCKS = 2_000;
type ObjectValue = Record<string, unknown>;
type Reader = (url: string, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; url: string; status: number; redirectCount: number }>;

export function parseXUrl(value: string): XUrl | undefined {
	if (CONTROLS.test(value) || value.includes("\\")) return undefined;
	// Check the literal authority too: URL parsing otherwise accepts encoded hostnames.
	if (!/^https?:\/\/(?:x\.com|www\.x\.com|twitter\.com|www\.twitter\.com)(?::\d+)?(?:\/|$|[?#])/i.test(value)) return undefined;
	let parsed: URL;
	try { parsed = new URL(value); } catch { return undefined; }
	if (parsed.username || parsed.password || parsed.port) return undefined;
	const path = parsed.pathname;
	const bare = /^\/i\/article\/(\d{2,20})\/?$/.exec(path);
	if (bare) return { url: `https://x.com/i/article/${bare[1]}`, articleId: bare[1], kind: "article" };
	const web = /^\/i\/web\/status\/(\d{2,20})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(path);
	if (web) return { url: `https://x.com/i/web/status/${web[1]}`, postId: web[1], kind: "post" };
	const post = /^\/([A-Za-z0-9_]{1,15})\/(status|article)\/(\d{2,20})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(path);
	if (!post || post[1].toLowerCase() === "i") return undefined;
	return { url: `https://x.com/${post[1]}/${post[2]}/${post[3]}`, postId: post[3], kind: post[2] === "article" ? "article" : "post" };
}

function extraction(message = "FxTwitter returned unavailable or invalid public X content"): SafeFetchError {
	return new SafeFetchError({ kind: "extraction", message });
}

function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function id(value: unknown): string | undefined {
	return typeof value === "string" && ID.test(value) ? value : undefined;
}

function clean(value: string): string {
	return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Remote prose is literal, not Markdown instructions, HTML, or reference definitions. */
function literal(value: string): string {
	return clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/[\\`*_{}\[\]()#+.!|~\-]/g, "\\$&");
}

function external(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 8192 || CONTROLS.test(value) || /\\|%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/i.test(value)) return undefined;
	try {
		const url = new URL(value);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
		return url.href.replace(/[<>"()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	} catch { return undefined; }
}

function link(label: string, value: unknown): string {
	const url = external(value);
	return url ? `[${literal(label)}](<${url}>)` : literal(label);
}

function fence(value: string, language = ""): string {
	const text = clean(value);
	let width = 3;
	for (const run of text.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1);
	const delimiter = "`".repeat(width);
	return `${delimiter}${/^[\w+-]{0,32}$/.test(language) ? language : ""}\n${text}\n${delimiter}`;
}

function markdownEntity(value: string): string {
	// Preserve code, but never trust an atomic entity as arbitrary Markdown/HTML.
	const match = /^(`{3,})([\w+-]{0,32})\n([\s\S]*?)\n\1\s*$/.exec(clean(value));
	return match ? fence(match[3], match[2]) : literal(value);
}

/** Bound the entire untrusted tree before any specialized traversal. No recursive descent. */
function validateTree(root: unknown): void {
	const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
	let nodes = 0;
	while (pending.length) {
		const { value, depth } = pending.pop()!;
		if (++nodes > 100_000 || depth > 32) throw extraction("FxTwitter content exceeds safe structure limits");
		if (value !== null && typeof value === "object") {
			const children = Object.values(value);
			if (children.length > 20_000) throw extraction("FxTwitter content exceeds safe structure limits");
			for (const child of children) pending.push({ value: child, depth: depth + 1 });
		}
	}
}

function usablePost(value: unknown): value is ObjectValue {
	const post = object(value);
	return !!post && post.type === "status" && id(post.id) !== undefined && authorKey(post) !== undefined;
}

function authorKey(post: ObjectValue): string | undefined {
	const author = object(post.author);
	const handle = string(author?.screen_name);
	return id(author?.id) ?? (handle && HANDLE.test(handle) ? handle.toLowerCase() : undefined);
}

function parentId(post: ObjectValue): string | undefined {
	return id(object(post.replying_to)?.status);
}

function postUrl(post: ObjectValue): string {
	const handle = string(object(post.author)?.screen_name);
	return `https://x.com/${handle && HANDLE.test(handle) ? handle : "i/web"}/status/${post.id}`;
}

/** Once earlier evidence is validated, these page failures must not discard it. */
function isRecoverablePageFailure(error: unknown): error is SafeFetchError {
	return error instanceof SafeFetchError && ["http", "network", "extraction", "redirect", "responseTooLarge"].includes(error.kind);
}

async function fetchPayload(postId: string, endpoint: "thread" | "status" | "conversation", read: Reader, signal?: AbortSignal, cursor?: string): Promise<ObjectValue> {
	if (signal?.aborted) throw new SafeFetchError({ kind: "canceled", message: "X read canceled" });
	let response: Awaited<ReturnType<Reader>>;
	try { response = await read(`https://api.fxtwitter.com/2/${endpoint}/${postId}${endpoint === "conversation" ? `?ranking_mode=likes${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}` : ""}`, signal); }
	catch (error) {
		if (error instanceof SafeFetchError) throw new SafeFetchError({ kind: error.kind, status: error.status, message: "FxTwitter public X request failed", retryable: error.retryable });
		throw extraction("FxTwitter public X request failed");
	}
	if (signal?.aborted) throw new SafeFetchError({ kind: "canceled", message: "X read canceled" });
	if (response.status < 200 || response.status >= 300) throw new SafeFetchError({ kind: "http", status: response.status, message: "FxTwitter public X request failed" });
	let value: unknown;
	try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)); }
	catch { throw extraction("FxTwitter returned invalid JSON"); }
	validateTree(value);
	const payload = object(value);
	if (payload?.code !== 200 || !usablePost(payload.status) || payload.status.id !== postId) throw extraction();
	if (payload.thread !== undefined && payload.thread !== null && !Array.isArray(payload.thread)) throw extraction();
	if (endpoint === "conversation" && payload.replies !== null && !Array.isArray(payload.replies)) throw extraction("FxTwitter did not provide reply data");
	return payload;
}

interface Range { start: number; end: number; value: ObjectValue }
function ranges(value: unknown, length: number): Range[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 256) throw extraction("FxTwitter article has invalid text ranges");
	return value.map((raw) => {
		const item = object(raw);
		const start = item?.offset;
		const size = item?.length;
		if (!item || typeof start !== "number" || typeof size !== "number" || !Number.isInteger(start) || !Number.isInteger(size) || start < 0 || size < 0 || start + size > length) throw extraction("FxTwitter article has invalid text ranges");
		return { start, end: start + size, value: item };
	});
}

function articleMedia(media: ObjectValue): string[] {
	const info = object(media.media_info);
	const urls: unknown[] = [info?.original_img_url, info?.media_url_https];
	const variants = info?.variants ?? object(info?.video_info)?.variants;
	if (Array.isArray(variants)) for (const variant of variants) urls.push(object(variant)?.url);
	return [...new Set(urls.map(external).filter((url): url is string => !!url))];
}

function articleBody(article: ObjectValue): string {
	const content = object(article.content);
	if (!Array.isArray(content?.blocks) || !content.blocks.length || content.blocks.length > MAX_BLOCKS) throw extraction("FxTwitter did not provide the full Article body");
	const entities = new Map<string, ObjectValue>();
	if (Array.isArray(content.entityMap)) {
		if (content.entityMap.length > 4_000) throw extraction("FxTwitter article exceeds entity limits");
		for (const entry of content.entityMap) {
			const item = object(entry);
			const entity = object(item?.value);
			if (!item || !entity || typeof item.key !== "string" || entities.has(item.key)) throw extraction();
			entities.set(item.key, entity);
		}
	} else if (object(content.entityMap)) {
		const entries = Object.entries(content.entityMap as ObjectValue);
		if (entries.length > 4_000) throw extraction();
		for (const [key, value] of entries) {
			const entity = object(value);
			if (!entity) throw extraction();
			entities.set(key, entity);
		}
	} else if (content.entityMap !== undefined) throw extraction();
	const media = new Map<string, ObjectValue>();
	if (Array.isArray(article.media_entities)) for (const item of article.media_entities) {
		const entry = object(item);
		if (entry && typeof entry.media_id === "string") media.set(entry.media_id, entry);
	}
	let substantive = false;
	let renderedLength = 0;
	const bounded = (text: string): string => {
		renderedLength += text.length;
		if (renderedLength > 32_000_000) throw extraction("FxTwitter Article exceeds safe rendering limits");
		return text;
	};
	const parts = content.blocks.map((raw) => {
		const block = object(raw);
		if (!block || typeof block.text !== "string" || typeof block.type !== "string") throw extraction();
		const text = block.text;
		const entityRanges = ranges(block.entityRanges, text.length);
		const styles = ranges(block.inlineStyleRanges, text.length);
		if (block.type === "atomic") {
			if (!entityRanges.length) throw extraction("FxTwitter Article contains an unavailable body block");
			const renderEntity = (range: Range): string => {
				const entity = entities.get(String(range.value.key));
				const data = object(entity?.data);
				if (!entity || !data) throw extraction();
				switch (entity.type) {
					case "DIVIDER": return "---";
					case "MARKDOWN": {
						if (typeof data.markdown !== "string" || !data.markdown.trim()) throw extraction();
						substantive = true;
						return markdownEntity(data.markdown);
					}
					case "TWEET": {
						const tweetId = id(data.tweetId);
						if (!tweetId) throw extraction();
						substantive = true;
						return link("Embedded post", `https://x.com/i/web/status/${tweetId}`);
					}
					case "MEDIA": {
						if (!Array.isArray(data.mediaItems) || !data.mediaItems.length || data.mediaItems.length > 100) throw extraction();
						const rendered: string[] = [];
						let mediaLength = 0;
						for (const item of data.mediaItems) {
							const entry = media.get(String(object(item)?.mediaId));
							if (!entry) throw extraction("FxTwitter Article media is unavailable");
							for (const url of articleMedia(entry)) {
								const piece = link("Article media", url);
								mediaLength += piece.length;
								if (mediaLength + renderedLength > 32_000_000) throw extraction("FxTwitter Article exceeds safe rendering limits");
								rendered.push(piece);
							}
						}
						if (!rendered.length) throw extraction("FxTwitter Article media is unavailable");
						substantive = true;
						return rendered.join("\n\n");
					}
					default: throw extraction("FxTwitter Article contains an unsupported body block");
				}
			};
			return entityRanges.map((range) => bounded(renderEntity(range))).join("\n\n");
		}
		if (text.trim()) substantive = true;
		// Segment on range boundaries. Each segment is escaped independently, so ranges
		// cannot inject syntax, even when styles and links overlap.
		const boundaries = [...new Set([0, text.length, ...entityRanges.flatMap((r) => [r.start, r.end]), ...styles.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
		let rendered = "";
		for (let index = 0; index < boundaries.length - 1; index++) {
			const start = boundaries[index];
			const end = boundaries[index + 1];
			const segment = text.slice(start, end);
			let piece = literal(segment);
			for (const style of styles.filter((r) => r.start <= start && r.end >= end)) {
				const name = String(style.value.style).toLowerCase();
				const marker = name === "bold" ? "**" : name === "italic" ? "*" : name === "strikethrough" ? "~~" : undefined;
				if (marker) piece = `${marker}${piece}${marker}`;
			}
			const range = entityRanges.find((r) => r.start <= start && r.end >= end);
			if (range) {
				const entity = entities.get(String(range.value.key));
				if (!entity || entity.type !== "LINK") throw extraction("FxTwitter Article contains an unsupported inline entity");
				const url = external(object(entity.data)?.url);
				if (url) piece = `[${piece}](<${url}>)`;
			}
			rendered += piece;
		}
		bounded(rendered);
		const depth = block.depth ?? 0;
		if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 8) throw extraction();
		const heading = ["header-one", "header-two", "header-three", "header-four", "header-five", "header-six"].indexOf(block.type);
		if (heading >= 0) return `${"#".repeat(heading + 1)} ${rendered}`;
		if (block.type === "blockquote") return rendered.split("\n").map((line) => `> ${line}`).join("\n");
		if (block.type === "code-block") return fence(text);
		if (block.type.endsWith("list-item")) {
			const prefix = `${"  ".repeat(depth)}${block.type === "ordered-list-item" ? "1." : "-"} `;
			return prefix + rendered.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
		}
		return rendered;
	});
	if (!substantive) throw extraction("FxTwitter did not provide the full Article body");
	return parts.join("\n\n");
}

function mediaLinks(post: ObjectValue): string[] {
	const media = object(post.media);
	const items = Array.isArray(media?.all) ? media.all : [...(Array.isArray(media?.photos) ? media.photos : []), ...(Array.isArray(media?.videos) ? media.videos : [])];
	const urls = items.map((item) => external(object(item)?.url));
	const externalMedia = external(object(media?.external)?.url);
	if (externalMedia) urls.push(externalMedia);
	return [...new Set(urls.filter((url): url is string => !!url))].map((url) => link("Media", url));
}

function renderPost(post: ObjectValue, warnings: Set<string>): string {
	const author = object(post.author)!;
	const name = string(author.name) ?? string(author.screen_name) ?? "X author";
	const handle = string(author.screen_name);
	const date = string(post.created_at);
	const heading = `## ${literal(name)}${handle ? ` (@${literal(handle)})` : ""}`;
	const metadata = [link("Source", postUrl(post)), date ? literal(date) : ""].filter(Boolean).join(" · ");
	const article = object(post.article);
	if (post.article !== undefined && post.article !== null && !article) throw extraction();
	const text = string(post.text) ?? string(object(post.raw_text)?.text);
	if (!article && !text?.trim() && !mediaLinks(post).length && !post.quote) throw extraction();
	const body = article ? `${typeof article.title === "string" ? `# ${literal(article.title)}\n\n` : ""}${articleBody(article)}` : literal(text ?? "");
	const parts = [heading, metadata, body, ...mediaLinks(post)];
	if (post.quote !== undefined && post.quote !== null) {
		if (usablePost(post.quote)) {
			const quote = post.quote;
			parts.push(`### Quoted post\n\n${link("Quote source", postUrl(quote))}\n\n${literal(string(quote.text) ?? string(object(quote.raw_text)?.text) ?? "")}\n\n${mediaLinks(quote).join("\n\n")}`);
		} else {
			warnings.add("Partial result: a quoted post is unavailable.");
			const quoteId = id(object(post.quote)?.id);
			parts.push(quoteId ? link("Unavailable quoted post", `https://x.com/i/web/status/${quoteId}`) : "Quoted post unavailable.");
		}
	}
	return parts.filter(Boolean).join("\n\n");
}

/** Only connected posts by the focal author belong to a thread, never arbitrary replies. */
function orderedThread(posts: Map<string, ObjectValue>, focal: ObjectValue, maxPosts = MAX_POSTS): ObjectValue[] {
	const key = authorKey(focal);
	const selected = new Set<string>([String(focal.id)]);
	let ancestor = focal;
	while (selected.size < maxPosts) {
		const parent = posts.get(parentId(ancestor) ?? "");
		if (!parent || authorKey(parent) !== key || selected.has(String(parent.id))) break;
		selected.add(String(parent.id));
		ancestor = parent;
	}
	for (let changed = true; changed && selected.size < maxPosts;) {
		changed = false;
		for (const [postId, post] of posts) {
			if (!selected.has(postId) && authorKey(post) === key && selected.has(parentId(post) ?? "")) {
				selected.add(postId);
				changed = true;
				if (selected.size === maxPosts) break;
			}
		}
	}
	const result: ObjectValue[] = [];
	const remaining = new Set(selected);
	while (remaining.size) {
		const ready = [...remaining].filter((postId) => !remaining.has(parentId(posts.get(postId)!) ?? "")).sort((a, b) => a.length - b.length || a.localeCompare(b));
		if (!ready.length) throw extraction("FxTwitter returned an invalid thread relationship");
		for (const postId of ready) { result.push(posts.get(postId)!); remaining.delete(postId); }
	}
	return result;
}

async function readAuthorThread(target: XUrl & { postId: string }, read: Reader, signal?: AbortSignal): Promise<XReadResult> {
	const payload = await fetchPayload(target.postId, target.kind === "article" ? "status" : "thread", read, signal);
	const focal = payload.status as ObjectValue;
	if (target.kind === "article" && !object(focal.article)) throw extraction("FxTwitter did not provide the full Article body");
	const assemble = (response: ObjectValue, previous?: { posts: Map<string, ObjectValue>; warnings: Set<string> }) => {
		const posts = new Map(previous?.posts ?? [[target.postId, focal]]);
		const warnings = new Set(previous?.warnings ?? [
			...(focal.article ? [] : ["Thread completeness is unknown; FxTwitter may omit posts."]),
			"Other users' replies are excluded by xReplies: 0.",
		]);
		if (!focal.article && target.kind === "post") for (const entry of (response.thread as unknown[] | null | undefined) ?? []) {
			if (!usablePost(entry)) { warnings.add("Partial thread: one or more posts are unavailable."); continue; }
			if (authorKey(entry) !== authorKey(focal)) continue;
			// Resolve relationships before capping; reverse-order feeds can put the
			// root's children after many descendants.
			if (!posts.has(String(entry.id))) posts.set(String(entry.id), entry);
		}
		const expanded = orderedThread(posts, focal, MAX_POSTS + 1);
		const limited = expanded.length > MAX_POSTS;
		const ordered = limited ? orderedThread(posts, focal) : expanded;
		const parts: string[] = [];
		let characters = 0;
		for (const post of ordered) {
			const body = renderPost(post, warnings);
			characters += body.length + (parts.length === 0 ? 0 : 7);
			if (characters > MAX_CONVERSATION_CHARACTERS) throw new SafeFetchError({ kind: "responseTooLarge", message: "X author thread exceeds the conversation character limit" });
			parts.push(body);
		}
		const content = parts.join("\n\n---\n\n");
		return { posts, warnings, ordered, content, limited };
	};
	let state = assemble(payload);
	if (!focal.article && state.ordered.length > 1 && state.ordered.length < MAX_POSTS) {
		const tail = state.ordered[state.ordered.length - 1];
		if (tail.id !== target.postId) {
			try {
				// Fetch, merge, validate, and render before committing a continuation.
				state = assemble(await fetchPayload(String(tail.id), "thread", read, signal), state);
			} catch (error) {
				if (!isRecoverablePageFailure(error)) throw error;
				state.warnings.add(`Partial thread: the tail continuation could not be read (${error.kind}); earlier evidence was retained.`);
			}
		}
	}
	if (state.limited) state.warnings.add("Partial thread: the 100-post limit was reached.");
	if (state.ordered.some((post) => parentId(post) && !state.posts.has(parentId(post)!))) state.warnings.add("Partial thread: a parent post is missing.");
	if (state.ordered.length < MAX_POSTS && [...state.posts.values()].some((post) => !state.ordered.includes(post))) state.warnings.add("Partial thread: disconnected posts were omitted because their parents are missing.");
	const title = string(object(focal.article)?.title) ?? `X post by @${string(object(focal.author)?.screen_name) ?? "unknown"}`;
	return { url: target.url, title: clean(title), content: state.content, warnings: [...state.warnings], postCount: state.ordered.length };
}

/** Connected descendants in parent-before-child order, preserving upstream sibling order. */
function conversationReplies(posts: Map<string, ObjectValue>, focalId: string, threadIds: Set<string>): { replies: ObjectValue[]; unverified: number } {
	const connected = new Map<string, boolean>([[focalId, true]]);
	const ordered: ObjectValue[] = [];
	let unverified = 0;
	for (const [postId, post] of posts) {
		if (threadIds.has(postId)) continue;
		const path = new Map<string, ObjectValue>();
		let current: ObjectValue | undefined = post;
		let reachesFocal = false;
		while (current) {
			const key = String(current.id);
			const cached = connected.get(key);
			if (cached !== undefined) { reachesFocal = cached; break; }
			if (path.has(key)) break;
			path.set(key, current);
			const parent = parentId(current);
			current = parent === undefined ? undefined : posts.get(parent);
		}
		for (const [key, value] of [...path].reverse()) {
			connected.set(key, reachesFocal);
			if (reachesFocal && !threadIds.has(key)) ordered.push(value);
		}
		if (!reachesFocal) unverified += 1;
	}
	return { replies: ordered, unverified };
}

function renderConversation(posts: Map<string, ObjectValue>, focal: ObjectValue, maxReplies: number, warnings: Set<string>) {
	const thread = orderedThread(posts, focal);
	const completeThread = orderedThread(posts, focal, MAX_CONVERSATION_POSTS);
	const threadIds = new Set(completeThread.map((post) => String(post.id)));
	const connected = conversationReplies(posts, String(focal.id), threadIds);
	const focalBody = renderPost(focal, warnings);
	// Reserve the selected post before its ancestors, separators, and notices:
	// a large thread must never crowd the actual requested evidence out.
	if (focalBody.length > MAX_CONVERSATION_CHARACTERS - 256) throw new SafeFetchError({ kind: "responseTooLarge", message: "X post exceeds the conversation character limit" });
	let characters = focalBody.length + 256;
	let contentLimited = false;
	const threadBodies = new Map<string, string>([[String(focal.id), focalBody]]);
	const append = (post: ObjectValue, prefix = ""): string | undefined => {
		let body: string;
		try { body = prefix + renderPost(post, warnings); }
		catch (error) {
			if (!(error instanceof SafeFetchError) || error.kind !== "extraction") throw error;
			warnings.add("Partial conversation: an unrenderable post was omitted.");
			return undefined;
		}
		if (characters + body.length + 7 > MAX_CONVERSATION_CHARACTERS) { contentLimited = true; return undefined; }
		characters += body.length + 7;
		return body;
	};
	for (const post of thread) {
		if (post.id === focal.id) continue;
		const body = append(post);
		if (body !== undefined) threadBodies.set(String(post.id), body);
		if (contentLimited) break;
	}
	const replies: string[] = [];
	let replyLimited = false;
	if (!contentLimited) for (const post of connected.replies) {
		if (replies.length === maxReplies) { replyLimited = true; break; }
		const body = append(post, `${link("Reply to", `https://x.com/i/web/status/${parentId(post)}`)}\n\n`);
		if (body !== undefined) replies.push(body);
		if (contentLimited) break;
	}
	const content = thread.flatMap((post) => {
		const body = threadBodies.get(String(post.id));
		return body === undefined ? [] : [body];
	}).join("\n\n---\n\n") + "\n\n# Replies (public conversation; parents before children)\n\n" +
		(replies.length ? replies.join("\n\n---\n\n") : "No replies were included in this bounded output; this does not establish that the post has no comments.");
	return { content, replyCount: replies.length, threadPostCount: threadBodies.size, contentLimited, replyLimited, unverified: connected.unverified, thread, threadLimited: completeThread.length > thread.length };
}

function nextConversationCursor(value: unknown): string | null | undefined {
	if (value === null) return null;
	const cursor = object(value);
	if (cursor?.bottom === null) return null;
	const bottom = cursor?.bottom;
	if (typeof bottom !== "string" || bottom.length === 0 || bottom.length > 2_048 || CONTROLS.test(bottom)) return undefined;
	try { return encodeURIComponent(bottom).length <= 4_096 ? bottom : undefined; }
	catch { return undefined; }
}

export interface XPublicReadOptions {
	readonly maxReplies?: number;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/** Crawl only the public API; never authenticate, control a browser, or retry a failed page. */
export async function readFxTwitter(target: XUrl, read: Reader, options: XPublicReadOptions = {}): Promise<XReadResult> {
	const maxReplies = options.maxReplies ?? MAX_X_REPLIES;
	if (!Number.isInteger(maxReplies) || maxReplies < 0 || maxReplies > MAX_X_REPLIES) throw new SafeFetchError({ kind: "invalidRequest", message: `xReplies must be between 0 and ${MAX_X_REPLIES}` });
	const timeoutMs = options.timeoutMs ?? CONVERSATION_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SafeFetchError({ kind: "invalidRequest", message: "X conversation timeout must be positive" });
	if (!target.postId) throw extraction("Article link requires public /handle/article/POSTID or publishing post URL");
	const parsed = parseXUrl(target.url);
	if (!ID.test(target.postId) || !parsed || parsed.postId !== target.postId || parsed.kind !== target.kind || target.articleId !== undefined) throw extraction("Invalid public X post target");
	if (options.signal?.aborted) throw new SafeFetchError({ kind: "canceled", message: "X read canceled" });
	const validated = { ...parsed, postId: target.postId };
	if (maxReplies === 0) return readAuthorThread(validated, read, options.signal);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
	const abort = (): void => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	const warnings = new Set<string>(["Public conversation coverage is unknown: FxTwitter may omit hidden, deleted, protected, or nested replies even when pagination is exhausted. Pages are ranked by likes; replies are arranged after their parents."]);
	let posts = new Map<string, ObjectValue>();
	const seenCursors = new Set<string>();
	let focal: ObjectValue | undefined;
	let rendered: ReturnType<typeof renderConversation> | undefined;
	let pagesRead = 0;
	let cursor: string | undefined;
	let paginationExhausted = false;
	let stopReason: XConversationMetadata["stopReason"] = "page-limit";
	try {
		for (let attempt = 0; attempt < MAX_X_CONVERSATION_PAGES; attempt++) {
			let payload: ObjectValue;
			try {
				payload = await fetchPayload(target.postId, "conversation", read, controller.signal, cursor);
			} catch (error) {
				if (options.signal?.aborted) throw new SafeFetchError({ kind: "canceled", message: "X read canceled" });
				if (timedOut) {
					if (rendered === undefined) throw new SafeFetchError({ kind: "timeout", message: "X conversation timed out" });
					stopReason = "timeout";
					break;
				}
				if (rendered === undefined || !isRecoverablePageFailure(error)) throw error;
				stopReason = error.kind === "responseTooLarge" ? "byte-limit" : "upstream-error";
				warnings.add(`Partial conversation: a later page failed${error.status === undefined ? "" : ` (HTTP ${error.status})`}; earlier evidence was retained.`);
				break;
			}
			focal ??= payload.status as ObjectValue;
			if (target.kind === "article" && !object(focal.article)) throw extraction("FxTwitter did not provide the full Article body");
			// Admit a page atomically: a later invalid author-thread relationship
			// must not corrupt the graph that backs already validated evidence.
			const staged = new Map(posts);
			if (!staged.has(target.postId)) staged.set(target.postId, focal);
			let candidateLimited = false;
			for (const entry of [...((payload.thread as unknown[] | null | undefined) ?? []), ...((payload.replies as unknown[] | null) ?? [])]) {
				if (!usablePost(entry)) { warnings.add("Partial conversation: one or more supplied posts are unavailable."); continue; }
				const key = String(entry.id);
				if (staged.has(key)) continue;
				if (staged.size === MAX_CONVERSATION_POSTS) { candidateLimited = true; break; }
				staged.set(key, entry);
			}
			try { rendered = renderConversation(staged, focal, maxReplies, warnings); }
			catch (error) {
				if (rendered === undefined || !(error instanceof SafeFetchError) || error.kind !== "extraction") throw error;
				stopReason = "upstream-error";
				warnings.add("Partial conversation: a later page contained invalid thread relationships; earlier evidence was retained.");
				break;
			}
			posts = staged;
			pagesRead += 1;
			const next = nextConversationCursor(payload.cursor);
			paginationExhausted = next === null;
			if (rendered.contentLimited) { stopReason = "content-limit"; break; }
			if (rendered.threadLimited) { stopReason = "thread-limit"; break; }
			if (candidateLimited) { stopReason = "candidate-limit"; break; }
			if (next === undefined) { stopReason = "invalid-cursor"; break; }
			if (rendered.replyLimited || rendered.replyCount === maxReplies && next !== null) { stopReason = "reply-limit"; break; }
			if (next === null) { stopReason = "exhausted"; break; }
			if (seenCursors.has(next)) { stopReason = "cursor-loop"; break; }
			seenCursors.add(next);
			cursor = next;
		}
		if (!focal || !rendered) throw extraction();
		if (options.signal?.aborted) throw new SafeFetchError({ kind: "canceled", message: "X read canceled" });
		if (rendered.unverified > 0) warnings.add("Partial conversation: posts with missing or cyclic parent relationships were omitted.");
		if (rendered.threadLimited) warnings.add("Partial thread: the 100-post author-thread limit was reached.");
		if (rendered.thread.some((post) => parentId(post) && !posts.has(parentId(post)!))) warnings.add("Partial thread: a parent post is missing.");
		if (stopReason !== "exhausted") warnings.add(`Partial conversation: retrieval stopped (${stopReason}); this is not a complete conversation.`);
		const title = string(object(focal.article)?.title) ?? `X post by @${string(object(focal.author)?.screen_name) ?? "unknown"}`;
		return {
			url: parsed.url, title: clean(title), content: rendered.content, warnings: [...warnings], postCount: rendered.threadPostCount,
			conversation: { pagesRead, replyCount: rendered.replyCount, threadPostCount: rendered.threadPostCount, paginationExhausted, stopReason },
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
