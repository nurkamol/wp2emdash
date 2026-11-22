/**
 * Would pushing a branch (or opening a pull request from it) deploy anything? Read-only analysis of a client
 * repository's GitHub Actions workflows, used by `wp2emdash fleet upgrade-prs` before it creates, pushes or opens
 * anything (in client repos a push to main deploys, production on some sites).
 *
 * Conservative by design: a workflow the analysis cannot read, a reusable workflow it cannot see into, an unknown
 * trigger, or a job condition it cannot prove false all count as "may deploy". Only a job whose `if:` evaluates to
 * false for the event, or a workflow whose triggers do not fire for the event, is treated as safe.
 *
 * The YAML subset read here is what workflows use in practice (block mappings, block and flow lists, scalars); no
 * YAML library is needed for it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Events a branch push or a pull request can never fire. Anything else is assumed to fire. */
const UNRELATED_EVENTS = new Set(["workflow_dispatch", "schedule", "release", "repository_dispatch", "issues", "issue_comment", "watch", "fork", "page_build", "registry_package", "discussion", "discussion_comment", "label", "milestone", "project", "project_card", "project_column", "gollum", "public", "merge_group", "branch_protection_rule", "workflow_call", "deployment", "deployment_status", "pull_request_review", "pull_request_review_comment"]);

export interface CiEvent {
	/** "push" of `branch`, or "pull_request" from `branch` into `base`. */
	kind: "push" | "pull_request";
	branch: string;
	base: string;
}

export interface WorkflowFinding {
	file: string;
	/** Trigger names that fire for the event. */
	firedBy: string[];
	/** Jobs that look like deploys and would run. */
	deployJobs: string[];
	/** Why the file could not be read with confidence (counts as unsafe). */
	unreadable?: string;
}

export interface CiSafety {
	event: CiEvent;
	safe: boolean;
	reasons: string[];
	workflows: WorkflowFinding[];
}

// ── Minimal YAML (block structure) ──────────────────────────────────────────────────────────────────────
interface Line {
	indent: number;
	text: string;
}

function stripComment(s: string): string {
	let q: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			if (c === q) q = null;
		} else if (c === "'" || c === '"') q = c;
		else if (c === "#" && (i === 0 || /\s/.test(s[i - 1] as string))) return s.slice(0, i);
	}
	return s;
}

function toLines(src: string): Line[] {
	return src
		.replace(/\t/g, "  ")
		.split(/\r?\n/)
		.map((raw) => stripComment(raw).replace(/\s+$/, ""))
		.filter((l) => l.trim() !== "" && l.trim() !== "---")
		.map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
}

/** Lines nested under lines[i] (deeper indent), in order. */
function childLines(lines: Line[], i: number): Line[] {
	const base = (lines[i] as Line).indent;
	const out: Line[] = [];
	for (let j = i + 1; j < lines.length; j++) {
		const l = lines[j] as Line;
		if (l.indent <= base) break;
		out.push(l);
	}
	return out;
}

const KEY_RE = /^(["']?)([\w.-]+)\1\s*:(?:\s+(.*))?$/;

/** The direct `key: value` entries of a block (its first indent level), with their nested lines. */
function entries(block: Line[]): { key: string; value: string; children: Line[] }[] {
	if (!block.length) return [];
	const indent = Math.min(...block.map((l) => l.indent));
	const out: { key: string; value: string; children: Line[] }[] = [];
	for (let i = 0; i < block.length; i++) {
		const l = block[i] as Line;
		if (l.indent !== indent) continue;
		const m = KEY_RE.exec(l.text);
		if (!m) continue;
		out.push({ key: m[2] as string, value: (m[3] ?? "").trim(), children: childLines(block, i) });
	}
	return out;
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

/** A scalar list: `[a, b]`, `a`, or block items `- a`. */
function list(value: string, children: Line[]): string[] {
	if (value.startsWith("[")) return value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
	if (value && !/^[|>]/.test(value)) return [unquote(value)];
	return children.filter((l) => l.text.startsWith("- ")).map((l) => unquote(l.text.slice(2)));
}

/** A scalar that may be a block scalar (`|` / `>`): its text on one line. */
function scalar(value: string, children: Line[]): string {
	if (/^[|>][-+]?$/.test(value)) return children.map((l) => l.text).join(" ");
	return unquote(value);
}

// ── Branch filters (GitHub glob syntax: *, **, ?, leading ! negates; last match wins) ──────────────────
export function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i] as string;
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				re += ".*";
				i++;
			} else re += "[^/]*";
		} else if (c === "?") re += ".";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

function matchesFilter(branch: string, patterns: string[]): boolean {
	let hit = false;
	for (const p of patterns) {
		if (p.startsWith("!")) {
			if (globToRegExp(p.slice(1)).test(branch)) hit = false;
		} else if (globToRegExp(p).test(branch)) hit = true;
	}
	return hit;
}

/** Does a trigger with these filters fire for `ref`? */
function filterAllows(filters: { key: string; value: string; children: Line[] }[], kind: "branches" | "tags", ref: string): boolean {
	const inc = filters.find((f) => f.key === kind);
	const exc = filters.find((f) => f.key === `${kind}-ignore`);
	if (inc) return matchesFilter(ref, list(inc.value, inc.children));
	if (exc) return !matchesFilter(ref, list(exc.value, exc.children));
	return true;
}

// ── Triggers ────────────────────────────────────────────────────────────────────────────────────────────
/** Trigger names that fire for the event, or a string explaining why the `on:` block could not be read. */
export function firedTriggers(lines: Line[], ev: CiEvent): string[] | { unreadable: string } {
	const top = lines.findIndex((l) => l.indent === 0 && /^(["']?)(on|true)\1\s*:/.test(l.text));
	if (top < 0) return { unreadable: "no `on:` triggers found" };
	const rest = (lines[top] as Line).text.replace(/^(["']?)(on|true)\1\s*:\s*/, "");
	let triggers: { key: string; value: string; children: Line[] }[];
	if (rest) {
		if (rest.startsWith("{")) return { unreadable: "flow-style `on:` mapping" };
		triggers = list(rest, []).map((key) => ({ key, value: "", children: [] }));
	} else {
		const block = childLines(lines, top);
		const items = block.filter((l) => l.text.startsWith("- "));
		triggers = items.length && items.length === block.length ? items.map((l) => ({ key: unquote(l.text.slice(2)), value: "", children: [] })) : entries(block);
	}
	const fired: string[] = [];
	for (const t of triggers) {
		if (UNRELATED_EVENTS.has(t.key)) continue;
		const filters = entries(t.children);
		if (t.key === "push") {
			if (ev.kind !== "push") continue;
			const hasBranches = filters.some((f) => f.key === "branches" || f.key === "branches-ignore");
			const hasTags = filters.some((f) => f.key === "tags" || f.key === "tags-ignore");
			if (!hasBranches && hasTags) continue; // tags only: a branch push does not fire it
			if (filterAllows(filters, "branches", ev.branch)) fired.push("push");
		} else if (t.key === "pull_request" || t.key === "pull_request_target") {
			if (ev.kind !== "pull_request") continue;
			// Branch filters on pull_request match the base branch.
			if (filterAllows(filters, "branches", ev.base)) fired.push(t.key);
		} else if (t.key === "workflow_run") {
			if (filterAllows(filters, "branches", ev.branch)) fired.push("workflow_run");
		} else fired.push(t.key); // create, check_suite, status, …: assume it fires
	}
	return fired;
}

// ── Job conditions: a small evaluator for GitHub expressions, three-valued (true / false / unknown) ─────
type Val = string | number | boolean | null | undefined; // undefined = unknown
type Tok = { t: "str" | "num" | "id" | "op" | "punc"; v: string };

function tokenize(s: string): Tok[] | undefined {
	const out: Tok[] = [];
	let i = 0;
	while (i < s.length) {
		const c = s[i] as string;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "'") {
			let j = i + 1;
			let v = "";
			while (j < s.length) {
				if (s[j] === "'" && s[j + 1] === "'") {
					v += "'";
					j += 2;
				} else if (s[j] === "'") break;
				else v += s[j++];
			}
			if (j >= s.length) return undefined;
			out.push({ t: "str", v });
			i = j + 1;
			continue;
		}
		const two = s.slice(i, i + 2);
		if (["==", "!=", "&&", "||", "<=", ">="].includes(two)) {
			out.push({ t: "op", v: two });
			i += 2;
			continue;
		}
		if ("!<>".includes(c)) {
			out.push({ t: "op", v: c });
			i++;
			continue;
		}
		if ("(),".includes(c)) {
			out.push({ t: "punc", v: c });
			i++;
			continue;
		}
		const num = /^-?\d+(\.\d+)?/.exec(s.slice(i));
		if (num) {
			out.push({ t: "num", v: num[0] });
			i += num[0].length;
			continue;
		}
		const id = /^[A-Za-z_][\w-]*(\.[\w-]+|\[\s*'[^']*'\s*\]|\.\*)*/.exec(s.slice(i));
		if (id) {
			out.push({ t: "id", v: id[0] });
			i += id[0].length;
			continue;
		}
		return undefined;
	}
	return out;
}

const truthy = (v: Val): boolean | undefined => (v === undefined ? undefined : !!v && v !== "" && v !== 0);
const eq = (a: Val, b: Val): boolean | undefined => {
	if (a === undefined || b === undefined) return undefined;
	if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
	if (a === null || b === null) return a === b || (a === null && b === "") || (b === null && a === "");
	return a == b; // GitHub coerces mixed types loosely
};
const and = (a: boolean | undefined, b: boolean | undefined) => (a === false || b === false ? false : a === undefined || b === undefined ? undefined : true);
const or = (a: boolean | undefined, b: boolean | undefined) => (a === true || b === true ? true : a === undefined || b === undefined ? undefined : false);

/** The contexts known for the event; everything else (vars, secrets, needs, steps…) is unknown. */
function contextValue(path: string, ev: CiEvent): Val {
	const p = path.replace(/\[\s*'([^']*)'\s*\]/g, ".$1").toLowerCase();
	const event = ev.kind;
	const known: Record<string, Val> = {
		"github.event_name": event,
		"github.ref": event === "push" ? `refs/heads/${ev.branch}` : "refs/pull/0/merge",
		"github.ref_name": event === "push" ? ev.branch : "0/merge",
		"github.head_ref": event === "pull_request" ? ev.branch : "",
		"github.base_ref": event === "pull_request" ? ev.base : "",
		"github.ref_type": "branch",
	};
	if (p in known) return known[p];
	// workflow_dispatch inputs are empty on push / pull_request events.
	if (p.startsWith("inputs.") || p.startsWith("github.event.inputs.")) return null;
	return undefined;
}

/** Evaluate an `if:` expression for the event: true, false, or undefined (cannot tell). */
export function evaluateCondition(expr: string, ev: CiEvent): boolean | undefined {
	let s = expr.trim();
	const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
	if (wrapped) s = wrapped[1] as string;
	else if (s.includes("${{")) return undefined; // mixed literal + expression: GitHub treats as a string (truthy)
	const toks = tokenize(s);
	if (!toks) return undefined;
	let i = 0;
	const peek = () => toks[i];
	const take = () => toks[i++];
	const fail = Symbol("fail");
	type R = Val | typeof fail;

	function primary(): R {
		const t = take();
		if (!t) return fail;
		if (t.t === "str") return t.v;
		if (t.t === "num") return Number(t.v);
		if (t.t === "punc" && t.v === "(") {
			const v = orExpr();
			if (take()?.v !== ")") return fail;
			return v;
		}
		if (t.t === "op" && t.v === "!") {
			const v = primary();
			if (v === fail) return fail;
			const b = truthy(v);
			return b === undefined ? undefined : !b;
		}
		if (t.t === "id") {
			if (t.v === "true") return true;
			if (t.v === "false") return false;
			if (t.v === "null") return null;
			if (peek()?.v === "(") {
				take();
				const args: Val[] = [];
				if (peek()?.v !== ")") {
					for (;;) {
						const a = orExpr();
						if (a === fail) return fail;
						args.push(a);
						if (peek()?.v === ",") take();
						else break;
					}
				}
				if (take()?.v !== ")") return fail;
				const fn = t.v.toLowerCase();
				const [a, b] = args;
				if (fn === "success" || fn === "always" || fn === "failure" || fn === "cancelled") return undefined;
				if (a === undefined || b === undefined) return undefined;
				const sa = String(a ?? "").toLowerCase();
				const sb = String(b ?? "").toLowerCase();
				if (fn === "contains") return sa.includes(sb);
				if (fn === "startswith") return sa.startsWith(sb);
				if (fn === "endswith") return sa.endsWith(sb);
				return undefined;
			}
			return contextValue(t.v, ev);
		}
		return fail;
	}
	function cmp(): R {
		const left = primary();
		if (left === fail) return fail;
		const op = peek();
		if (op?.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(op.v)) {
			take();
			const right = primary();
			if (right === fail) return fail;
			if (op.v === "==") return eq(left, right);
			if (op.v === "!=") {
				const e = eq(left, right);
				return e === undefined ? undefined : !e;
			}
			return undefined;
		}
		return left;
	}
	function andExpr(): R {
		let v = cmp();
		while (v !== fail && peek()?.v === "&&") {
			take();
			const r = cmp();
			if (r === fail) return fail;
			v = and(truthy(v), truthy(r));
		}
		return v;
	}
	function orExpr(): R {
		let v = andExpr();
		while (v !== fail && peek()?.v === "||") {
			take();
			const r = andExpr();
			if (r === fail) return fail;
			v = or(truthy(v), truthy(r));
		}
		return v;
	}
	const v = orExpr();
	if (v === fail || i !== toks.length) return undefined;
	return truthy(v);
}

// ── Deploy jobs ─────────────────────────────────────────────────────────────────────────────────────────
const DEPLOY_PATTERNS: RegExp[] = [
	/\bwrangler(?:@[\w.^~-]+)?\s+(?:deploy|publish|versions\s+(?:deploy|upload)|pages\s+deploy|rollback|d1\s+migrations\s+apply)\b/i,
	/cloudflare\/wrangler-action/i,
	/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:ci:)?(?:deploy|versions:(?:deploy|upload))[\w:-]*/i,
	/\bemdash\s+migrate\b/i,
];

/** Why a job counts as a deploy, or undefined. */
export function deployReason(jobLines: Line[]): string | undefined {
	const props = entries(jobLines);
	const uses = props.find((p) => p.key === "uses");
	if (uses) return `calls the reusable workflow ${unquote(uses.value)} (not inspected)`;
	const env = props.find((p) => p.key === "environment");
	const text = jobLines.map((l) => l.text).join("\n");
	const hit = DEPLOY_PATTERNS.find((re) => re.test(text));
	if (hit) return `runs ${(hit.exec(text) as RegExpExecArray)[0].trim()}`;
	if (env) return `uses the GitHub environment ${scalar(env.value, env.children) || "(named below)"}`;
	return undefined;
}

export function analyzeWorkflow(file: string, src: string, ev: CiEvent): WorkflowFinding {
	const lines = toLines(src);
	const fired = firedTriggers(lines, ev);
	if (!Array.isArray(fired)) return { file, firedBy: [], deployJobs: [], unreadable: fired.unreadable };
	if (!fired.length) return { file, firedBy: [], deployJobs: [] };
	const top = lines.findIndex((l) => l.indent === 0 && /^(["']?)jobs\1\s*:\s*$/.test(l.text));
	if (top < 0) return { file, firedBy: fired, deployJobs: [], unreadable: "no `jobs:` block found" };
	const deployJobs: string[] = [];
	for (const job of entries(childLines(lines, top))) {
		const why = deployReason(job.children);
		if (!why) continue;
		const cond = entries(job.children).find((p) => p.key === "if");
		const runs = cond ? evaluateCondition(scalar(cond.value, cond.children), ev) : true;
		if (runs !== false) deployJobs.push(`${job.key} (${why}${cond ? (runs === undefined ? "; its if: cannot be proven false for this event" : "; its if: is true for this event") : "; no if: condition"})`);
	}
	return { file, firedBy: fired, deployJobs };
}

/** Every workflow in <repo>/.github/workflows checked for the event. */
export function ciSafety(repo: string, ev: CiEvent): CiSafety {
	const dir = join(repo, ".github", "workflows");
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort() : [];
	const workflows = files.map((f) => {
		try {
			return analyzeWorkflow(`.github/workflows/${f}`, readFileSync(join(dir, f), "utf8"), ev);
		} catch (e) {
			return { file: `.github/workflows/${f}`, firedBy: [], deployJobs: [], unreadable: (e as Error).message };
		}
	});
	const what = ev.kind === "push" ? `a push of ${ev.branch}` : `a pull request from ${ev.branch} into ${ev.base}`;
	const reasons = workflows.flatMap((w) => [...(w.unreadable ? [`${w.file}: could not be read with confidence (${w.unreadable})`] : []), ...w.deployJobs.map((j) => `${w.file}: ${what} (${w.firedBy.join(", ")}) runs deploy job ${j}`)]);
	return { event: ev, safe: reasons.length === 0, reasons, workflows };
}
