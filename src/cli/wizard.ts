import * as p from "@clack/prompts";
import pc from "picocolors";
import { initSite, validateSlug, validateUrl } from "../commands/init.js";
import { acceptPhase, runPhase } from "../commands/run.js";
import { formatTimeline, listSites } from "../commands/status.js";
import { preferredMode, rememberMode, serveUi, type WorkMode } from "../commands/ui.js";
import { sitePaths } from "../core/paths.js";
import { getPhase } from "../core/phases.js";
import { nextPhase, readState } from "../core/state.js";

const cancelled = (v: unknown): v is symbol => p.isCancel(v);

/** Interactive multi-step flow: pick or create a site, see the timeline, run the next phase. */
export async function wizard(): Promise<void> {
	p.intro(pc.bgCyan(pc.black(" wp2emdash ")));

	// Terminal-friendly or web-friendly: asked once, remembered locally; WP2EMDASH_MODE skips the question.
	const pref = preferredMode();
	let mode: WorkMode | undefined = pref.fromEnv ? pref.mode : undefined;
	if (!mode) {
		const picked = await p.select({
			message: "How do you want to work?",
			initialValue: pref.mode ?? "terminal",
			options: [
				{ value: "terminal", label: "Terminal", hint: "guided steps here: create a site, run each phase, accept gates" },
				{ value: "web", label: "Web dashboard", hint: "opens in your browser: sites, launch readiness, live runs, visual review (phases still run from the terminal)" },
			],
		});
		if (cancelled(picked)) return p.cancel("Bye.");
		mode = picked as WorkMode;
		rememberMode(mode);
	}
	if (mode === "web") {
		p.outro(`Starting the dashboard ${pc.dim("(WP2EMDASH_MODE=terminal skips this choice next time)")}`);
		return serveUi();
	}

	const sites = listSites();
	const choice = await p.select({
		message: "Which site?",
		options: [
			...sites.map((s) => ({ value: s, label: s })),
			{ value: "__new", label: pc.green("+ New site") },
		],
	});
	if (cancelled(choice)) return p.cancel("Bye.");

	let slug = choice as string;
	if (slug === "__new") {
		// A sibling site (same studio, another domain) starts from an existing site's config, overrides and decisions.
		let from: string | undefined;
		if (sites.length) {
			const start = await p.select({
				message: "Start from",
				options: [
					{ value: "__blank", label: "A blank site" },
					...sites.map((s) => ({ value: s, label: `An existing site: ${s}`, hint: "copies kit.config.ts, overrides.ts and decisions.md only" })),
				],
			});
			if (cancelled(start)) return p.cancel("Bye.");
			if (start !== "__blank") from = start as string;
		}
		const answers = await p.group(
			{
				name: () => p.text({ message: "Client / site name", placeholder: "Acme Clinic" }),
				slug: () => p.text({ message: "Short id (folder name)", placeholder: "acme", validate: (v) => validateSlug(v ?? "") }),
				sourceUrl: () =>
					p.text({ message: "Live WordPress URL", placeholder: "https://example.com", validate: (v) => validateUrl(v ?? "") }),
				productionUrl: ({ results }) =>
					p.text({
						message: "Production URL after migration",
						initialValue: results.sourceUrl as string,
						validate: (v) => validateUrl(v ?? ""),
					}),
				sensitiveData: () =>
					from
						? Promise.resolve(false) // unused: the copied config keeps the other site's sensitiveData
						: p.confirm({ message: "Does the site handle sensitive data (health, legal, finance)?", initialValue: false }),
			},
			{ onCancel: () => p.cancel("Cancelled.") },
		);
		let res: ReturnType<typeof initSite>;
		try {
			res = initSite(answers as never, undefined, from);
		} catch (e) {
			p.log.error((e as Error).message);
			return p.outro("Nothing was created.");
		}
		slug = answers.slug as string;
		p.note(res.created.map((f) => f.replace(`${res.root}/`, "")).join("\n"), `Created sites/${slug}`);
		p.log.info(`Next: complete ${pc.bold(`sites/${slug}/ACCESS.md`)} (required items), then run the init gate.`);
	}

	for (;;) {
		const state = readState(sitePaths(slug).state);
		p.log.message(formatTimeline(state));
		const next = nextPhase(state);
		if (!next) {
			p.outro(`${pc.green("All phases complete.")} ${pc.dim(`Built with an older kit? \`wp2emdash upgrade ${slug}\` rebuilds it and compares every live page.`)}`);
			return;
		}
		const current = state.phases[next];
		const options = [
			{ value: "run", label: `Run ${pc.bold(next)} — ${getPhase(next).summary}` },
			...(current?.status === "failed" ? [{ value: "accept", label: pc.yellow(`Accept failed ${next} gate with a reason`) }] : []),
			{ value: "quit", label: "Quit" },
		];
		const action = await p.select({ message: "Next step", options });
		if (cancelled(action) || action === "quit") return p.outro("State saved. Run `wp2emdash` again to continue.");

		if (action === "accept") {
			const reason = await p.text({ message: "Why is this acceptable? (recorded in decisions.md)" });
			if (cancelled(reason)) continue;
			const by = await p.text({ message: "Approved by (name/role)" });
			if (cancelled(by)) continue;
			try {
				acceptPhase(slug, next, reason, by);
				p.log.success(`Accepted ${next}.`);
			} catch (e) {
				p.log.error((e as Error).message);
			}
			continue;
		}

		const result = await runPhase(slug, next);
		if (result.notImplemented) {
			p.outro(pc.yellow(`${next} is not built yet (${getPhase(next).milestone}). Progress saved.`));
			return;
		}
		if (!result.ok) p.log.warn(`Fix the failing checks above, then run ${next} again.`);
	}
}
