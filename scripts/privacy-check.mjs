#!/usr/bin/env node
/**
 * Privacy check: this repository is public, so no client name, domain, address or email may enter it.
 *
 * Patterns come from places that are never committed:
 *   - every local client workspace `sites/<slug>/` (its folder name, kit.config.ts `name`, every domain and email in it),
 *     and the agency monitor config (`monitor/*.json`), read from the main checkout so worktrees are covered too;
 *   - `.privacy-patterns` (gitignored): one regular expression per line, `#` comments;
 *   - the environment variable PRIVACY_PATTERNS (newline-separated; the GitHub secret of the same name in CI).
 * Plus generic rules that need no list: email addresses outside the allowlist below.
 *
 * Only the matching file, line number and rule are printed, never the matched private text.
 *
 *   node scripts/privacy-check.mjs            every tracked file (CI)
 *   node scripts/privacy-check.mjs --staged   the staged version of staged files (pre-commit hook)
 *   node scripts/privacy-check.mjs --range A..B   files changed between two commits, at B
 * Exit 0 clean · 1 matches found · 2 usage error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const mode = args.includes("--staged") ? "staged" : args.includes("--range") ? "range" : "all";
const range = mode === "range" ? args[args.indexOf("--range") + 1] : "";
if (mode === "range" && !/^[\w./^~-]+\.\.[\w./^~-]+$/.test(range ?? "")) {
	console.error("usage: privacy-check.mjs [--staged | --range A..B]");
	process.exit(2);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const top = git("rev-parse", "--show-toplevel").trim();
// Worktrees share the main checkout's git dir; client workspaces live only in the main checkout.
const mainRoot = resolve(dirname(resolve(top, git("rev-parse", "--git-common-dir").trim())));

/** Hosts and addresses that are public by design (the agency, examples, platforms). */
const ALLOW_HOST =
	/(^|\.)(example\.(com|org|net)|[\w-]+\.example|[\w-]+\.test|localhost|pixelkraft\.(net|com|workers\.dev)|workers\.dev|pages\.dev|github\.(com|io)|githubusercontent\.com|cloudflare\.com|emdashcms\.com|wordpress\.(org|com)|w3\.org|schema\.org|googleapis\.com|gstatic\.com|google\.com|npmjs\.com|anthropic\.com|claude\.ai|users\.noreply\.github\.com)$/i;
// Reserved / placeholder domains (RFC 2606, RFC 6761), the agency's public test inbox, one-letter test addresses.
const ALLOW_EMAIL =
	/^(dev@pixelkraft\.net|git@github\.com|[^@]+@([\w.-]+\.)?(example\.(com|org|net)|example|test|invalid|local|localhost)|noreply@client\.com|[a-z]@[a-z]\.(co|com)|noreply@anthropic\.com|[^@]+@users\.noreply\.github\.com)$/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rules = new Map(); // regex source -> label (labels never contain the private text)

function addLiteral(text, label) {
	const t = text.trim();
	if (t.length < 5) return;
	rules.set(escape(t).replace(/\s+/g, "[\\s-]*"), label);
}

function fromWorkspace(dir, slug) {
	addLiteral(slug, `client workspace name (sites/${slug})`);
	for (const f of ["kit.config.ts", "cloudflare.json"]) {
		const p = join(dir, f);
		if (!existsSync(p)) continue;
		const src = readFileSync(p, "utf8");
		const name = src.match(/^\s*name:\s*["'`]([^"'`]+)["'`]/m)?.[1];
		if (name) {
			const clean = name.replace(/\([^)]*\)/g, "").trim();
			addLiteral(clean, `client name (sites/${slug})`);
			// Two-word runs ("Acme Yoga" out of "Acme Yoga Springfield") — a leak rarely spells the full name.
			const words = clean.split(/\s+/);
			for (let i = 0; i + 1 < words.length; i++) addLiteral(`${words[i]} ${words[i + 1]}`, `part of a client name (sites/${slug})`);
		}
		collectHostsAndEmails(src, `sites/${slug}/${f}`);
	}
}

function collectHostsAndEmails(src, where) {
	for (const m of src.matchAll(/[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
		if (!ALLOW_EMAIL.test(m[0])) addLiteral(m[0], `client email (${where})`);
	}
	for (const m of src.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|net|org|co|io|us|uk|de|fr|nl|es|ca|au|app|dev|studio|health|clinic|biz|info))\b/gi)) {
		const host = m[1].toLowerCase().replace(/^www\./, "");
		if (ALLOW_HOST.test(host)) continue;
		addLiteral(host, `client domain (${where})`);
		const label = host.split(".").at(-2) ?? "";
		if (label.length >= 8) addLiteral(label, `client domain name (${where})`);
	}
}

const sitesDir = join(mainRoot, "sites");
if (existsSync(sitesDir)) {
	for (const slug of readdirSync(sitesDir)) {
		const dir = join(sitesDir, slug);
		if (statSync(dir).isDirectory()) fromWorkspace(dir, slug);
	}
}
const monitorDir = join(mainRoot, "monitor");
if (existsSync(monitorDir)) {
	for (const f of readdirSync(monitorDir).filter((f) => f.endsWith(".json"))) collectHostsAndEmails(readFileSync(join(monitorDir, f), "utf8"), `monitor/${f}`);
}
const extra = [
	...(existsSync(join(mainRoot, ".privacy-patterns")) ? readFileSync(join(mainRoot, ".privacy-patterns"), "utf8").split("\n") : []),
	...(process.env.PRIVACY_PATTERNS ?? "").split("\n"),
];
let n = 0;
for (const line of extra) {
	const t = line.trim();
	if (!t || t.startsWith("#")) continue;
	try {
		new RegExp(t, "i");
		rules.set(t, `private pattern #${++n}`);
	} catch {
		console.error(`privacy-check: private pattern #${++n} is not a valid regular expression (skipped)`);
	}
}

/** Files that legitimately hold allowlists or patterns about privacy itself. */
const SKIP = new Set(["scripts/privacy-check.mjs", "test/privacy-check.test.ts", "pnpm-lock.yaml"]);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|zip|gz|pdf|mp4|webm|wasm)$/i;

let files;
if (mode === "staged") files = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0");
else if (mode === "range") files = git("diff", "--name-only", "--diff-filter=ACMR", "-z", range).split("\0");
else files = git("ls-files", "-z").split("\0");
files = files.filter((f) => f && !SKIP.has(f) && !f.startsWith("sites/") || f === "sites/README.md");

const read = (f) => {
	if (mode === "staged") return git("show", `:${f}`);
	if (mode === "range") return git("show", `${range.split("..")[1]}:${f}`);
	return readFileSync(join(top, f), "utf8");
};

const compiled = [...rules].map(([src, label]) => ({ re: new RegExp(src, "i"), label }));
const hits = [];
for (const f of files) {
	if (!f) continue;
	for (const { re, label } of compiled) if (re.test(f)) hits.push(`${f}: file name — ${label}`);
	if (BINARY.test(f)) continue;
	let text;
	try {
		text = read(f);
	} catch {
		continue;
	}
	if (text.includes("\0")) continue;
	text.split("\n").forEach((line, i) => {
		for (const { re, label } of compiled) if (re.test(line)) hits.push(`${f}:${i + 1} — ${label}`);
		for (const m of line.matchAll(/[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|edu|gov|io|co|us|uk|de|fr|nl|es|it|ca|au|ch|at|be|se|no|dk|fi|pl|pt|ie|nz|in|jp|ru|br|mx|ae|uz|kz|app|dev|me|info|biz|studio|health|clinic|agency|design|shop|online|site|email|xyz|example|test|invalid|local|localhost)\b/gi)) {
			if (/^[\w-]+@[\d.]+$/.test(m[0]) || /@(\d|v?\d+\.)/.test(m[0])) continue; // package@1.2.3
			if (/^@?[\w-]+\/[\w-]+@/.test(m[0])) continue;
			if (!ALLOW_EMAIL.test(m[0]) && !/@[\w-]+\.(js|ts|mjs|css|json|png|svg|webp|jpe?g)$/i.test(m[0])) hits.push(`${f}:${i + 1} — email address outside the allowlist`);
		}
	});
}

const unique = [...new Set(hits)];
if (unique.length) {
	console.error(`privacy-check: ${unique.length} possible private item(s) — this repository is public.`);
	for (const h of unique.slice(0, 100)) console.error(`  ${h}`);
	if (unique.length > 100) console.error(`  … and ${unique.length - 100} more`);
	console.error("Remove them (use example.com / Example Studio style data). The matched text is not printed on purpose.");
	process.exit(1);
}
console.log(`privacy-check: clean (${files.length} file(s), ${compiled.length} private pattern(s) + email rule).`);
