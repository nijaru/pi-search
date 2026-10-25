import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeFetchError } from "./fetch-errors";

/** Native discovery only. Never scans ports, launches a browser, or reads profile secrets. */
export async function browserEndpoint(directory: string): Promise<string> {
	let text: string;
	try { text = await readFile(join(directory, "DevToolsActivePort"), "utf8"); }
	catch { throw new SafeFetchError({ kind: "extraction", message: "No browser connection. Enable remote debugging in your running browser's inspect page, then run /search-x connect" }); }
	const [port, path, ...rest] = text.trim().split(/\r?\n/);
	if (text.length > 1024 || rest.length || !/^\d{1,5}$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path ?? "")) {
		throw new SafeFetchError({ kind: "extraction", message: "Invalid browser connection metadata" });
	}
	return `ws://127.0.0.1:${Number(port)}${path}`;
}

type EventHandler = (params: any, sessionId?: string) => void;
interface CommandOptions<T> { timeoutMs?: number; onLateResult?: (value: T) => void }
interface Pending { method: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; expired?: boolean; onLateResult?: (value: any) => void }

/** Target-scoped CDP: unlike general browser drivers, never auto-attaches to existing tabs. */
export class XBrowserConnection {
	private nextId = 0;
	private pending = new Map<number, Pending>();
	private handlers = new Map<string, Set<EventHandler>>();
	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data.length > 8_000_000) { this.close(); return; }
			let message: any;
			try { message = JSON.parse(event.data); } catch { this.close(); return; }
			if (!message || typeof message !== "object") { this.close(); return; }
			const pending = this.pending.get(message.id);
			if (pending) {
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				// Protocol errors can contain session details. Never echo raw messages or endpoints.
				if (message.error) pending.reject(new Error(`Browser command ${pending.method} failed`));
				else if (pending.expired) pending.onLateResult?.(message.result);
				else pending.resolve(message.result);
			} else if (typeof message.method === "string") {
				for (const handler of this.handlers.get(message.method) ?? []) handler(message.params, message.sessionId);
			}
		});
		socket.addEventListener("close", () => this.rejectPending());
		socket.addEventListener("error", () => this.rejectPending());
	}
	static async open(endpoint: string, signal: AbortSignal): Promise<XBrowserConnection> {
		if (signal.aborted) throw new SafeFetchError({ kind: "canceled", message: "Browser connection canceled" });
		const socket = new WebSocket(endpoint);
		const connection = new XBrowserConnection(socket);
		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				socket.removeEventListener("open", opened);
				socket.removeEventListener("error", failed);
				socket.removeEventListener("close", failed);
				signal.removeEventListener("abort", abort);
			};
			const opened = (): void => { cleanup(); resolve(); };
			const failed = (): void => { cleanup(); connection.close(); reject(new SafeFetchError({ kind: "extraction", message: "Browser connection refused or denied. Enable remote debugging and approve the browser's connection prompt" })); };
			const abort = (): void => { cleanup(); connection.close(); reject(new SafeFetchError({ kind: "canceled", message: "Browser connection canceled" })); };
			socket.addEventListener("open", opened, { once: true });
			socket.addEventListener("error", failed, { once: true });
			socket.addEventListener("close", failed, { once: true });
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		return connection;
	}
	get connected(): boolean { return this.socket.readyState === WebSocket.OPEN; }
	send<T = Record<string, never>>(method: string, params: object = {}, sessionId?: string, options: CommandOptions<T> = {}): Promise<T> {
		if (!this.connected) return Promise.reject(new Error("Browser disconnected"));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				// Resource creation may complete after a timeout. Retain only its cleanup callback.
				if (pending?.onLateResult) pending.expired = true;
				else this.pending.delete(id);
				reject(new Error(`Browser command ${method} timed out`));
			}, options.timeoutMs ?? 10_000);
			this.pending.set(id, { method, resolve, reject, timer, onLateResult: options.onLateResult });
			try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
			catch { this.pending.delete(id); clearTimeout(timer); reject(new Error("Browser disconnected")); }
		});
	}
	on(method: string, handler: EventHandler): () => void {
		let handlers = this.handlers.get(method);
		if (!handlers) { handlers = new Set(); this.handlers.set(method, handlers); }
		handlers.add(handler);
		return () => { handlers.delete(handler); if (!handlers.size) this.handlers.delete(method); };
	}
	private rejectPending(): void {
		for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error("Browser disconnected")); }
		this.pending.clear();
	}
	close(): void {
		// Closing the transport is NOT Browser.close or Target.closeTarget on a user tab.
		this.socket.close();
		this.rejectPending();
	}
}
