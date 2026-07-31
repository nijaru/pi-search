import { describe, expect, it } from "bun:test";
import extension from "./index";

describe("extension registration", () => {
	it("registers exactly the three public tools", () => {
		const names: string[] = [];
		extension({ registerTool(tool: { name: string }) { names.push(tool.name); } } as never);
		expect(names).toEqual(["web_search", "web_fetch", "web_research"]);
	});
});
