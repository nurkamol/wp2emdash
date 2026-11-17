#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { cloudflareTokenCheck, doctor } from "../commands/doctor.js";
import { initSite, validateSlug, validateUrl } from "../commands/init.js";
import { acceptPhase, runPhase } from "../commands/run.js";
import { formatTimeline, listSites, statusJson } from "../commands/status.js";
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
	.action((o) => {
		const err = validateSlug(o.slug) ?? validateUrl(o.source) ?? (o.production ? validateUrl(o.production) : undefined);
		if (err) fail(err);
		const res = initSite({
			slug: o.slug,
			name: o.name,
			sourceUrl: o.source,
			productionUrl: o.production ?? o.source,
			sensitiveData: !!o.sensitive,
		});
		console.log(pc.green(`Created ${res.root}`));
		console.log(`Next: complete the required items in ${pc.bold("ACCESS.md")}, then \`wp2emdash run ${o.slug} init\`.`);
	});

program
	.command("run")
	.description(`Run a phase (${PHASE_IDS.join(" → ")})`)
	.argument("<slug>")
	.argument("<phase>")
	.option("--json", "stream progress events as JSON lines")
	.option("--preview", "read-only phases: run out of order, don't record the gate")
	.action(async (slug: string, phase: string, o) => {
		if (!isPhaseId(phase)) fail(`Unknown phase "${phase}". Phases: ${PHASE_IDS.join(", ")}`);
		const result = await runPhase(slug, phase as never, { json: o.json, preview: o.preview }).catch((e: Error) => fail(e.message));
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
		for (const s of slugs) console.log(`${formatTimeline(readState(sitePaths(s).state))}\n`);
	});

program
	.command("phases")
	.description("List pipeline phases")
	.action(() => {
		for (const p of PHASES) console.log(`${pc.bold(p.id.padEnd(10))} ${p.milestone}  ${p.summary}`);
	});

program
	.command("doctor")
	.description("Check local prerequisites")
	.option("--json")
	.action(async (o) => {
		const checks = [...doctor(), await cloudflareTokenCheck()];
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
