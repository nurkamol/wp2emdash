import { execFileSync } from "node:child_process";
import { KIT_ROOT } from "../core/paths.js";
import { loadEnv } from "../extract/credentials.js";
import { join } from "node:path";

export interface DoctorCheck {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
	required: boolean;
}

function run(cmd: string, args: string[]): string | undefined {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }).trim();
	} catch {
		return undefined;
	}
}

/** Compares dotted versions: true when `have` >= `want`. */
export function versionAtLeast(have: string, want: string): boolean {
	const a = have.replace(/^v/, "").split(".").map(Number);
	const b = want.split(".").map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return true;
}

/**
 * Verifies the shared Cloudflare API token (kit .env or environment) with Cloudflare's
 * token-verify endpoint. The token is sent only to api.cloudflare.com and never printed.
 */
export async function cloudflareTokenCheck(): Promise<DoctorCheck> {
	const token = process.env.CLOUDFLARE_API_TOKEN ?? loadEnv(join(KIT_ROOT, ".env")).CLOUDFLARE_API_TOKEN;
	const base = { id: "cloudflare-token", label: "Cloudflare API token", required: false };
	if (!token) return { ...base, ok: false, detail: "not set — see docs/cloudflare-api-token.md (needed for staging, migrations, deploy)" };
	try {
		const r = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
		const j = (await r.json()) as { success?: boolean; result?: { status?: string; expires_on?: string } };
		const active = j.success && j.result?.status === "active";
		return { ...base, ok: !!active, detail: active ? `active${j.result?.expires_on ? `, expires ${j.result.expires_on.slice(0, 10)}` : ""}` : `not active (HTTP ${r.status})` };
	} catch (e) {
		return { ...base, ok: false, detail: `could not verify: ${(e as Error).message}` };
	}
}

/** Local prerequisites. Required ones block `audit`/`scaffold`; optional ones are reported. */
export function doctor(): DoctorCheck[] {
	const node = process.version;
	const pnpm = run("pnpm", ["--version"]);
	const git = run("git", ["--version"]);
	const wrangler = run("npx", ["--no-install", "wrangler", "--version"]);
	const whoami = wrangler ? run("npx", ["--no-install", "wrangler", "whoami"]) : undefined;
	const playwright = run("npx", ["--no-install", "playwright", "--version"]);

	return [
		{ id: "node", label: "Node.js ≥ 24", ok: versionAtLeast(node, "24.0.0"), detail: node, required: true },
		{ id: "pnpm", label: "pnpm", ok: !!pnpm, detail: pnpm ?? "not found — npm i -g pnpm", required: true },
		{ id: "git", label: "git", ok: !!git, detail: git ?? "not found", required: true },
		{
			id: "playwright",
			label: "Playwright (audit & verify)",
			ok: !!playwright,
			detail: playwright ?? "added in M2 (pnpm add -D playwright && npx playwright install chromium)",
			required: false,
		},
		{
			id: "wrangler",
			label: "Wrangler (scaffold & deploy)",
			ok: !!wrangler,
			detail: wrangler?.split("\n").pop() ?? "installed per site project in M5",
			required: false,
		},
		{
			id: "cloudflare-auth",
			label: "Cloudflare login",
			ok: !!whoami && !/not authenticated/i.test(whoami),
			detail: whoami ? "logged in" : "run `npx wrangler login` before scaffold",
			required: false,
		},
	];
}
