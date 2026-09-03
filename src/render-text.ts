/**
 * Shared whitespace-compaction for model-visible tool output. Bounded text is
 * the trust fence for untrusted provider content; every renderer uses this so
 * bounds stay consistent across tools.
 */
export function compactText(value: string, maxLength: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
