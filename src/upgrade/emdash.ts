/**
 * The EmDash step of `wp2emdash upgrade`: what changes when a delivered site moves to another EmDash version, and the
 * order that keeps the live site working (docs/spikes/emdash-upgrade-findings.md).
 *
 *   1. Read-only, after the rebuild: `emdash migrate --status --json` against the production database — the database
 *      changes the new version will apply, the database's fingerprint (must be the one provision recorded), and any
 *      change the new version does not know (stop). A change on the maintenance list stops too.
 *   2. `upgrade --prepare-db --yes`: a D1 Time Travel bookmark + a marker on the Backups page, then the new version's
 *      database changes alone. The live (older) Worker keeps running: EmDash's runtime accepts a database with at least
 *      the migrations it knows (verified on 1.5.0, `runner` fast path).
 *   3. `versions:upload` → preview URL → `upgrade --verify <preview-url>` (required): the new code on the real database,
 *      no visitor on it yet. Uploading before step 2 would let EmDash's `auto` mode apply the changes on the preview's
 *      first request, outside the bookmark.
 *   4. `versions:deploy` (owner's approval): exactly the version that was previewed.
 *   5. `upgrade --verify`, then `upgrade --after-release --yes`: the release's one-time steps (e.g. 1.6.0's media usage
 *      repair). Undo: `wrangler rollback` (older code works on the changed database); restore the bookmark only if data
 *      went wrong.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One-time steps a release asks for after its deploy. */
export type AfterStep = { id: "media-repair-usage"; label: string };

export interface EmdashRelease {
	/** Database changes (core migrations) this version adds. */
	migrations: string[];
	after: AfterStep[];
	/** Read from the release notes; kept short. */
	note: string;
}

/**
 * Releases the kit has been checked against (docs/spikes/emdash-upgrade-findings.md). A version missing here is not
 * refused, but upgrade says so: read its release notes and add it.
 */
export const EMDASH_RELEASES: Record<string, EmdashRelease> = {
	"1.6.0": {
		migrations: ["098_user_last_login"],
		after: [{ id: "media-repair-usage", label: 'Repair the media "Used in" index once (1.6.0 also counts links to media files; existing entries are not re-indexed by themselves)' }],
		note: "Images cached for a year with the route cache; missing-entry 404s cacheable (opt-in); exact redirects for file paths; search scores 0–1 per collection.",
	},
};

/** Database changes that must not run under a live site: they need a maintenance window (EmDash's upgrade guide). */
export const MAINTENANCE_MIGRATIONS: Record<string, string> = {
	"095_plugin_storage_unique_scope": "plugin storage uniqueness: EmDash's upgrade guide asks for a maintenance window instead of a rolling deploy",
};

export interface MigrateStatus {
	fingerprint?: string;
	label?: string;
	pending: string[];
	unknownApplied: string[];
	knownApplied: number;
}

/** `emdash migrate --status --json` (EmDash 1.5/1.6 stable JSON report). */
export function parseMigrateStatus(text: string): MigrateStatus {
	const start = text.indexOf("{");
	if (start < 0) throw new Error("emdash migrate --status --json printed no JSON");
	const j = JSON.parse(text.slice(start)) as { target?: { fingerprint?: string; label?: string }; pending?: string[]; unknownApplied?: string[]; knownApplied?: string[] };
	return { ...(j.target?.fingerprint ? { fingerprint: j.target.fingerprint } : {}), ...(j.target?.label ? { label: j.target.label } : {}), pending: j.pending ?? [], unknownApplied: j.unknownApplied ?? [], knownApplied: j.knownApplied?.length ?? 0 };
}

const cmp = (a: string, b: string) => {
	const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
};

export interface EmdashPlan {
	from: string;
	to: string;
	/** Releases between from (exclusive) and to (inclusive) the kit knows. */
	releases: string[];
	/** Versions in that range the kit has no entry for (newer than every known one). */
	unknownRelease: boolean;
	pending: string[];
	fingerprint?: string;
	after: AfterStep[];
	blockers: string[];
	notes: string[];
}

/** What the version change means for this database, and what stops it. */
export function planEmdashStep(o: { from: string; to: string; status: MigrateStatus; recordedFingerprint?: string }): EmdashPlan {
	const releases = Object.keys(EMDASH_RELEASES)
		.filter((v) => cmp(v, o.from) > 0 && cmp(v, o.to) <= 0)
		.sort(cmp);
	const unknownRelease = !EMDASH_RELEASES[o.to];
	const blockers: string[] = [];
	const notes: string[] = [];
	if (cmp(o.to, o.from) < 0) blockers.push(`EmDash would go down from ${o.from} to ${o.to}: database changes cannot be undone by an older version. Pin the kit's STACK.emdash back up, or restore the database first.`);
	if (o.status.unknownApplied.length) blockers.push(`The production database has changes EmDash ${o.to} does not know (${o.status.unknownApplied.join(", ")}): it was migrated by a newer version. Stop and find out which.`);
	if (o.recordedFingerprint && o.status.fingerprint && o.recordedFingerprint !== o.status.fingerprint) blockers.push(`The database answering is not the one provision recorded (fingerprint ${o.status.fingerprint.slice(0, 12)}… ≠ cloudflare.json production.d1.fingerprint ${o.recordedFingerprint.slice(0, 12)}…). Check wrangler.jsonc and the account before anything is applied.`);
	for (const m of o.status.pending) if (MAINTENANCE_MIGRATIONS[m]) blockers.push(`${m}: ${MAINTENANCE_MIGRATIONS[m]}. Plan the window with the owner; upgrade does not apply it under a live site.`);
	const expected = new Set(releases.flatMap((v) => EMDASH_RELEASES[v]?.migrations ?? []));
	const surprise = o.status.pending.filter((m) => !expected.has(m) && !MAINTENANCE_MIGRATIONS[m]);
	if (surprise.length) notes.push(`Pending changes the kit's release list does not mention: ${surprise.join(", ")} (an earlier upgrade left them unapplied, or the list is incomplete). They are applied with the rest by --prepare-db.`);
	if (unknownRelease) notes.push(`EmDash ${o.to} is not in the kit's release list (src/upgrade/emdash.ts): read its release notes, record what it changes, then rerun.`);
	if (unknownRelease) blockers.push(`EmDash ${o.to} has not been checked by the kit yet.`);
	return { from: o.from, to: o.to, releases, unknownRelease, pending: o.status.pending, ...(o.status.fingerprint ? { fingerprint: o.status.fingerprint } : {}), after: releases.flatMap((v) => EMDASH_RELEASES[v]?.after ?? []), blockers, notes };
}

/** The EmDash version a project runs now: the installed package, else its package.json pin. */
export function projectEmdashVersion(project: string): string | undefined {
	for (const f of [join(project, "node_modules", "emdash", "package.json")]) {
		try {
			if (existsSync(f)) return (JSON.parse(readFileSync(f, "utf8")) as { version?: string }).version;
		} catch {
			// fall through
		}
	}
	try {
		const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		return pkg.dependencies?.emdash?.replace(/^[\^~]/, "");
	} catch {
		return undefined;
	}
}

export interface EmdashRunner {
	/** `emdash migrate --status --json` (read-only). */
	status(project: string, env: Record<string, string>): Promise<{ code: number; out: string }>;
	/** `emdash migrate --expected-target-fingerprint=<fp>` then `--check`. */
	migrate(project: string, env: Record<string, string>, fingerprint: string): Promise<{ code: number; out: string }>;
	/** `emdash media repair-usage --all --url <url> --json` with the admin token. */
	repairMediaUsage(project: string, url: string, token: string): Promise<{ code: number; out: string }>;
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
		let out = "";
		p.stdout.on("data", (b: Buffer) => (out += b.toString()));
		p.stderr.on("data", (b: Buffer) => (out += b.toString()));
		p.on("error", (e) => resolve({ code: 1, out: `${out}${e.message}` }));
		p.on("close", (code) => resolve({ code: code ?? 1, out }));
	});
}

export const defaultEmdashRunner: EmdashRunner = {
	status: (project, env) => run("npx", ["emdash", "migrate", "--status", "--json", "--wrangler-config", "wrangler.jsonc"], project, env),
	migrate: async (project, env, fingerprint) => {
		const a = await run("npx", ["emdash", "migrate", "--wrangler-config", "wrangler.jsonc", `--expected-target-fingerprint=${fingerprint}`], project, env);
		if (a.code !== 0) return a;
		const c = await run("npx", ["emdash", "migrate", "--check", "--wrangler-config", "wrangler.jsonc"], project, env);
		return { code: c.code, out: `${a.out}\n${c.out}` };
	},
	// The CLI reads the token from EMDASH_TOKEN (emdash 1.6.0 dist), so it never appears in the process list.
	repairMediaUsage: (project, url, token) => run("npx", ["emdash", "media", "repair-usage", "--all", "--url", url, "--json"], project, { EMDASH_TOKEN: token }),
};
