/**
 * Password-protected content on the EmDash target (src/transform/protected.ts for the decisions). The entry is
 * published with:
 *
 * - `access_password`: the password's salted PBKDF2 hash (or, once the owner types a new one in the admin, the text
 *   they typed — the starter's password page accepts both; WordPress also kept post passwords readable to editors);
 * - posts only: the body in `access_body` and an empty `body` and excerpt — EmDash's search index reads the searchable
 *   fields of every published entry (posts: title, excerpt, body), so the protected text must not sit in them; the
 *   starter shows `access_body` once the password is given. Pages keep their sections (`content` is not searchable).
 * - SEO: noindex (EmDash's sitemap leaves noindex entries out — api/handlers/seo.ts, verified in 1.5) and no
 *   description (it would show in search results and link previews).
 *
 * The starter answers such an entry with the password page (no-store, noindex) until the visitor gives the password;
 * a signed cookie per entry then lets them in for 10 days, as WordPress's postpass cookie did.
 */
import type { IrPage } from "../../ir/schema.js";

export const ACCESS_FIELD = { slug: "access_password", label: "Access password (visitors must type it to see this page; leave empty to make the page public)", type: "string" };
export const ACCESS_BODY_FIELD = { slug: "access_body", label: "Protected content (shown after the access password)", type: "portableText" };

/** The fields a protected entry gets on the target. */
export function protectedData(data: Record<string, unknown>, o: { hash: string; post: boolean }): Record<string, unknown> {
	const out: Record<string, unknown> = { [ACCESS_FIELD.slug]: o.hash };
	if (o.post) {
		out[ACCESS_BODY_FIELD.slug] = Array.isArray(data.body) ? data.body : [];
		out.body = [];
		out.excerpt = "";
	}
	return out;
}

/** A page's status on the target: published, or a draft (not published on WordPress, or decided draft). */
export function pageAction(doc: IrPage): "publish" | "draft" {
	if (doc.access) return doc.access.as === "draft" ? "draft" : "publish";
	return doc.source.status === "publish" ? "publish" : "draft";
}
