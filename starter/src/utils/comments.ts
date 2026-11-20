/**
 * Comments (site.config.json `comments`, written by scaffold only for sites whose WordPress had comments): which
 * collections show comments and which take new ones. Pure helpers, testable in Node (the site's config is read in
 * utils/comments-data.ts); the component is
 * components/comments/Comments.astro, the browser side scripts/comments.ts.
 *
 * EmDash stores and moderates the comments (`_emdash_comments`); the list comes from EmDash's `getComments` (approved
 * only, cached, invalidated on every comment change) and new comments go to EmDash's public endpoint
 * `POST /_emdash/api/comments/<collection>/<id>` (Turnstile when a secret is set, honeypot, 5 per 10 minutes per
 * visitor, moderation by the collection's setting). The page itself stays in the route cache: approving a comment
 * purges the entry's cache tags.
 */
export interface CommentsConfig {
	/** closedAfterDays: EmDash refuses new comments that many days after publishing (WordPress "close comments on old posts"). */
	collections: Record<string, { form: boolean; closedAfterDays?: number }>;
}

/** Show comments on entries of this collection (migrated comments, or a form). */
export function showsComments(cfg: CommentsConfig | undefined, collection: string): boolean {
	return !!cfg?.collections[collection];
}

/**
 * The form for new comments: the collection takes them, the entry is not closed ("Comments closed") and not older than
 * the collection's closing age (EmDash would refuse the comment).
 */
export function formOpen(cfg: CommentsConfig | undefined, collection: string, closed: unknown, publishedAt?: Date | string | null, now = Date.now()): boolean {
	const c = cfg?.collections[collection];
	if (!c?.form || closed === true || closed === 1) return false;
	const at = publishedAt ? new Date(publishedAt).getTime() : Number.NaN;
	return !(c.closedAfterDays && Number.isFinite(at) && now > at + c.closedAfterDays * 86_400_000);
}

export function commentsHeading(n: number): string {
	return n === 0 ? "Comments" : n === 1 ? "1 comment" : `${n} comments`;
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

/** A comment body as parts: text and links (EmDash stores plain text; URLs become nofollow links, as in EmDash's own list). */
export function bodyParts(text: string): { paragraphs: { text?: string; href?: string; br?: true }[][] } {
	const paragraphs = text
		.replace(/\r\n?/g, "\n")
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			const out: { text?: string; href?: string; br?: true }[] = [];
			p.split("\n").forEach((line, i) => {
				if (i) out.push({ br: true });
				for (const [j, piece] of line.split(URL_RE).entries()) {
					if (!piece) continue;
					if (j % 2 === 0) {
						out.push({ text: piece });
						continue;
					}
					// A sentence's full stop after a URL is not part of it.
					const href = piece.replace(/[.,;:!?]+$/, "");
					out.push({ text: href, href });
					if (href !== piece) out.push({ text: piece.slice(href.length) });
				}
			});
			return out;
		});
	return { paragraphs };
}

/** The public endpoint for an entry's comments. */
export const commentsEndpoint = (collection: string, contentId: string) => `/_emdash/api/comments/${encodeURIComponent(collection)}/${encodeURIComponent(contentId)}`;

/** `POST /_emdash/api/comments/<collection>/<id>` → the collection and entry id, for the middleware's closed check. */
export function commentPostTarget(pathname: string, cfg: CommentsConfig | undefined): { collection: string; id: string } | undefined {
	const m = /^\/_emdash\/api\/comments\/([a-z][a-z0-9_]*)\/([^/]+)\/?$/.exec(pathname);
	if (!m || !cfg?.collections[m[1] as string]?.form) return undefined;
	try {
		return { collection: m[1] as string, id: decodeURIComponent(m[2] as string) };
	} catch {
		return undefined;
	}
}

/** The JSON body EmDash's createCommentBody accepts, from the form's fields (never anything else). */
export function commentPayload(fields: Record<string, string>, turnstileToken?: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of ["authorName", "authorEmail", "body", "parentId", "website_url"]) {
		const v = fields[k];
		if (typeof v === "string" && v !== "") out[k] = k === "body" ? v : v.trim();
	}
	if (turnstileToken) out.turnstileToken = turnstileToken;
	return out;
}

/** What the visitor reads after posting (EmDash answers `{ data: { status } }` or `{ error: { code, message } }`). */
export function submitMessage(ok: boolean, payload: { data?: { status?: string }; error?: { code?: string } } | undefined): string {
	if (ok) return payload?.data?.status === "approved" ? "Thank you — your comment is published. Reload the page to see it." : "Thank you — your comment will appear once it is approved.";
	switch (payload?.error?.code) {
		case "RATE_LIMITED":
			return "Too many comments in a short time. Please try again in a few minutes.";
		case "TURNSTILE_FAILED":
			return "The spam check did not pass. Please try again.";
		case "COMMENTS_CLOSED":
		case "COMMENTS_DISABLED":
			return "Comments are closed here.";
		case "VALIDATION_ERROR":
			return "Please check your name, e-mail address and comment.";
		default:
			return "Your comment could not be sent. Please try again later.";
	}
}
