/**
 * Password-protected and private WordPress content. EmDash 1.5 has no such statuses (`draft | published | archived`;
 * its own WordPress importers turn protected posts into drafts — astro/routes/api/import/wordpress/execute.ts), so the
 * kit carries them by decision (overrides.ts `protectedContent`, defaults below):
 *
 * - password-protected → "protect" (default): published, behind the starter's password page (an `access_password`
 *   field on the entry holding a salted PBKDF2 hash of the WordPress password; noindex, out of the sitemap and the route
 *   cache, never stored by a browser or CDN); or "draft" | "skip" | "publish" (the password is dropped).
 * - private → "draft" (default): editors see it in the admin, visitors get a 404 (as on WordPress); or "skip" | "publish".
 *
 * The WordPress password is read by extract (REST, `context=edit`, needs the application password of an editor) and
 * hashed at once: raw/protected.json holds hashes only, never the password. A page whose password could not be read
 * (no REST access) takes the site's fallback password from sites/<slug>/.env (WP2EMDASH_PROTECTED_PASSWORD, hashed at
 * load) or the transform gate stays red. The owner can change a password later in the admin (Access password field).
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";

export const PROTECTED_FILE = "protected.json";
export const PBKDF2_ITERATIONS = 100_000; // the most Workers' WebCrypto accepts for PBKDF2
const b64url = (b: Buffer) => b.toString("base64url");

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>` (base64url): the starter's utils/access.ts verifies it with WebCrypto. */
export function hashPassword(plain: string, iterations = PBKDF2_ITERATIONS, salt = randomBytes(16)): string {
	return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(pbkdf2Sync(plain, salt, iterations, 32, "sha256"))}`;
}
export function checkHash(plain: string, stored: string): boolean {
	const m = /^pbkdf2-sha256\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
	if (!m) return false;
	return pbkdf2Sync(plain, Buffer.from(m[2] as string, "base64url"), Number(m[1]), 32, "sha256").toString("base64url") === m[3];
}

/** What extract writes: one entry per protected post/page, the password as a hash (or unknown). */
export interface ProtectedEntry {
	type: string;
	id: number;
	/** Hash of the WordPress password; absent when it could not be read. */
	hash?: string;
}

export type ProtectedKind = "password" | "private";
export type ProtectDecision = "protect" | "draft" | "skip" | "publish";

export interface ProtectedDecisions {
	password?: { as: ProtectDecision; reason: string };
	private?: { as: Exclude<ProtectDecision, "protect">; reason: string };
}

/** The decision for one protected item: the owner's, else the default (password → protect, private → draft). */
export function decide(kind: ProtectedKind, d: ProtectedDecisions | undefined, legacyPosts?: { as: "draft" | "skip" | "publish" }): ProtectDecision {
	if (legacyPosts) return legacyPosts.as;
	if (kind === "password") return d?.password?.as ?? "protect";
	return d?.private?.as ?? "draft";
}

/** WordPress's own password form in a saved page (the audit snapshot): the page was protected when audited. */
export const isPasswordFormHtml = (html: string) => /class="[^"]*\bpost-password-form\b|action="[^"]*wp-login\.php\?action=postpass/.test(html);
