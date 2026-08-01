import { describe, expect, it } from "bun:test";
import http from "node:http";
import { directTransport } from "./direct-transport";

async function listen(server: http.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server did not expose a port");
	return address.port;
}

describe("pinned direct transport", () => {
	it("pins the request and prefers Markdown or bounded text responses", async () => {
		let accept = "";
		const server = http.createServer((request, response) => {
			accept = request.headers.accept ?? "";
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("transport ok");
		});
		const port = await listen(server);
		try {
			const result = await directTransport(
			{
				url: new URL(`http://example.test:${port}/path`),
				address: "127.0.0.1",
				family: 4,
			},
			{ signal: new AbortController().signal },
			);
			const chunks: Uint8Array[] = [];
			if (result.body) for await (const chunk of result.body) chunks.push(chunk);
			expect(result.status).toBe(200);
			expect(accept).toContain("text/markdown");
			expect(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))).toBe("transport ok");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});
