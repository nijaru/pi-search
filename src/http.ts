/** Maximum response bytes are enforced while reading, not from Content-Length alone. */
export class ResponseBodyTooLargeError extends Error {
	readonly bytesRead: number;
	readonly maxBytes: number;

	constructor(bytesRead: number, maxBytes: number) {
		super(`Response body exceeded ${maxBytes} bytes`);
		this.name = "ResponseBodyTooLargeError";
		this.bytesRead = bytesRead;
		this.maxBytes = maxBytes;
	}
}

/** Release an unused response body before returning a provider error. */
export async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Preserve the provider status/error; body teardown is best effort.
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

/** Read a response body with cancellation and a hard byte bound. */
export async function readBoundedResponseText(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<string> {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) {
		throw new RangeError("maxBytes must be a positive integer");
	}
	if (signal?.aborted) throw abortError(signal);
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const parsedLength = Number(contentLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			await cancelResponseBody(response);
			throw new ResponseBodyTooLargeError(parsedLength, maxBytes);
		}
	}
	if (response.body === null) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	const onAbort = () => {
		void reader.cancel(signal?.reason);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const chunks: string[] = [];
		while (true) {
			if (signal?.aborted) throw abortError(signal);
			const { done, value } = await reader.read();
			if (signal?.aborted) throw abortError(signal);
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) {
				throw new ResponseBodyTooLargeError(bytesRead, maxBytes);
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {
			// The body is already being torn down. Preserve the original failure.
		}
		reader.releaseLock();
	}
}
