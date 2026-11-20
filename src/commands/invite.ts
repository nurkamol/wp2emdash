/**
 * `wp2emdash invite <slug>`: the team invite list from the WordPress users (sites/<slug>/users/invites.json, written by
 * transform). Without `--send` it only shows the plan (counts per role, the target) and changes nothing. With `--send`
 * — the owner's explicit step, never part of load — it creates each pending invite through EmDash's
 * `POST /_emdash/api/auth/invite` (admin token; EmDash e-mails the invite when the site has an e-mail provider).
 *
 * When EmDash answers without sending (no e-mail provider: it returns the invite link instead), the command keeps no
 * copy of the link, records "created, not e-mailed" and stops: the owner sets up e-mail first, or invites people from the
 * admin (Users → Invite), which shows the link to share. Output and return value carry counts only, never addresses.
 */
import { loadConfig } from "../config/load.js";
import { defaultTarget, noProductionTargets, readCf, siteEnvironments } from "../core/environments.js";
import { sitePaths } from "../core/paths.js";
import { loadSiteEnv } from "../extract/credentials.js";
import { EmDashApi, EmDashHttpError } from "../targets/emdash/api.js";
import { remoteTarget, targetName } from "../targets/remote.js";
import { EMDASH_ROLES, type EmDashRole, type Invite, readInvites, writeInvites } from "../transform/users.js";

export interface InviteResult {
	target: string;
	applied: boolean;
	/** People to invite per EmDash role. */
	plan: Partial<Record<EmDashRole, number>>;
	pending: number;
	sent: { emailed: number; createdNotEmailed: number; exists: number; errors: number };
	/** EmDash has no e-mail provider: stopped after the first invite (link not kept). */
	stoppedNoEmail: boolean;
	next: string[];
}

type InviteApi = Pick<EmDashApi, "invite">;

const pendingOf = (i: Invite) => !i.sent || i.sent.result === "error";

export async function invite(slug: string, o: { send?: boolean; sitesDir?: string; api?: InviteApi; target?: string; now?: () => Date } = {}): Promise<InviteResult> {
	const paths = o.sitesDir ? sitePaths(slug, o.sitesDir) : sitePaths(slug);
	const plan = readInvites(paths.root);
	if (!plan) throw new Error(`No invite list: run \`wp2emdash run ${slug} extract\` (with an administrator's application password) and \`wp2emdash run ${slug} transform\` first`);
	const counts: InviteResult["plan"] = {};
	for (const i of plan.invites) counts[i.role] = (counts[i.role] ?? 0) + 1;
	const pending = plan.invites.filter(pendingOf);
	const config = await loadConfig(paths.config);
	const envs = siteEnvironments(config, readCf(paths.root));
	const target = o.target ?? targetName(process.env.WP2EMDASH_LOAD_TARGET, defaultTarget("load", envs, { noProduction: noProductionTargets() }));
	const result: InviteResult = { target, applied: false, plan: counts, pending: pending.length, sent: { emailed: 0, createdNotEmailed: 0, exists: 0, errors: 0 }, stoppedNoEmail: false, next: [] };
	if (!o.send) {
		result.next.push(pending.length ? `With the owner's go-ahead: wp2emdash invite ${slug} --send (${pending.length} invite(s) to ${target}), or invite them in the admin from sites/${slug}/users/invite-checklist.md` : "Nothing pending: every invite on the list was sent.");
		return result;
	}
	if (target !== "staging" && target !== "production") throw new Error("Invites go to a deployed site: provision production (or set WP2EMDASH_LOAD_TARGET=staging for a site with staging)");
	if (target === "production" && noProductionTargets()) throw new Error("Refused: this run may not target production (WP2EMDASH_NO_PRODUCTION=1). Invites are the owner's step.");
	let api = o.api;
	if (!api) {
		const t = remoteTarget(paths.root, config, loadSiteEnv(paths.root), target);
		if ("error" in t) throw new Error(t.error);
		if (!t.token) throw new Error(`Set ${t.tokenName} (an EmDash API token with the admin scope, owned by an administrator) in sites/${slug}/.env`);
		api = new EmDashApi(t.url, { token: t.token });
	}
	result.applied = true;
	const now = o.now ?? (() => new Date());
	for (const i of pending) {
		try {
			const r = await api.invite(i.email, EMDASH_ROLES[i.role]);
			if (r.inviteUrl) {
				// No e-mail provider: EmDash returned the link instead of sending it. Not kept (it is a sign-up credential).
				i.sent = { at: now().toISOString(), target, result: "created-not-emailed", detail: "no e-mail provider on the site: invite again from the admin (Users → Invite) to get the link" };
				result.sent.createdNotEmailed++;
				result.stoppedNoEmail = true;
				break;
			}
			i.sent = { at: now().toISOString(), target, result: "emailed" };
			result.sent.emailed++;
		} catch (e) {
			const err = e as EmDashHttpError;
			if (err instanceof EmDashHttpError && (err.status === 409 || err.code === "USER_EXISTS")) {
				i.sent = { at: now().toISOString(), target, result: "exists" };
				result.sent.exists++;
			} else {
				i.sent = { at: now().toISOString(), target, result: "error", detail: err instanceof EmDashHttpError ? `${err.status} ${err.code}` : "request failed" };
				result.sent.errors++;
				if (err instanceof EmDashHttpError && (err.code === "INSUFFICIENT_SCOPE" || err.code === "FORBIDDEN" || err.status === 401)) {
					result.next.push("The API token needs the admin scope and must belong to an administrator (EmDash requires both for invites).");
					break;
				}
			}
		}
	}
	writeInvites(paths.root, config.name, plan);
	if (result.stoppedNoEmail) result.next.push("The site has no e-mail provider for EmDash invites: configure one (or invite the rest from the admin, which shows each link), then rerun --send for the remaining invites.");
	return result;
}
