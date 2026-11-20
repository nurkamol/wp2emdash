/**
 * POST /api/access — the password page's form (components/AccessGate.astro): checks the password of a protected page or
 * post (utils/access.ts), sets the unlock cookie for that entry and goes back to it. Rate limited per visitor and entry
 * (PROTECT_LIMITER, else the forms' FORM_LIMITER binding). Never cached; the password is never logged.
 */
import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";
import { ACCESS_DAYS, accessCookie, checkPassword, safeBack, unlockValue } from "../../utils/access";

export const prerender = false;

interface Env {
	ACCESS_SECRET?: string;
	PROTECT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
	FORM_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	const e = env as unknown as Env;
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return redirect("/", 303);
	}
	const back = safeBack(form.get("back"));
	const to = (state: string) => `${back}${back.includes("?") ? "&" : "?"}access=${state}`;
	const collection = String(form.get("collection") ?? "");
	const slug = String(form.get("slug") ?? "");
	if (!["pages", "posts"].includes(collection) || !slug) return redirect(to("error"), 303);
	const limiter = e.PROTECT_LIMITER ?? e.FORM_LIMITER;
	if (limiter) {
		const { success } = await limiter.limit({ key: `access:${collection}:${slug}:${request.headers.get("cf-connecting-ip") ?? "unknown"}` });
		if (!success) return redirect(to("limited"), 303);
	}
	const { entry } = await getEmDashEntry(collection, slug);
	const data = (entry?.data ?? {}) as { id?: string; access_password?: unknown };
	const stored = typeof data.access_password === "string" ? data.access_password.trim() : "";
	if (!entry || !stored || !data.id) return redirect(back, 303);
	if (!(await checkPassword(stored, String(form.get("password") ?? "")))) return redirect(to("wrong"), 303);
	cookies.set(accessCookie(data.id), await unlockValue(e.ACCESS_SECRET ?? "", stored, data.id), { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: ACCESS_DAYS * 86_400 });
	return redirect(back, 303);
};
