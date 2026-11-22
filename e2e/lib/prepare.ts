/**
 * Host-side preparation before Docker starts: the seed plan as JSON, the PNGs it references, and the pinned plugin /
 * theme zips (downloaded once into a cache, sha256-checked every time). The WordPress containers read them from
 * e2e/wordpress/.work (mounted at /work).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { solidPng } from "./images.js";
import { buildSeedPlan, planProblems, type SeedPlan } from "./plan.js";
import { type PinnedZip, ZIPS, zipFileName } from "./versions.js";

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

export function writePlanAndImages(workDir: string, plan: SeedPlan = buildSeedPlan()): { planFile: string; images: number } {
	const problems = planProblems(plan);
	if (problems.length) throw new Error(`seed plan is inconsistent:\n- ${problems.join("\n- ")}`);
	mkdirSync(join(workDir, "images"), { recursive: true });
	for (const img of plan.images) writeFileSync(join(workDir, "images", img.file), solidPng(img));
	const planFile = join(workDir, "seed-plan.json");
	writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
	return { planFile, images: plan.images.length };
}

export type Fetcher = (url: string) => Promise<Buffer>;

const httpFetch: Fetcher = async (url) => {
	let last: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return Buffer.from(await r.arrayBuffer());
		} catch (e) {
			last = e;
			await new Promise((res) => setTimeout(res, attempt * 2000));
		}
	}
	throw new Error(`download failed: ${url}: ${(last as Error)?.message ?? last}`);
};

/** Each pinned zip into workDir/zips, from cacheDir when its checksum matches, else downloaded and checked. */
export async function fetchZips(workDir: string, cacheDir: string, opts: { zips?: PinnedZip[]; fetcher?: Fetcher; log?: (m: string) => void } = {}): Promise<string[]> {
	const zips = opts.zips ?? ZIPS;
	const fetcher = opts.fetcher ?? httpFetch;
	mkdirSync(join(workDir, "zips"), { recursive: true });
	mkdirSync(cacheDir, { recursive: true });
	const out: string[] = [];
	for (const z of zips) {
		const name = zipFileName(z);
		const cached = join(cacheDir, name);
		if (!(existsSync(cached) && sha256(readFileSync(cached)) === z.sha256)) {
			opts.log?.(`downloading ${z.slug} ${z.version}`);
			const buf = await fetcher(z.url);
			const got = sha256(buf);
			if (got !== z.sha256) throw new Error(`${z.slug} ${z.version}: sha256 ${got} does not match the pinned ${z.sha256} (${z.url}). If the release was re-published on purpose, update e2e/lib/versions.ts.`);
			writeFileSync(`${cached}.part`, buf);
			renameSync(`${cached}.part`, cached);
		}
		copyFileSync(cached, join(workDir, "zips", name));
		out.push(name);
	}
	// The seed installs in this order (seed.sh reads it line by line).
	writeFileSync(join(workDir, "zips", "order.txt"), `${zips.map((z) => `${z.kind} ${zipFileName(z)} ${z.slug}`).join("\n")}\n`);
	return out;
}
