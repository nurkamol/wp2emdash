#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { cloudflareTokenCheck, doctor, encryptionKeyCheck } from "../commands/doctor.js";
import { provision } from "../commands/provision.js";
import { importOptions } from "../commands/import-options.js";
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
		for (const s of slugs) {
			const p = sitePaths(s);
			console.log(`${formatTimeline(readState(p.state))}\n  ${pc.dim(`project: ${p.project}${p.project.startsWith(p.root) ? "" : " (projectDir)"}`)}\n`);
		}
	});

program
	.command("phases")
	.description("List pipeline phases")
	.action(() => {
		for (const p of PHASES) console.log(`${pc.bold(p.id.padEnd(10))} ${p.milestone}  ${p.summary}`);
	});

program
	.command("provision <slug> <env>")
	.description("Create an environment's Cloudflare resources (D1, R2, KV outbox) in its account and record them in cloudflare.json")
	.option("--location <hint>", "D1/R2 location: enam, wnam, weur, eeur, apac, oc (default: the environment's current one, else enam)")
	.option("--json")
	.action(async (slug: string, env: string, o: { location?: string; json?: boolean }) => {
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
	.description("MCP server on stdio for Claude Code: status, run_phase, read_report, list_diagnostics, explain_gate, propose_override")
	.action(async () => {
		const { serveMcp } = await import("../mcp/server.js");
		await serveMcp();
	});

program
	.command("import-options <slug> <dump>")
	.description("Read builder settings the REST API does not serve (Bricks palette, global classes, theme styles, components) from a backup's database.sql into raw/; credentials are dropped")
	.action(async (slug: string, dump: string) => {
		const r = await importOptions(slug, dump);
		console.log(`${pc.green("✔")} ${r.file}: ${r.found.join(", ") || "nothing found"}`);
		if (r.missing.length) console.log(pc.dim(`not in the dump: ${r.missing.join(", ")}`));
		if (r.dropped.length) console.log(pc.yellow(`left out (look like credentials): ${r.dropped.join(", ")}`));
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
