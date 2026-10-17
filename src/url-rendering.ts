import { normalizeSearchUrl } from "./search-cleanup";
import { compactText } from "./render-text";

/** Keep displayed URLs useful without presenting a shortened value as exact. */
export const MAX_DISPLAY_URL_LENGTH = 2_048;
/** Model-facing URLs stay complete up to this bound so the model can fetch them. */
export const MAX_MODEL_URL_LENGTH = 8_192;
const DISPLAY_URL_NOTICE = " [URL shortened]";
const MODEL_URL_NOTICE = " [URL truncated]";

function displayCandidate(value: string): string {
	const normalized = normalizeSearchUrl(value)?.url;
	// Invalid URLs still must not carry terminal controls into the TUI.
	return normalized ?? compactText(value, MAX_MODEL_URL_LENGTH);
}

export function isDisplayUrlShortened(value: string): boolean {
	return displayCandidate(value).length > MAX_DISPLAY_URL_LENGTH;
}

/** Display-only URL: shortened for the footer/transcript, never model content. */
export function renderSafeUrl(value: string, maxLength = MAX_DISPLAY_URL_LENGTH): string {
	const canonical = displayCandidate(value);
	const limit = Math.max(DISPLAY_URL_NOTICE.length + 2, Math.floor(maxLength));
	if (canonical.length <= limit) return canonical;
	const suffix = `…${DISPLAY_URL_NOTICE}`;
	return `${canonical.slice(0, limit - suffix.length)}${suffix}`;
}

/**
 * Model-facing URL: preserve the complete value so the model can fetch what the
 * tool cited. Only an extreme URL is cut, and the notice says so instead of
 * pointing at structured details the model never receives.
 */
export function renderModelUrl(value: string): string {
	const canonical = displayCandidate(value);
	if (canonical.length <= MAX_MODEL_URL_LENGTH) return canonical;
	return `${canonical.slice(0, MAX_MODEL_URL_LENGTH - MODEL_URL_NOTICE.length)}${MODEL_URL_NOTICE}`;
}
