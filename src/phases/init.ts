import { readFileSync } from "node:fs";
import type { GateCheck } from "../core/state.js";
import type { PhaseContext } from "./index.js";

export interface ChecklistItem {
	text: string;
	done: boolean;
	required: boolean;
	section: string;
}

/** Parses "- [ ] (required) text" / "- [x] text" lines under "## Section" headings. */
export function parseChecklist(markdown: string): ChecklistItem[] {
	const items: ChecklistItem[] = [];
	let section = "";
	for (const line of markdown.split("\n")) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading?.[1]) {
			section = heading[1];
			continue;
		}
		const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
		if (!m?.[2]) continue;
		const required = /^\(required\)\s*/i.test(m[2]);
		items.push({
			text: m[2].replace(/^\(required\)\s*/i, "").trim(),
			done: m[1]?.toLowerCase() === "x",
			required,
			section,
		});
	}
	return items;
}

/** Gate: every (required) item in the "Before audit" section of ACCESS.md is ticked. */
export async function runInitGate({ paths, reporter }: PhaseContext): Promise<GateCheck[]> {
	reporter.emit({ type: "step:start", step: "Read ACCESS.md checklist" });
	const items = parseChecklist(readFileSync(paths.access, "utf8")).filter(
		(i) => i.required && i.section.toLowerCase() === "before audit",
	);
	const checks = items.map<GateCheck>((i, n) => ({
		id: `access-${n + 1}`,
		label: i.text,
		ok: i.done,
		detail: i.done ? undefined : "tick it in ACCESS.md once done",
	}));
	const open = checks.filter((c) => !c.ok).length;
	reporter.emit({
		type: "step:end",
		step: "Read ACCESS.md checklist",
		ok: open === 0,
		detail: open ? `${open} required item(s) open` : `${checks.length} required items done`,
	});
	if (checks.length === 0) {
		return [{ id: "access-missing", label: "ACCESS.md has required items", ok: false, detail: "no (required) items found" }];
	}
	return checks;
}
