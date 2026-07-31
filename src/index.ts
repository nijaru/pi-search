import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExaProvider } from "./exa";
import { registerWebSearch } from "./search-tool";

/** Register the first provider-neutral vertical slice. */
export default function (pi: ExtensionAPI): void {
	const exa = createExaProvider({ apiKey: process.env.EXA_API_KEY });
	registerWebSearch(pi, exa);
}
