import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * Remove terminal control sequences and non-whitespace control characters from
 * untrusted provider/page text. Pi's `Text` component preserves ANSI/OSC by
 * design, so renderers must sanitize everything remote before it reaches the
 * TUI. Newlines and tabs are preserved for block content.
 */
export function stripControlText(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/**
 * Shared whitespace-compaction for model-visible tool output. Bounded text is
 * the trust fence for untrusted provider content; every renderer uses this so
 * bounds stay consistent across tools.
 */
export function compactText(value: string, maxLength: number): string {
	return stripControlText(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Sanitize preserved line structure for untrusted block content. */
export function sanitizeBlock(value: string, maxLength: number): string {
	return stripControlText(value).slice(0, maxLength);
}
