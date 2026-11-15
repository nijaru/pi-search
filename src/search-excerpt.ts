import type { SearchExcerpt, SearchExcerptKind } from "./contracts";

export function searchExcerptLabel(kind: SearchExcerptKind): string {
	switch (kind) {
		case "provider-excerpt": return "Provider excerpt (not page-verified)";
		case "provider-summary": return "Provider summary";
		case "provider-text": return "Provider text (origin unspecified)";
	}
}

/** Build an optional excerpt without losing the text/provenance pairing. */
export function searchExcerpt(excerpt: string | undefined, excerptKind: SearchExcerptKind): SearchExcerpt {
	return excerpt === undefined ? {} : { excerpt, excerptKind };
}

/** Project/bound only excerpt fields, preserving their provenance as one unit. */
export function copySearchExcerpt(value: SearchExcerpt, maxLength?: number): SearchExcerpt {
	return value.excerpt === undefined ? {} : { excerpt: value.excerpt.slice(0, maxLength), excerptKind: value.excerptKind };
}
