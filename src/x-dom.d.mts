export interface XDomDocument {
	readonly html: string;
	readonly title: string;
	readonly postCount: number;
	readonly collapsedPostIds?: readonly string[];
}
export function extractXDom(document: unknown, target: { readonly url: string; readonly postId?: string }, maxCharacters?: number): XDomDocument | null;
