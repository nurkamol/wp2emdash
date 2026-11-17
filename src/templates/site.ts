/** File templates written by `wp2emdash init`. */

export interface InitAnswers {
	slug: string;
	name: string;
	sourceUrl: string;
	productionUrl: string;
	sensitiveData: boolean;
}

export function configTemplate(a: InitAnswers): string {
	return `// Type-only import: erased at runtime, gives editor autocomplete via the kit's package exports.
import type { KitConfigInput } from "wp2emdash/config";

export default {
	slug: ${JSON.stringify(a.slug)},
	name: ${JSON.stringify(a.name)},
	source: {
		url: ${JSON.stringify(a.sourceUrl)},
		// alternateHosts: ["www.example.com"],
		// builders: [],            // empty = auto-detect during audit
	},
	target: {
		kind: "emdash", // or "astro-pagescms" — see docs/PLAN.md §2.3
		productionUrl: ${JSON.stringify(a.productionUrl)},
		template: "cloudflare:marketing",
		trailingSlash: "preserve",
		canonicalHost: "apex",
		staging: {
			// host: "staging.example.com", // empty = *.workers.dev
			protection: "access", // Cloudflare Access + noindex; or "noindex"
		},
		cutover: {
			method: "route", // Worker route in front of WordPress, instant rollback; "custom-domain" | "dns"
			monitorDays: 14,
			keepWordPressDays: 30,
		},
	},
	audit: {
		// maskSelectors: [".nectar-slider-wrap", "#cookie-notice"],
	},
	gates: {
		textSimilarity: 0.98,
		visualDiff: 0.03,
	},
	email: {
		provider: "brevo", // resend | sendgrid | postmark | mailgun | ses | google-workspace | microsoft-365 | cloudflare-email
		// from: "Website <noreply@example.com>",
		// to: ["owner@example.com"],
		secretName: "EMAIL_API_KEY",
	},
	sensitiveData: ${a.sensitiveData},
} satisfies KitConfigInput;
`;
}

/**
 * Human checklist. The init gate reads the [ ] / [x] boxes marked (required).
 * Keep the "(required)" marker on items that must be done before audit.
 */
export function accessTemplate(a: InitAnswers): string {
	return `# Access & safety checklist — ${a.name}

Tick boxes with [x]. Items marked **(required)** block the pipeline until ticked.
Never write passwords, keys or tokens in this file — store them in a password manager or \`sites/${a.slug}/.env\` (gitignored).

## Before audit
- [ ] (required) WordPress administrator login works for the person running the migration
- [ ] (required) Full hosting backup (database + wp-content + config) downloaded off-server and test-opened
- [ ] (required) DNS records exported (A/AAAA/CNAME/MX/TXT/CAA + TTLs) and saved to raw/dns.txt
- [ ] (required) Owner agreed: WordPress stays live and unchanged during migration

## Before extract
- [ ] WXR export (Tools → Export → All content) saved to raw/export.xml
- [ ] EmDash Exporter plugin 1.2.0+ installed, migration key stored in .env (EMDASH_WP_MIGRATION_KEY)
- [ ] Application password created for a dedicated user, stored in .env (WP_APP_USER / WP_APP_PASSWORD)
- [ ] Cloudflare Bot Fight Mode / WAF allows the exporter (skip rule or temporarily off)
- [ ] Salient sites (optional): Salient → Options → Import/Export → download, saved as raw/salient-options.json
- [ ] Redirects exported (Rank Math → Redirections → Export / Redirection plugin → Export) to raw/redirects.csv, or "no redirects" noted in decisions.md

## Before scaffold
- [ ] Cloudflare API token A (build & staging) in the kit \`.env\` — permissions in docs/cloudflare-api-token.md; \`pnpm wp2emdash doctor\` shows it active
- [ ] Email provider account + API key stored as a Wrangler secret (provider: see kit.config.ts)
- [ ] Turnstile site/secret key created

## Before cutover
- [ ] Domain zone access in Cloudflare (or registrar access + plan for DNS change)
- [ ] Go-live token B scoped to this zone (docs/cloudflare-api-token.md), revoked after the monitoring window
- [ ] Search Console access
- [ ] Booking / forms / analytics provider access confirmed
- [ ] Rollback owner named:
- [ ] Content freeze window agreed:

## After go-live
- [ ] Application password and migration key revoked
- [ ] Exporter plugin deactivated
`;
}

export function decisionsTemplate(a: InitAnswers): string {
	return `# Decisions — ${a.name}

Every accepted gate failure, approved visual difference, dropped feature and integration choice is recorded here.
Format: date · phase · decision · reason · approved by.

| Date | Phase | Decision | Reason | Approved by |
|---|---|---|---|---|
`;
}

export function overridesTemplate(): string {
	return `/**
 * Per-site overrides. Everything the pipeline cannot infer goes here, so a full
 * rerun from raw exports reproduces the same result. Never hand-edit ir/ or project content.
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
	/** "none" = no redirect rules to migrate; "file" = read raw/redirects.csv; "unknown" until decided. */
	redirects: { source: "unknown" },
	/** legacy_html sections approved to ship as-is: "<slug>:<row path>". */
	approvedLegacy: [],
};
`;
}

export const SITE_GITIGNORE = `raw/
.env
.env.*
!.env.example
runs/
snapshot/screens/
snapshot/interactions/
reports/**/screens/
`;
