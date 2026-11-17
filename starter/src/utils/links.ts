/** Allow site paths, anchors, http(s), mailto and tel. Anything else (javascript:, data:) is dropped. */
export function safeHref(href: string | null | undefined): string | undefined {
	if (!href) return undefined;
	const h = href.trim();
	if (/^(https?:\/\/|mailto:|tel:|#|\/(?!\/))/i.test(h)) return h;
	return undefined;
}

export const isExternal = (href: string) => /^https?:\/\//i.test(href);
