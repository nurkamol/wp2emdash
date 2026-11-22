#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { cloudflareTokenCheck, doctor, encryptionKeyCheck } from "../commands/doctor.js";
import { provision } from "../commands/provision.js";
import { importOptions } from "../commands/import-options.js";
import { importDump } from "../commands/import-dump.js";
import { initSite, validateSlug, validateUrl } from "../commands/init.js";
import { acceptPhase, runPhase } from "../commands/run.js";
import { formatTimeline, listSites, statusJson } from "../commands/status.js";
import { proposalsCommand } from "../commands/proposals.js";
import { serveUi } from "../commands/ui.js";
import { sitePaths } from "../core/paths.js";
import { isPhaseId, PHASE_IDS, PHASES } from "../core/phases.js";
import { readState } from "../core/state.js";
import { wizard } from "./wizard.js";

const program = new Command()
	.name("wp2emdash")
	.description("Migrate WordPress sites to EmDash on Cloudflare, with verification gates.\nRun without arguments for the interactive wizard.")
	.version("0.1.0");

const fail = (msg: string): never => {
	console.error(pc.red(msg));
	process.exit(1);
};

program
	.command("init")
	.description("Create sites/<slug>/ workspace")
	.requiredOption("--slug <slug>", "short id, lowercase-hyphenated")
	.requiredOption("--name <name>", "client / site name")
	.requiredOption("--source <url>", "live WordPress URL")
	.option("--production <url>", "production URL after cutover (default: --source)")
	.option("--sensitive", "site handles sensitive data (health, legal, finance)", false)
	.option("--from <slug>", "start from an existing site: copy its kit.config.ts (slug, name, URLs replaced), overrides.ts and decisions.md — nothing else")
	.action((o) => {
		const err = validateSlug(o.slug) ?? validateUrl(o.source) ?? (o.production ? validateUrl(o.production) : undefined) ?? (o.from ? validateSlug(o.from) : undefined);
		if (err) fail(err);
		let res: ReturnType<typeof initSite>;
		try {
			res = initSite({ slug: o.slug, name: o.name, sourceUrl: o.source, productionUrl: o.production ?? o.source, sensitiveData: !!o.sensitive }, undefined, o.from);
		} catch (e) {
			return fail((e as Error).message);
		}
		console.log(pc.green(`Created ${res.root}${o.from ? ` (config, overrides and decisions from ${o.from})` : ""}`));
		console.log(`Next: complete the required items in ${pc.bold("ACCESS.md")}, then \`wp2emdash run ${o.slug} init\`.`);
	});

program
	.command("run")
	.description(`Run a phase (${PHASE_IDS.join(" → ")})`)
	.argument("<slug>")
	.argument("<phase>")
	.option("--json", "stream progress events as JSON lines")
	.option("--preview", "read-only phases: run out of order, don't record the gate")
	.option("--force", "load: write to a live production (after go-live); a D1 Time Travel bookmark is recorded first and the restore command printed")
	.option("--only <part>", "load: run one part only — settings (Settings → General, Social Links, SEO; no media, pages, menus or redirects): the safe way to apply settings to a live site")
	.option("--overwrite-settings", "load: replace site settings (logo, social links, SEO…) an editor changed in the admin since the last load")
	.action(async (slug: string, phase: string, o) => {
		if (!isPhaseId(phase)) fail(`Unknown phase "${phase}". Phases: ${PHASE_IDS.join(", ")}`);
		if (o.force && phase !== "load") fail("--force only applies to load");
		if (o.overwriteSettings && phase !== "load") fail("--overwrite-settings only applies to load");
		if (o.only && (phase !== "load" || o.only !== "settings")) fail("--only applies to load, with: settings");
		const result = await runPhase(slug, phase as never, { json: o.json, preview: o.preview, ...(o.force ? { force: true } : {}), ...(o.overwriteSettings ? { overwriteSettings: true } : {}), ...(o.only ? { only: o.only } : {}) }).catch((e: Error) => fail(e.message));
		if (o.json) console.log(JSON.stringify({ type: "result", ...result }));
		process.exit(result.ok ? 0 : result.notImplemented ? 3 : 2);
	});

program
	.command("accept")
	.description("Accept a failed gate with a reason (logged to decisions.md)")
	.argument("<slug>")
	.argument("<phase>")
	.requiredOption("--reason <text>")
	.requiredOption("--by <name>", "who approved it")
	.action((slug: string, phase: string, o) => {
		if (!isPhaseId(phase)) fail(`Unknown phase "${phase}"`);
		try {
			acceptPhase(slug, phase as never, o.reason, o.by);
			console.log(pc.yellow(`Accepted ${phase} for ${slug}.`));
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("status")
	.description("Show the phase timeline for one or all sites")
	.argument("[slug]")
	.option("--json")
	.action((slug: string | undefined, o) => {
		const slugs = slug ? [slug] : listSites();
		if (o.json) return console.log(JSON.stringify(slugs.map((s) => statusJson(s)), null, 2));
		if (!slugs.length) return console.log("No sites yet. Run `wp2emdash` or `wp2emdash init`.");
		for (const s of slugs) {
			const p = sitePaths(s);
			console.log(`${formatTimeline(readState(p.state))}\n  ${pc.dim(`project: ${p.project}${p.project.startsWith(p.root) ? "" : " (projectDir)"}`)}\n`);
		}
	});

program
	.command("compare")
	.description("Content diff between two audited sites (read-only, no network): pages only on one side, text similarity, meta, forms, external links → sites/<slugB>/reports/compare/<slugA>.md|.json")
	.argument("<slugA>")
	.argument("<slugB>")
	.option("--json", "print the full comparison as JSON")
	.action(async (a: string, b: string, o: { json?: boolean }) => {
		const { compareCommand, compareTable } = await import("../compare/sites.js");
		try {
			const r = compareCommand(a, b);
			if (o.json) return console.log(JSON.stringify(r.comparison, null, 2));
			console.log(compareTable(r.comparison));
			console.log(pc.dim(`\nReport: ${r.md}`));
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("check-aliases")
	.description("After the alias switch (read-only): every audited path on each target.aliasDomains host (apex and www) must 301 to the same path on the primary; no redirect followed")
	.argument("<slug>")
	.option("--paths-from <slugs>", "also check the paths audited on these sites (comma-separated, e.g. the alias site's own workspace)")
	.option("--limit <n>", "check only the first n paths")
	.option("--json")
	.action(async (slug: string, o: { pathsFrom?: string; limit?: string; json?: boolean }) => {
		const { checkAliases } = await import("../commands/check-aliases.js");
		try {
			const r = await checkAliases(slug, { ...(o.pathsFrom ? { pathsFrom: o.pathsFrom.split(",").map((s) => s.trim()).filter(Boolean) } : {}), ...(o.limit ? { limit: Number(o.limit) } : {}) });
			if (o.json) console.log(JSON.stringify(r.result, null, 2));
			else {
				for (const [h, v] of Object.entries(r.result.byHost)) console.log(`${v.ok === v.checked ? pc.green("✔") : pc.red("✖")} ${h.padEnd(36)} ${v.ok}/${v.checked}`);
				for (const f of r.result.failures.slice(0, 20)) console.log(pc.dim(`  ${f.url} → ${f.problem}`));
				if (r.result.failures.length > 20) console.log(pc.dim(`  … ${r.result.failures.length - 20} more`));
				console.log(pc.dim(`Report: ${r.md}`));
			}
			process.exit(r.result.ok ? 0 : 2);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("invite")
	.description("Team invites from the WordPress users (sites/<slug>/users/invites.json): shows the plan; --send creates them through EmDash — only with the owner's go-ahead. Never part of load.")
	.argument("<slug>")
	.option("--send", "create the pending invites on the target (EmDash e-mails them when the site has an e-mail provider)")
	.option("--json")
	.action(async (slug: string, o: { send?: boolean; json?: boolean }) => {
		const { invite } = await import("../commands/invite.js");
		try {
			const r = await invite(slug, { send: !!o.send });
			if (o.json) console.log(JSON.stringify(r, null, 2));
			else {
				console.log(`Target: ${r.target} · to invite: ${Object.entries(r.plan).map(([k, n]) => `${n} ${k}`).join(", ") || "nobody"} · pending: ${r.pending}`);
				if (r.applied) console.log(`Sent: ${r.sent.emailed} e-mailed, ${r.sent.createdNotEmailed} created without e-mail, ${r.sent.exists} already had an account, ${r.sent.errors} failed`);
				if (r.next.length) console.log(`\nNext:\n${r.next.map((n) => `  - ${n}`).join("\n")}`);
			}
			process.exit(r.applied && (r.sent.errors || r.stoppedNoEmail) ? 2 : 0);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("golive")
	.description("Owner-approved traffic switch: Worker routes for the domain, smoke test, production.live (prints the plan and changes nothing without --yes)")
	.argument("<slug>")
	.option("--aliases", "the separate alias step: one Single Redirect rule per target.aliasDomains entry, then check-aliases and a DNS comparison")
	.option("--rollback", "delete exactly the routes / alias rules recorded in cutover/golive.json and set production.live = false (with --aliases: only the alias rules)")
	.option("--yes", "apply — only after the owner's explicit go-ahead in the current conversation")
	.option("--limit <n>", "smoke-test only the first n audited paths")
	.option("--approved-by <name>", "with --yes: who approved this step (recorded in cutover/golive.json → approvals)")
	.option("--approval <text>", "with --yes: the owner's written approval as given (name, date, where), recorded with it")
	.option("--via <channel>", "where the approval was recorded from (default: cli)")
	.option("--json")
	.action(async (slug: string, o: { aliases?: boolean; rollback?: boolean; yes?: boolean; limit?: string; json?: boolean; approvedBy?: string; approval?: string; via?: string }) => {
		const { golive } = await import("../commands/golive.js");
		try {
			const approval = o.approvedBy && o.approval ? { approval: { by: o.approvedBy, text: o.approval, via: o.via ?? "cli" } } : {};
			const r = await golive(slug, { aliases: !!o.aliases, rollback: !!o.rollback, yes: !!o.yes, ...approval, ...(o.limit ? { limit: Number(o.limit) } : {}), ...(o.json ? {} : { log: (l: string) => console.log(l) }) });
			if (o.json) console.log(JSON.stringify(r, null, 2));
			else {
				for (const c of r.checks) console.log(`${c.ok ? pc.green("✔") : pc.red("✖")} ${c.label}${c.detail ? pc.dim(` — ${c.detail}`) : ""}`);
				if (r.next.length) console.log(`\nNext:\n${r.next.map((n) => `  - ${n}`).join("\n")}`);
			}
			// 0 applied and green · 2 applied, a check failed · 1 refused / plan only / error
			process.exit(r.applied ? (r.ok ? 0 : 2) : 1);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("publish")
	.description("Put the site's project in a private GitHub repository: secret scan, commit, gh repo create --private, push, CLOUDFLARE_ACCOUNT_ID variable (prints the plan without --yes)")
	.argument("<slug>")
	.option("--repo <owner/name>", "repository (default: the production domain, under your GitHub account)")
	.option("--yes", "apply")
	.option("--json", "print the result (plan, blockers, file list, secret-scan findings by file name) as JSON")
	.action(async (slug: string, o: { repo?: string; yes?: boolean; json?: boolean }) => {
		const { publish } = await import("../commands/publish.js");
		try {
			const r = await publish(slug, { ...(o.repo ? { repo: o.repo } : {}), yes: !!o.yes, ...(o.json ? {} : { log: (l: string) => console.log(l) }) });
			if (o.json) console.log(JSON.stringify(r, null, 2));
			process.exit(r.applied ? 0 : 1);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("upgrade")
	.description("Move a delivered site to the current kit version: snapshot every live page, rerun scaffold, (opt-in staging) deploy staging and compare page by page; prints the production deploy command, never runs it. --verify afterwards compares production with the saved snapshot")
	.argument("<slug>")
	.option("--deploy-staging", "sites with staging (target.staging): run the project's ci:deploy:staging, then compare staging with the snapshot")
	.option("--verify [where]", "compare an address with the latest before.json now: production (default), staging, or a URL (e.g. a Workers version preview)")
	.option("--limit <n>", "snapshot at most n pages (default 300)")
	.option("--preview", "rebuild like `run <slug> scaffold --preview` (earlier gates not required, state.json untouched): sites delivered before the kit recorded every phase")
	.option("--json", "print the result as JSON")
	.action(async (slug: string, o: { deployStaging?: boolean; verify?: string | boolean; limit?: string; preview?: boolean; json?: boolean }) => {
		const { upgrade } = await import("../commands/upgrade.js");
		if (o.verify !== undefined && o.deployStaging) fail("--verify and --deploy-staging are separate steps");
		const limit = o.limit ? Number(o.limit) : undefined;
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) fail("--limit must be a positive whole number");
		try {
			const r = await upgrade(slug, { ...(o.verify !== undefined ? { verify: o.verify === true ? "production" : String(o.verify) } : {}), ...(o.deployStaging ? { deployStaging: true } : {}), ...(limit ? { limit } : {}), ...(o.preview ? { preview: true } : {}), ...(o.json ? {} : { log: (l: string) => console.log(pc.dim(l)) }) });
			if (o.json) console.log(JSON.stringify(r, null, 2));
			else {
				if (r.scaffold) console.log(`${r.scaffold.ok ? pc.green("✔") : pc.red("✖")} scaffold gate${r.scaffold.failing.length ? pc.dim(` — failing: ${r.scaffold.failing.map((c) => c.id).join(", ")}`) : ""}`);
				if (r.stagingDeploy?.ran) console.log(`${r.stagingDeploy.ok ? pc.green("✔") : pc.red("✖")} staging deploy${r.stagingDeploy.reason ? pc.dim(` — ${r.stagingDeploy.reason}`) : ""}`);
				for (const c of r.comparisons) console.log(`${c.identical ? pc.green("✔") : pc.red("✖")} ${c.label}: ${c.identical ? "identical (only expected changes)" : `${c.pagesWithDifferences} page(s) with differences`} · ${c.pagesCompared} compared${c.pagesWithNotices ? pc.dim(` · ${c.pagesWithNotices} with expected changes`) : ""}\n  ${pc.dim(`Report: ${c.md}`)}`);
				if (r.error) console.log(pc.red(r.error));
				if (r.next.length) console.log(`\nNext:\n${r.next.map((n) => `  - ${n}`).join("\n")}`);
			}
			process.exit(r.exitCode);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("fleet")
	.description("One view of every site: environments, kit and plugin versions built with vs current, last change, last upgrade check, owner to-dos. `fleet upgrade-prs`: a wp2emdash/v<version> branch per site behind the kit, rebuilt and committed (dry run by default; never main)")
	.argument("[action]", "upgrade-prs")
	.option("--sites <list>", "only these slugs (comma-separated)")
	.option("--live", "read-only network: home page status and response time, last production deploy (wrangler deployments list)")
	.option("--json", "print as JSON")
	.option("--dry-run", "upgrade-prs: show what would happen (the default)")
	.option("--apply", "upgrade-prs: create the branch, rebuild and commit on it (never main); prints the push / gh pr create command")
	.option("--open", "upgrade-prs: --apply, then push the branch and open the pull request with gh")
	.option("--all", "upgrade-prs: also sites already on the current kit version")
	.action(async (action: string | undefined, o: { sites?: string; live?: boolean; json?: boolean; dryRun?: boolean; apply?: boolean; open?: boolean; all?: boolean }) => {
		const sites = o.sites ? o.sites.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
		try {
			if (action === undefined) {
				if (o.apply || o.open || o.dryRun) fail("--apply / --open / --dry-run belong to `fleet upgrade-prs`");
				const { fleet, fleetTable } = await import("../commands/fleet.js");
				const r = await fleet({ ...(sites ? { sites } : {}), ...(o.live ? { live: true } : {}) });
				return console.log(o.json ? JSON.stringify(r, null, 2) : fleetTable(r));
			}
			if (action !== "upgrade-prs") fail(`Unknown fleet action "${action}" (upgrade-prs)`);
			if (o.dryRun && (o.apply || o.open)) fail("--dry-run cannot be combined with --apply or --open");
			const { upgradePrs, upgradePrsReport } = await import("../commands/fleet-prs.js");
			const r = await upgradePrs({ ...(sites ? { sites } : {}), ...(o.apply ? { apply: true } : {}), ...(o.open ? { open: true } : {}), ...(o.all ? { all: true } : {}), ...(o.json ? {} : { log: (l: string) => console.log(pc.dim(l)) }) });
			console.log(o.json ? JSON.stringify(r, null, 2) : upgradePrsReport(r, o));
			process.exitCode = r.some((x) => x.status === "failed") ? 1 : r.some((x) => x.status === "refused") ? 2 : 0;
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("phases")
	.description("List pipeline phases")
	.action(() => {
		for (const p of PHASES) console.log(`${pc.bold(p.id.padEnd(10))} ${p.milestone}  ${p.summary}`);
	});

program
	.command("provision <slug> [env]")
	.description("Create an environment's Cloudflare resources (D1, R2, KV outbox, KV session) in its account and record them in cloudflare.json. env: production (default; a single-environment site has only this) or staging (opt-in: target.staging: true)")
	.option("--location <hint>", "D1/R2 location: enam, wnam, weur, eeur, apac, oc (default: the environment's current one, else enam)")
	.option("--json")
	.action(async (slug: string, env: string = "production", o: { location?: string; json?: boolean }) => {
		if (env !== "staging" && env !== "production") throw new Error("env must be staging or production");
		const r = await provision(slug, env, o.location ? { location: o.location } : {});
		if (o.json) return console.log(JSON.stringify(r, null, 2));
		console.log(`${pc.bold(env)} in ${r.accountName ?? r.accountId}${r.movedFrom ? pc.dim(` (moved from ${r.movedFrom}; old resources kept under previous)`) : ""}`);
		for (const c of r.created) console.log(`${pc.green("+")} ${c}`);
		for (const c of r.reused) console.log(`${pc.dim("=")} ${c}`);
		if (r.workersSubdomain) console.log(`${pc.dim("workers.dev:")} ${r.workersSubdomain}`);
		for (const n of r.notes) console.log(`${pc.yellow("!")} ${n}`);
	});

program
	.command("ui")
	.description("Local dashboard: portfolio, launch readiness, live runs, visual diff viewer (127.0.0.1 only, token-protected)")
	.option("--no-open", "print the URL without opening the browser")
	.option("--port <n>", "port (default: a random free one)")
	.action(async (o: { open: boolean; port?: string }) => {
		const port = o.port ? Number(o.port) : undefined;
		if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) fail("--port must be 1024–65535");
		await serveUi({ open: o.open, ...(port ? { port } : {}) });
	});

program
	.command("proposals")
	.description("Approval queue: list proposed overrides.ts/decisions.md changes, or approve (applies the patch) / reject one")
	.argument("<slug>")
	.argument("[action]", "approve | reject")
	.argument("[id]", "proposal id (p-yyyymmdd-xxxxxx)")
	.option("--by <name>", "who decided (required for approve/reject)")
	.option("--note <text>", "note recorded with the decision")
	.option("--all", "list decided proposals too")
	.option("--json")
	.action(async (slug: string, action: string | undefined, id: string | undefined, o) => {
		try {
			process.exitCode = await proposalsCommand(slug, action, id, o);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("mcp")
	.description("MCP server on stdio for Claude Code: status, run_phase, read_report, list_diagnostics, explain_gate, propose_override, upgrade_verify")
	.action(async () => {
		const { serveMcp } = await import("../mcp/server.js");
		await serveMcp();
	});

program
	.command("import-dump <slug> [dir]")
	.description("Sort everything exported from the site (sites/<slug>/dump/ by default: plugin exports, builder settings, a backup's database.sql) into the places the phases read")
	.action(async (slug: string, dir: string | undefined) => {
		const items = await importDump(slug, dir);
		for (const it of items) console.log(`${it.ok ? pc.green("✔") : pc.yellow("!")} ${it.file.padEnd(48)} ${pc.dim(it.used)}`);
		if (!items.length) console.log(pc.yellow("The folder is empty."));
	});

program
	.command("import-options <slug> <dump>")
	.description("Read builder settings the REST API does not serve (Bricks palette, global classes, theme styles, components) from a backup's database.sql into raw/; credentials are dropped")
	.action(async (slug: string, dump: string) => {
		const r = await importOptions(slug, dump);
		console.log(`${pc.green("✔")} ${r.file}: ${r.found.join(", ") || "nothing found"}`);
		if (r.missing.length) console.log(pc.dim(`not in the dump: ${r.missing.join(", ")}`));
		if (r.dropped.length) console.log(pc.yellow(`left out (look like credentials): ${r.dropped.join(", ")}`));
		if (r.termSeo) console.log(`${pc.green("✔")} Rank Math term SEO for ${r.termSeo} term(s) → raw/seo-termmeta.json`);
	});

program
	.command("monitor <action>")
	.description("Outside-in monitor for every delivered site, one Cloudflare Worker in the agency's account (docs/monitor.md). init: write monitor.config.json; build: regenerate the Worker project (site list from sites/*/ + extra URLs). Never deploys")
	.option("--dir <path>", "monitor folder (default: <kit>/monitor, gitignored; or WP2EMDASH_MONITOR_DIR)")
	.option("--json")
	.action(async (action: string, o: { dir?: string; json?: boolean }) => {
		const { monitorBuild, monitorInit } = await import("../commands/monitor.js");
		const dir = o.dir ? { dir: o.dir } : {};
		if (action === "init") {
			const r = monitorInit(dir);
			if (o.json) return console.log(JSON.stringify(r, null, 2));
			console.log(r.created ? `${pc.green("+")} ${r.file}` : `${pc.dim("=")} ${r.file} ${pc.dim("(kept)")}`);
			console.log(pc.dim("Fill in alertTo, from (and extraUrls), then: pnpm wp2emdash monitor build"));
			return;
		}
		if (action !== "build") fail(`Unknown action "${action}" (init or build)`);
		try {
			const r = await monitorBuild(dir);
			if (o.json) return console.log(JSON.stringify(r, null, 2));
			for (const s of r.sites) console.log(`${pc.green("✔")} ${s.id.padEnd(28)} ${s.url}${s.keyword ? pc.dim(` (keyword)`) : ""}`);
			for (const s of r.skipped) console.log(`${pc.dim("–")} ${s.slug.padEnd(28)} ${pc.dim(s.why)}`);
			for (const w of r.warnings) console.log(`${pc.yellow("!")} ${w}`);
			console.log(`\n${pc.bold(r.dir)}: ${r.files.length} files. Deploy (the operator, from that folder): ${pc.cyan("npx wrangler deploy")} — see docs/monitor.md`);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("estimate <url>")
	.description("Sales estimate for a prospect's public WordPress site (no login, no init): client report + internal effort sheet in estimates/<host>-<date>/ (gitignored). Read-only, robots.txt respected, ≤ 4 requests at a time")
	.option("--rate <n>", "multiply the hours by this hourly rate (no pricing without it)")
	.option("--currency <code>", "label for --rate amounts, e.g. USD")
	.option("--lab", "add Google PageSpeed Insights for the home page (PAGESPEED_API_KEY or CRUX_API_KEY in the kit .env)")
	.option("--agency <name>", "agency name on the client report (default PixelKraft, or WP2EMDASH_AGENCY_NAME)")
	.option("--agency-url <url>", "agency link on the client report (or WP2EMDASH_AGENCY_URL)")
	.option("--contact <text>", "contact line on the client report (or WP2EMDASH_AGENCY_CONTACT)")
	.option("--rules <file>", "JSON file deep-merged over the effort rules (src/estimate/rules.ts)")
	.option("--out <dir>", "parent folder for the estimate (default <kit>/estimates or WP2EMDASH_ESTIMATES_DIR)")
	.option("--json", "print estimate.json to stdout (no progress output)")
	.action(async (url: string, o: { rate?: string; currency?: string; lab?: boolean; agency?: string; agencyUrl?: string; contact?: string; rules?: string; out?: string; json?: boolean }) => {
		const err = validateUrl(/^https?:\/\//i.test(url) ? url : `https://${url}`);
		if (err) fail(err);
		const rate = o.rate !== undefined ? Number(o.rate) : undefined;
		if (rate !== undefined && !(rate > 0)) fail("--rate must be a positive number");
		const { runEstimate } = await import("../commands/estimate.js");
		try {
			const r = await runEstimate(url, { ...(rate ? { rate } : {}), ...(o.currency ? { currency: o.currency } : {}), lab: !!o.lab, ...(o.agency ? { agency: o.agency } : {}), ...(o.agencyUrl ? { agencyUrl: o.agencyUrl } : {}), ...(o.contact ? { contact: o.contact } : {}), ...(o.rules ? { rulesFile: o.rules } : {}), ...(o.out ? { outRoot: o.out } : {}), quiet: !!o.json });
			if (o.json) return console.log(JSON.stringify(r.estimate, null, 2));
			const e = r.estimate;
			console.log(`\n${pc.bold(e.detections.host)}: ${e.effort.size}, ${pc.bold(`${e.effort.total[0]}–${e.effort.total[1]} h`)}${e.effort.cost ? ` (${e.effort.cost[0]}–${e.effort.cost[1]}${e.effort.currency ? ` ${e.effort.currency}` : ""})` : ""}`);
			for (const f of e.findings.filter((x) => x.level !== "info")) console.log(`  ${f.level === "blocker" ? pc.red("✖") : f.level === "decision" ? pc.yellow("!") : pc.cyan("•")} ${f.title}`);
			console.log(`\n${pc.dim(r.dir)}`);
			for (const f of r.files) console.log(`  ${f.slice(r.dir.length + 1)}`);
		} catch (e) {
			fail((e as Error).message);
		}
	});

program
	.command("doctor")
	.description("Check local prerequisites")
	.option("--json")
	.action(async (o) => {
		const checks = [...doctor(), await cloudflareTokenCheck(), encryptionKeyCheck()];
		if (o.json) return console.log(JSON.stringify(checks, null, 2));
		for (const c of checks) {
			const icon = c.ok ? pc.green("✔") : c.required ? pc.red("✖") : pc.yellow("!");
			console.log(`${icon} ${c.label.padEnd(30)} ${pc.dim(c.detail)}`);
		}
		if (checks.some((c) => c.required && !c.ok)) process.exit(1);
	});

if (process.argv.length <= 2) {
	await wizard();
} else {
	await program.parseAsync();
}
