/** Fixed DOM reader shared by local HTML extraction and the opt-in browser. */
export function extractXDom(document, target, maxCharacters = 1_000_000) {
	const clean = (element) => {
		const clone = element.cloneNode(true);
		clone.querySelectorAll("script,style,iframe,object,embed,form,button,video,audio").forEach((el) => el.remove());
		// X's rich-text headings contain layout divs; preserve inline markup without
		// turning a heading into an empty Markdown heading followed by a paragraph.
		for (const block of clone.querySelectorAll('h1 div,h1 p,h2 div,h2 p,h3 div,h3 p,h4 div,h4 p,h5 div,h5 p,h6 div,h6 p')) block.replaceWith(...block.childNodes);
		for (const el of [clone, ...clone.querySelectorAll("*")]) {
			for (const attr of [...el.attributes]) {
				if (!['href', 'src', 'alt', 'title', 'class'].includes(attr.name)) el.removeAttribute(attr.name);
			}
			for (const attr of ['href', 'src']) {
				const value = el.getAttribute(attr);
				if (!value) continue;
				try {
					const url = new URL(value, target.url);
					if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) el.removeAttribute(attr);
					else el.setAttribute(attr, url.href);
				} catch { el.removeAttribute(attr); }
			}
		}
		return clone.outerHTML;
	};
	const bodies = document.querySelectorAll('.x-article-body, [data-testid="twitterArticleRichTextView"]');
	if (/\/article\//.test(new URL(target.url).pathname) && bodies.length === 1 && bodies[0].textContent.trim()) {
		const html = clean(bodies[0]);
		if (html.length > maxCharacters) throw new Error('X article exceeds the extraction limit');
		return { html, title: ((document.querySelector('[data-testid="twitter-article-title"]') || document.querySelector('h1'))?.textContent?.trim() || document.title || 'X Article').slice(0, 512), postCount: 1 };
	}
	if (!target.postId) return null;
	const posts = [];
	const collapsedPostIds = [];
	let author;
	let found = false;
	for (const element of document.querySelectorAll('article[data-testid="tweet"]')) {
		const stamp = element.querySelector('time');
		const href = stamp?.closest('a')?.getAttribute('href');
		if (!href) continue;
		const permalink = new URL(href, target.url);
		if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(permalink.hostname) || permalink.username || permalink.password || permalink.port) continue;
		const match = permalink.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{2,20})(?:\/|$)/);
		if (!match) continue;
		if (!found) {
			if (match[2] !== target.postId) continue;
			found = true;
			author = match[1].toLowerCase();
		} else if (match[1].toLowerCase() !== author) break;
		const text = element.querySelector('[data-testid="tweetText"]');
		const photos = element.querySelectorAll('[data-testid="tweetPhoto"] img');
		const video = element.querySelector('video, [data-testid="videoPlayer"]');
		if (!text?.textContent?.trim() && !photos.length && !video) {
			if (!posts.length) return null;
			break;
		}
		if (element.querySelector('[data-testid="tweet-text-show-more-link"]')) collapsedPostIds.push(match[2]);
		const url = `https://x.com/${match[1]}/status/${match[2]}`;
		const part = document.createElement('section');
		const source = document.createElement('a');
		source.setAttribute('href', url);
		source.textContent = `@${match[1]} · ${stamp.getAttribute('datetime') || match[2]}`;
		part.appendChild(source);
		if (text) part.appendChild(text.cloneNode(true));
		for (const photo of photos) part.appendChild(photo.cloneNode(true));
		if (video) {
			const notice = document.createElement('p');
			notice.textContent = 'Video attached; media was not downloaded or transcribed.';
			part.appendChild(notice);
		}
		posts.push(clean(part));
		if (posts.length >= 100) break;
	}
	if (!posts.length) return null;
	const html = posts.join('\n<hr>\n');
	if (html.length > maxCharacters) throw new Error('X thread exceeds the extraction limit');
	return { html, title: `@${author} on X`, postCount: posts.length, ...(collapsedPostIds.length ? { collapsedPostIds } : {}) };
}
