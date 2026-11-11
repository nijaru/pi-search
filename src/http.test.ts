import { describe, expect, it } from "bun:test";
import { ResponseBodyTooLargeError, readBoundedResponseText } from "./http";

describe("bounded response reader", () => {
	it("cancels a body rejected by Content-Length before reading it", async () => {
		const response = new Response("0123456789", { headers: { "content-length": "10" } });
		await expect(readBoundedResponseText(response, 5)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
		expect(response.bodyUsed).toBe(true);
	});

	it("cancels a pending read when the caller aborts", async () => {
		let canceled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				canceled = true;
			},
		});
		const response = new Response(stream);
		const controller = new AbortController();
		const pending = readBoundedResponseText(response, 100, controller.signal);
		await Bun.sleep(0);
		controller.abort();
		await expect(pending).rejects.toBeDefined();
		expect(canceled).toBe(true);
	});

	it("preserves the abort failure when body cancellation rejects", async () => {
		let reading!: () => void;
		const started = new Promise<void>((resolve) => { reading = resolve; });
		const stream = new ReadableStream<Uint8Array>({
			pull() { reading(); },
			cancel() { throw new Error("body teardown failed"); },
		}, { highWaterMark: 0 });
		const controller = new AbortController();
		const pending = readBoundedResponseText(new Response(stream), 100, controller.signal);
		await started;
		const reason = new DOMException("caller canceled", "AbortError");
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		// Allow rejected teardown promises to reach the host's unhandled-rejection check.
		await Bun.sleep(0);
		expect(stream.locked).toBe(false);
	});

	it("enforces a streamed byte limit without Content-Length", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("0123456789"));
				controller.close();
			},
		});
		await expect(readBoundedResponseText(new Response(stream), 5)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
	});
});
