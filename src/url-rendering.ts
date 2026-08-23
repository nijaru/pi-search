import { normalizeSearchUrl } from "./search-cleanup";

/** Keep displayed URLs useful without presenting a shortened value as exact. */
export const MAX_DISPLAY_URL_LENGTH = 2_048;
const DISPLAY_URL_NOTICE = " [URL shortened; full URL is in structured details]";

export function isDisplayUrlShortened(value: string): boolean {
	const canonical = normalizeSearchUrl(value)?.url ?? value.trim();
	return canonical.length > MAX_DISPLAY_URL_LENGTH;
}

export function renderSafeUrl(value: string, maxLength = MAX_DISPLAY_URL_LENGTH): string {
	const canonical = normalizeSearchUrl(value)?.url ?? value.replace(/\s+/g, " ").trim();
	const limit = Math.max(DISPLAY_URL_NOTICE.length + 2, Math.floor(maxLength));
	if (canonical.length <= limit) return canonical;
	const suffix = `…${DISPLAY_URL_NOTICE}`;
	return `${canonical.slice(0, limit - suffix.length)}${suffix}`;
}
