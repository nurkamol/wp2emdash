/**
 * WordPress users → an invite list for EmDash (roles SUBSCRIBER 10 … ADMIN 50, verified in @emdash-cms/auth 1.5.0:
 * docs/spikes/p2-batch-findings.md). Passwords never migrate and nobody gets an account automatically: the kit writes an
 * invite checklist the owner works through (admin → Users → Invite), and `wp2emdash invite <slug> --send` sends the
 * invites over EmDash's API only when the owner runs it.
 *
 * Names and e-mail addresses are personal data. They are written only under sites/<slug>/users/ (gitignored, like the
 * rest of sites/<slug>/): never into ir/, reports, logs, gate details or the client repository, which get counts per
 * role and nothing else.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EMDASH_ROLES = { SUBSCRIBER: 10, CONTRIBUTOR: 20, AUTHOR: 30, EDITOR: 40, ADMIN: 50 } as const;
export type EmDashRole = keyof typeof EMDASH_ROLES;
export type RoleDecision = EmDashRole | "skip";

/** WordPress core role → EmDash role. Subscribers are skipped by default (site members, not editors). */
export const DEFAULT_ROLE_MAP: Record<string, RoleDecision> = { administrator: "ADMIN", editor: "EDITOR", author: "AUTHOR", contributor: "CONTRIBUTOR", subscriber: "skip" };

/** One WordPress user as extract keeps it (REST /wp/v2/users?context=edit, administrator's application password). */
export interface WpUser {
	id: number;
	name: string;
	email?: string;
	roles: string[];
}

/** REST rows → what the kit keeps: id, name, e-mail, roles (avatars, capabilities, links and the rest are dropped). */
export function wpUsersFromRest(rows: { id: number; name?: string; email?: string; roles?: unknown }[]): WpUser[] {
	return rows.map((u) => ({ id: u.id, name: typeof u.name === "string" ? u.name : "", ...(typeof u.email === "string" && u.email ? { email: u.email } : {}), roles: Array.isArray(u.roles) ? u.roles.filter((r): r is string => typeof r === "string") : [] }));
}

export interface Invite {
	wpId: number;
	name: string;
	email: string;
	role: EmDashRole;
	wpRoles: string[];
	/** Set by `wp2emdash invite --send`: when and to which target the invite went (or why it did not). */
	sent?: { at: string; target: string; result: "emailed" | "created-not-emailed" | "exists" | "error"; detail?: string };
}

export interface InvitePlan {
	invites: Invite[];
	skipped: { wpId: number; name: string; wpRoles: string[]; why: string }[];
}

/** Counts only: what ir/, reports and the client repo may carry. */
export interface InviteCounts {
	invite: Partial<Record<EmDashRole, number>>;
	skipped: Record<string, number>;
	/** WordPress roles with no mapping (plugin roles such as shop_manager): their users are skipped until decided. */
	unmappedRoles: string[];
}

const RANK: EmDashRole[] = ["ADMIN", "EDITOR", "AUTHOR", "CONTRIBUTOR", "SUBSCRIBER"];

/** The user's EmDash role: the highest one their WordPress roles map to (overrides.ts users.roles first), else skip. */
export function roleFor(wpRoles: string[], decisions: Record<string, RoleDecision> = {}): { role?: EmDashRole; unmapped: string[] } {
	const map = { ...DEFAULT_ROLE_MAP, ...decisions };
	const mapped = wpRoles.map((r) => map[r]);
	const unmapped = wpRoles.filter((r) => map[r] === undefined);
	const role = RANK.find((r) => mapped.includes(r));
	return { ...(role ? { role } : {}), unmapped };
}

const validEmail = (e: string | undefined): e is string => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export function planInvites(users: WpUser[], o: { roles?: Record<string, RoleDecision>; skip?: number[] } = {}): InvitePlan {
	const out: InvitePlan = { invites: [], skipped: [] };
	const seen = new Set<string>();
	for (const u of [...users].sort((a, b) => a.id - b.id)) {
		const name = u.name?.trim() || `User ${u.id}`;
		const wpRoles = u.roles ?? [];
		if (o.skip?.includes(u.id)) {
			out.skipped.push({ wpId: u.id, name, wpRoles, why: "skipped by decision (overrides.ts users.skip)" });
			continue;
		}
		const { role, unmapped } = roleFor(wpRoles, o.roles);
		if (!role) {
			out.skipped.push({ wpId: u.id, name, wpRoles, why: unmapped.length ? `role ${unmapped.join(", ")} has no EmDash mapping (decide in overrides.ts users.roles)` : wpRoles.length ? `role ${wpRoles.join(", ")} not invited by default` : "no role on this site" });
			continue;
		}
		if (!validEmail(u.email)) {
			out.skipped.push({ wpId: u.id, name, wpRoles, why: "no readable e-mail address (extract needs an administrator's application password)" });
			continue;
		}
		const key = u.email.toLowerCase();
		if (seen.has(key)) {
			out.skipped.push({ wpId: u.id, name, wpRoles, why: "same e-mail address as another user" });
			continue;
		}
		seen.add(key);
		out.invites.push({ wpId: u.id, name, email: u.email, role, wpRoles });
	}
	return out;
}

export function inviteCounts(plan: InvitePlan, decisions: Record<string, RoleDecision> = {}): InviteCounts {
	const invite: InviteCounts["invite"] = {};
	for (const i of plan.invites) invite[i.role] = (invite[i.role] ?? 0) + 1;
	const skipped: Record<string, number> = {};
	for (const s of plan.skipped) for (const r of s.wpRoles.length ? s.wpRoles.slice(0, 1) : ["(none)"]) skipped[r] = (skipped[r] ?? 0) + 1;
	const map = { ...DEFAULT_ROLE_MAP, ...decisions };
	const unmappedRoles = [...new Set(plan.skipped.flatMap((s) => s.wpRoles.filter((r) => map[r] === undefined)))].sort();
	return { invite: Object.fromEntries(RANK.filter((r) => invite[r]).map((r) => [r, invite[r]])), skipped: Object.fromEntries(Object.entries(skipped).sort()), unmappedRoles };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** The owner's checklist (personal data: written to sites/<slug>/users/ only). */
export function inviteChecklist(siteName: string, plan: InvitePlan): string {
	const L = [
		`# Team invites — ${siteName}`,
		"",
		"Personal data: keep this file out of e-mail threads, tickets and repositories (sites/<slug>/ is gitignored).",
		"",
		"WordPress passwords do not move. Each person below gets an invite and sets up their own sign-in (passkey or e-mail link).",
		"Invite them in the admin (**Users → Invite**, the role as listed), or from the migration kit with",
		"`wp2emdash invite <slug>` (shows the plan) and `wp2emdash invite <slug> --send` (sends them; only with the owner's go-ahead).",
		"",
		"| Done | Name | E-mail | EmDash role | WordPress role |",
		"|---|---|---|---|---|",
		...plan.invites.map((i) => `| ${i.sent && i.sent.result !== "error" ? "x" : " "} | ${cell(i.name)} | ${cell(i.email)} | ${i.role} | ${i.wpRoles.join(", ")} |`),
	];
	if (plan.skipped.length) L.push("", "## Not invited", "", "| Name | WordPress role | Why |", "|---|---|---|", ...plan.skipped.map((s) => `| ${cell(s.name)} | ${s.wpRoles.join(", ") || "—"} | ${cell(s.why)} |`));
	return `${L.join("\n")}\n`;
}

/** Coverage report lines: counts per role only. */
export function usersReport(counts: InviteCounts | undefined): string[] {
	if (!counts) return [];
	const invited = Object.entries(counts.invite);
	const skipped = Object.entries(counts.skipped);
	const L = ["", "## Users and roles", "", "WordPress users are not migrated as accounts and their passwords never move. The invite checklist (names and e-mail addresses) is in `sites/<slug>/users/invite-checklist.md`, outside reports and the client repository; the owner invites people from it (admin → Users → Invite, or `wp2emdash invite <slug> --send`)."];
	L.push("", "| EmDash role | People to invite |", "|---|---|", ...(invited.length ? invited.map(([r, n]) => `| ${r} | ${n} |`) : ["| — | 0 |"]));
	if (skipped.length) L.push("", `Not invited: ${skipped.map(([r, n]) => `${n} ${r}`).join(", ")}.`);
	if (counts.unmappedRoles.length) L.push("", `Roles without a mapping (their users are not invited until decided in \`overrides.ts users.roles\`): ${counts.unmappedRoles.map((r) => `\`${r}\``).join(", ")}.`);
	return L;
}

export const usersDir = (root: string) => join(root, "users");
export const INVITES_FILE = "invites.json";
/** What extract read from WordPress (id, name, e-mail, roles), under sites/<slug>/users/. */
export const WP_USERS_FILE = "wordpress-users.json";

export function readInvites(root: string): InvitePlan | undefined {
	const f = join(usersDir(root), INVITES_FILE);
	return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as InvitePlan) : undefined;
}

/** Writes the invite list and checklist under sites/<slug>/users/, keeping what `invite --send` recorded for each address. */
export function writeInvites(root: string, siteName: string, plan: InvitePlan): void {
	const prev = new Map((readInvites(root)?.invites ?? []).map((i) => [i.email.toLowerCase(), i.sent]));
	const merged: InvitePlan = { ...plan, invites: plan.invites.map((i) => { const sent = prev.get(i.email.toLowerCase()); return sent ? { ...i, sent } : i; }) };
	mkdirSync(usersDir(root), { recursive: true });
	writeFileSync(join(usersDir(root), INVITES_FILE), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
	writeFileSync(join(usersDir(root), "invite-checklist.md"), inviteChecklist(siteName, merged), { mode: 0o600 });
}
