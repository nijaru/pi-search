import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExaProvider } from "./exa";
import { registerWebFetch } from "./fetch-tool";
import { createOpenAIProvider } from "./openai";
import { registerWebSearch } from "./search-tool";

/**
 * Select native OpenAI/Codex web search for the active Pi model. This is a
 * strict choice: an OpenAI auth or service failure is reported to the caller,
 * not silently retried through paid Exa capacity.
 */
export default function (pi: ExtensionAPI): void {
	const exa = createExaProvider({ apiKey: process.env.EXA_API_KEY });
	const openai = createOpenAIProvider({ provider: "openai" });
	const codex = createOpenAIProvider({ provider: "openai-codex" });
	registerWebSearch(pi, (context) => {
		if (context.model?.provider === "openai-codex") return codex;
		if (context.model?.provider === "openai") return openai;
		return exa;
	});
	registerWebFetch(pi);
}
