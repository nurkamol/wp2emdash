/**
 * The dashboard's single page: a static HTML shell plus one CSS and one JS file, all served by the UI server
 * (no CDN, no build step). Data comes from /api/* as JSON and is rendered with textContent / DOM nodes only,
 * so nothing from a report is ever parsed as HTML.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");
const cache = new Map<string, string>();
const asset = (name: string) => {
	let s = cache.get(name);
	if (s === undefined) {
		s = readFileSync(join(ASSETS, name), "utf8");
		cache.set(name, s);
	}
	return s;
};

export const appJs = () => asset("app.js");
export const appCss = () => asset("app.css");

export function indexHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>wp2emdash dashboard</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:,">
</head>
<body>
<header class="top">
	<a class="brand" href="#/"><span class="logo" aria-hidden="true">W→E</span><span>wp2emdash</span><span class="muted">dashboard</span></a>
	<nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
	<button type="button" class="ghost" id="theme" aria-label="Toggle colour theme">Theme</button>
</header>
<main id="app" tabindex="-1"><p class="muted pad">Loading…</p></main>
<footer class="foot muted">Local only (127.0.0.1). Read-only except visual decisions, which are appended to <code>decisions.md</code>. Gates are accepted only with <code>wp2emdash accept</code>.</footer>
<script src="/app.js" defer></script>
</body>
</html>
`;
}
