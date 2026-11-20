/**
 * @wp2emdash/comments — the WordPress comments import route for EmDash (experimental, 0.x).
 *
 * EmDash 1.5 has no API that creates a comment with its original date, author and thread (the public route stamps
 * "now" and runs the anti-spam checks; the admin routes only moderate). This plugin adds one private route,
 * `POST /_emdash/api/plugins/wp2emdash-comments/import`, used by the kit's load phase. It only ever writes **pending**
 * comments; the kit then approves the ones that were approved in WordPress through EmDash's own bulk moderation route,
 * which also purges the cached pages. See README.md and docs/spikes/comments-findings.md.
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side module
 * is `@wp2emdash/comments/plugin`.
 */
import { COMMENTS_PLUGIN } from "./meta.js";

export { COMMENTS_PLUGIN };

/** The EmDash plugin descriptor for `emdash({ plugins: [commentsPlugin()] })`. No admin page: comments are moderated in EmDash's own Comments screen. */
export function commentsPlugin() {
	return { ...COMMENTS_PLUGIN, format: "native" as const, displayName: "WordPress comments import", description: "Import route for comments migrated from WordPress (admins and admin API tokens only)", entrypoint: "@wp2emdash/comments/plugin", options: {} };
}
