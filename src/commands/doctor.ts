import { execFileSync } from "node:child_process";

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
