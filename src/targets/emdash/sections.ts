/**
 * Reusable blocks → EmDash sections on the target (src/transform/sections.ts). A section the kit made (source "import")
 * is updated in place on a rerun; a section with the same slug that an editor made (source "user"/"theme") is left alone
 * and reported. Needs a token with content:write owned by an editor or admin (sections:manage).
 */
import type { IrReusableSection } from "../../transform/sections.js";
import { type EmDashApi, EmDashHttpError } from "./api.js";

export async function writeSections(api: Pick<EmDashApi, "section" | "createSection" | "updateSection">, sections: IrReusableSection[], resolve: (content: unknown[]) => unknown[]): Promise<{ created: number; updated: number; errors: string[] }> {
	const out = { created: 0, updated: 0, errors: [] as string[] };
	for (const s of sections) {
		try {
			const content = resolve(s.content);
			const description = `From the WordPress reusable block "${s.title}" (#${s.wpId})`;
			const have = await api.section(s.slug);
			if (!have) {
				await api.createSection({ slug: s.slug, title: s.title, description, content, source: "import" });
				out.created++;
			} else if (have.source === "import") {
				await api.updateSection(s.slug, { title: s.title, description, content });
				out.updated++;
			} else out.errors.push(`${s.slug}: a section with this slug was made in the admin (source ${have.source ?? "unknown"}); left as it is`);
		} catch (e) {
			const err = e as EmDashHttpError;
			out.errors.push(`${s.slug}: ${err instanceof EmDashHttpError && err.code === "INSUFFICIENT_SCOPE" ? "the API token needs the content:write scope" : err instanceof EmDashHttpError && err.status === 403 ? "the API token's owner must be an editor or admin (sections:manage)" : err.message}`);
		}
	}
	return out;
}
