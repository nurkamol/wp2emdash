/**
 * Which kit built a client project. The scaffold writes `.wp2emdash.json` at the project root (committed with the
 * project): the kit version, the build time and the version of every @wp2emdash/* package copied into packages/.
 * `wp2emdash fleet` reads it to tell how far behind a delivered site is.
 *
 * Projects built before the marker existed have no kit version on record; their package versions are still known
 * from packages/<name>/package.json (the scaffold copies each package with its package.json).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ROOT } from "./paths.js";

export const BUILD_MARKER = ".wp2emdash.json";

export interface BuildMarker {
	/** Kit version (package.json of the kit that ran scaffold). */
	kit: string;
	/** ISO time of the scaffold run that wrote the file. */
	builtAt: string;
	/** @wp2emdash/* package → version, as copied into the project. */
	packages: Record<string, string>;
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
	} catch {
		return undefined;
	}
};

export function kitVersion(kitRoot = KIT_ROOT): string | undefined {
	return readJson<{ version?: string }>(join(kitRoot, "package.json"))?.version;
}

/** name → version of every package under <dir>/packages/*. */
export function packageVersions(dir: string): Record<string, string> {
	const base = join(dir, "packages");
	if (!existsSync(base)) return {};
	const out: Record<string, string> = {};
	for (const d of readdirSync(base, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		const p = readJson<{ name?: string; version?: string }>(join(base, d.name, "package.json"));
		if (p?.name && p.version) out[p.name] = p.version;
	}
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildMarker(project: string, o: { kitRoot?: string; now?: Date } = {}): BuildMarker {
	return { kit: kitVersion(o.kitRoot) ?? "0.0.0", builtAt: (o.now ?? new Date()).toISOString(), packages: packageVersions(project) };
}

export function writeBuildMarker(project: string, o: { kitRoot?: string; now?: Date } = {}): BuildMarker {
	const m = buildMarker(project, o);
	writeFileSync(join(project, BUILD_MARKER), `${JSON.stringify(m, null, 2)}\n`);
	return m;
}

export function readBuildMarker(project: string): BuildMarker | undefined {
	const m = readJson<Partial<BuildMarker>>(join(project, BUILD_MARKER));
	if (!m || typeof m.kit !== "string") return undefined;
	return { kit: m.kit, builtAt: typeof m.builtAt === "string" ? m.builtAt : "", packages: m.packages && typeof m.packages === "object" ? (m.packages as Record<string, string>) : {} };
}

export interface VersionGap {
	status: "current" | "behind" | "ahead" | "unknown";
	major: number;
	minor: number;
	patch: number;
	/** "current", "behind by 2 minor versions", "1 major version behind", "unknown", … */
	text: string;
}

const parse = (v: string | undefined) => {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** How far `built` is behind `current` (semver, pre-release tags ignored). */
export function versionGap(built: string | undefined, current: string | undefined): VersionGap {
	const a = parse(built);
	const b = parse(current);
	if (!a || !b) return { status: "unknown", major: 0, minor: 0, patch: 0, text: built ? `unknown (${built})` : "unknown" };
	const [ma, mi, pa] = a as [number, number, number];
	const [mb, mj, pb] = b as [number, number, number];
	const cmp = ma !== mb ? mb - ma : mi !== mj ? mj - mi : pb - pa;
	if (cmp === 0) return { status: "current", major: 0, minor: 0, patch: 0, text: "current" };
	if (cmp < 0) return { status: "ahead", major: 0, minor: 0, patch: 0, text: `ahead of the kit (${built})` };
	const plural = (n: number, w: string) => `${n} ${w} version${n === 1 ? "" : "s"}`;
	if (mb > ma) return { status: "behind", major: mb - ma, minor: 0, patch: 0, text: `${plural(mb - ma, "major")} behind` };
	if (mj > mi) return { status: "behind", major: 0, minor: mj - mi, patch: 0, text: `behind by ${plural(mj - mi, "minor")}` };
	return { status: "behind", major: 0, minor: 0, patch: pb - pa, text: `behind by ${plural(pb - pa, "patch")}` };
}
