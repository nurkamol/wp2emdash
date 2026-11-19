/**
 * Per-site overrides (synthetic dashboard fixture).
 * Schema: src/config/overrides.ts. Write the human reason for each entry in decisions.md.
 */
export default {
	/** WordPress path → EmDash path, when the default mapping is wrong. */
	routes: {},
	/** "<slug>:<row path>" from reports/transform/coverage.md → section type, or "drop" for decorative rows. */
	elements: {},
	/** Integration id (reports/audit/integrations.md) → keep | rebuild | replace | drop. */
	integrations: {},
	media: {
		/** External media URL or host → "copy" (into R2 at load) or "hotlink". */
		external: {},
	},
	redirects: { source: "unknown" },
	approvedLegacy: [],
};
