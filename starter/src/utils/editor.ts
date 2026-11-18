import type { AstroCookies } from "astro";

/** A signed-in editor (or an edit/preview link): gets EmDash's inline toolbar, and is never counted by analytics. */
export function isEditor(cookies: AstroCookies, url: URL): boolean {
	return !!cookies.get("astro-session") || cookies.get("emdash-edit-mode")?.value === "true" || url.searchParams.has("_edit") || url.searchParams.has("_preview");
}
