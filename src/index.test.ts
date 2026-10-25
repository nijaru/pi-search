import { describe, expect, it } from "bun:test";
import extension from "./index";

describe("extension registration", () => {
	it("registers exactly the three public tools", () => {
		const names: string[] = [];
		const commands: string[] = [];
		extension({
			on() {},
			registerCommand(name: string) { commands.push(name); },
			registerTool(tool: { name: string }) { names.push(tool.name); },
		} as never);
		expect(names).toEqual(["web_search", "web_fetch", "web_research"]);
		expect(commands).toEqual(["search-x"]);
	});

	it("exposes Cloudflare only with credentials and an explicit valid upstream", () => {
		const keys = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "PI_SEARCH_CLOUDFLARE_PROVIDER"] as const;
		const previous = keys.map((key) => process.env[key]);
		try {
			process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
			process.env.CLOUDFLARE_API_TOKEN = "test-token";
			for (const upstream of ["", "invalid", "exa"]) {
				process.env.PI_SEARCH_CLOUDFLARE_PROVIDER = upstream;
				const enums: string[][] = [];
				extension({ on() {}, registerCommand() {}, registerTool(tool: { name: string; parameters: { properties: { provider?: { enum: string[] } } } }) {
					if (tool.name !== "web_fetch") enums.push(tool.parameters.properties.provider!.enum);
				} } as never);
				expect(enums).toHaveLength(2);
				for (const values of enums) expect(values.includes("cloudflare")).toBe(upstream === "exa");
			}
		} finally {
			keys.forEach((key, index) => {
				if (previous[index] === undefined) delete process.env[key];
				else process.env[key] = previous[index];
			});
		}
	});

	it("exposes DeepSeek only when its key is present", () => {
		const previous = process.env.DEEPSEEK_API_KEY;
		try {
			for (const value of [undefined, "   ", "test-key"] as const) {
				if (value === undefined) delete process.env.DEEPSEEK_API_KEY;
				else process.env.DEEPSEEK_API_KEY = value;
				const enums: string[][] = [];
				extension({ on() {}, registerCommand() {}, registerTool(tool: { name: string; parameters: { properties: { provider?: { enum: string[] } } } }) {
					if (tool.name !== "web_fetch") enums.push(tool.parameters.properties.provider!.enum);
				} } as never);
				expect(enums).toHaveLength(2);
				for (const values of enums) expect(values.includes("deepseek")).toBe(value === "test-key");
			}
		} finally {
			if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = previous;
		}
	});
});
