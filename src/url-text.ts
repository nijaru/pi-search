/**
 * Trim prose punctuation from a URL extracted out of answer text without
 * dropping characters that belong to the URL. Parentheses are kept when they
 * are balanced, so `.../K2_(mountain)` survives a trailing sentence period.
 */
export function trimUrlPunctuation(value: string): string {
	let candidate = value.replace(/[.,;:!?'"`]+$/g, "");
	while (candidate.length > 0) {
		if (candidate.endsWith(")")) {
			const opens = candidate.split("(").length - 1;
			const closes = candidate.split(")").length - 1;
			if (closes > opens) {
				candidate = candidate.slice(0, -1).replace(/[.,;:!?'"`]+$/g, "");
				continue;
			}
			break;
		}
		if (candidate.endsWith("]") || candidate.endsWith("}") || candidate.endsWith(">")) {
			candidate = candidate.slice(0, -1).replace(/[.,;:!?'"`]+$/g, "");
			continue;
		}
		break;
	}
	return candidate;
}
