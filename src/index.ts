import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExaProvider } from "./exa";
import { registerWebFetch } from "./fetch-tool";
import { registerWebSearch } from "./search-tool";

/** Register the provider-neutral search and direct fetch tools. */
export default function (pi: ExtensionAPI): void {
	const exa = createExaProvider({ apiKey: process.env.EXA_API_KEY });
	registerWebSearch(pi, exa);
	registerWebFetch(pi);
}
