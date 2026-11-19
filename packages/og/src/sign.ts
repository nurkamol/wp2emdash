/** Card links carry an HMAC of their parameters, so the public card route renders only cards the site itself issued. */
const enc = new TextEncoder();

export const b64url = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function key(secret: string) {
	return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function sign(secret: string, payload: string): Promise<string> {
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload)));
	return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verify(secret: string, payload: string, sig: string): Promise<boolean> {
	if (!/^[0-9a-f]{32}$/.test(sig)) return false;
	const want = await sign(secret, payload);
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0;
}
