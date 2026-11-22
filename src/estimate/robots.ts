/**
 * robots.txt for the estimate's crawler (RFC 9309): the group for our product token, else `*`; Allow/Disallow by
 * longest match (Allow wins a tie); `*` and `$` in patterns. Crawl-delay (not in the RFC, still common) is read too.
 */

export const ROBOTS_TOKEN = "wp2emdash";

interface Rule {
	allow: boolean;
	pattern: string;
}
interface Group {
	agents: string[];
	rules: Rule[];
	crawlDelay?: number;
}

function parse(txt: string): Group[] {
	const groups: Group[] = [];
	let cur: Group | undefined;
	let lastWasAgent = false;
	for (const raw of txt.split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, "").trim();
		const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = (m[1] as string).toLowerCase();
		const value = (m[2] as string).trim();
		if (key === "user-agent") {
			if (!cur || !lastWasAgent) {
				cur = { agents: [], rules: [] };
				groups.push(cur);
			}
			cur.agents.push(value.toLowerCase());
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (!cur) continue;
		if (key === "allow" || key === "disallow") {
			if (key === "disallow" && value === "") continue; // "Disallow:" (empty) allows everything
			cur.rules.push({ allow: key === "allow", pattern: value });
		} else if (key === "crawl-delay") {
			const n = Number(value);
			if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
		}
	}
	return groups;
}

function groupFor(groups: Group[], token: string): Group | undefined {
	const own = groups.filter((g) => g.agents.some((a) => a !== "*" && token.toLowerCase().includes(a)));
	const list = own.length ? own : groups.filter((g) => g.agents.includes("*"));
	if (!list.length) return undefined;
	// Several groups for the same agent combine (RFC 9309 §2.2.1).
	return { agents: [token], rules: list.flatMap((g) => g.rules), crawlDelay: list.find((g) => g.crawlDelay !== undefined)?.crawlDelay };
}

function toRegex(pattern: string): RegExp {
	const anchored = pattern.endsWith("$");
	const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Whether `url` (or a path) may be fetched by `token` under this robots.txt. No robots.txt: everything. Pure. */
export function robotsAllows(robotsTxt: string | undefined, url: string, token = ROBOTS_TOKEN): boolean {
	if (!robotsTxt) return true;
	let path: string;
	try {
		const u = new URL(url, "http://x");
		path = `${u.pathname}${u.search}`;
	} catch {
		return true;
	}
	if (path === "/robots.txt") return true;
	const g = groupFor(parse(robotsTxt), token);
	if (!g) return true;
	let best: Rule | undefined;
	for (const r of g.rules) {
		if (!toRegex(r.pattern).test(path)) continue;
		if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
	}
	return best ? best.allow : true;
}

/** Crawl-delay in seconds for `token` (undefined when none). Pure. */
export function robotsCrawlDelay(robotsTxt: string | undefined, token = ROBOTS_TOKEN): number | undefined {
	if (!robotsTxt) return undefined;
	return groupFor(parse(robotsTxt), token)?.crawlDelay;
}
