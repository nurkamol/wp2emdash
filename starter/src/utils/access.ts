/**
 * Password-protected pages and posts (migrated from WordPress's post passwords; wp2emdash src/transform/protected.ts).
 * An entry with an `access_password` is shown only after the visitor types the password on the password page
 * (components/AccessGate.astro → POST /api/access). The stored value is a salted PBKDF2-SHA256 hash
 * (`pbkdf2-sha256$<iterations>$<salt>$<hash>`, base64url) — or, after the owner typed a new password in the admin, that
 * text (compared in constant time).
 *
 * Unlocked: a cookie per entry, `wp2e_access_<entry id>` = `<expiry>.<HMAC-SHA256(key, entry id + expiry)>`, where the key
 * is the Worker secret ACCESS_SECRET (when set) plus the stored value: changing the password ends every unlock. HttpOnly,
 * Secure, SameSite=Lax, 10 days (WordPress's postpass cookie lasted 10 days). Protected responses are never cached
 * (Cache-Control: private, no-store) and never indexed (noindex).
 */
const enc = new TextEncoder();
const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const ACCESS_DAYS = 10;
export const accessCookie = (entryId: string) => `wp2e_access_${entryId.replace(/[^\w-]/g, "")}`;

/** Constant-time comparison of two strings of the same length (different lengths: false). */
function same(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

/** Does `input` match the stored value (hash or plain text)? */
export async function checkPassword(stored: string, input: string): Promise<boolean> {
	if (!stored || !input || input.length > 200) return false;
	const m = /^pbkdf2-sha256\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
	if (!m) return same(stored, input);
	const iterations = Math.min(Number(m[1]), 100_000);
	const key = await crypto.subtle.importKey("raw", enc.encode(input), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64urlBytes(m[2] as string), iterations }, key, 256);
	const got = btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return same(got, m[3] as string);
}

async function mac(secret: string, stored: string, entryId: string, exp: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(`${secret}\u0000${stored}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${entryId}\n${exp}`)));
}

/** The unlock cookie's value for an entry. */
export async function unlockValue(secret: string, stored: string, entryId: string, now = Date.now()): Promise<string> {
	const exp = Math.floor(now / 1000) + ACCESS_DAYS * 86_400;
	return `${exp}.${await mac(secret, stored, entryId, exp)}`;
}

/** Is this cookie value a valid, unexpired unlock of the entry with this stored password? */
export async function isUnlocked(secret: string, stored: string, entryId: string, cookie: string | undefined, now = Date.now()): Promise<boolean> {
	const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(cookie ?? "");
	if (!m || Number(m[1]) * 1000 < now) return false;
	return same(m[2] as string, await mac(secret, stored, entryId, Number(m[1])));
}

/** Where to go back to after the form: a path on this site only. */
export const safeBack = (v: unknown) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v.slice(0, 500) : "/");

/** Headers of every response for a protected entry (password page or content). */
export const PROTECTED_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } as const;
