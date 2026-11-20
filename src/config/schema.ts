import { z } from "zod";

/** Builders the kit can detect. Adapters exist for the `supported` ones. */
export const BUILDERS = ["gutenberg", "classic", "wpbakery", "elementor", "bricks", "divi"] as const;
export const SUPPORTED_BUILDERS = ["gutenberg", "classic", "wpbakery"] as const;

/** Email providers for rebuilt forms. All are HTTP APIs callable from a Worker. */
/** Where the migrated site lives. See docs/PLAN.md §2.3. */
export const TARGETS = ["emdash", "astro-pagescms"] as const;

export const EMAIL_PROVIDERS = [
	"brevo",
	"resend",
	"sendgrid",
	"postmark",
	"mailgun",
	/** EmDash's own email pipeline (Settings → Email): no API key, sender set in the admin. */
	"emdash",
	"ses",
	"google-workspace",
	"microsoft-365",
	"cloudflare-email",
] as const;

const viewport = z.object({
	name: z.string(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});

const emailConfig = z.object({
	provider: z.enum(EMAIL_PROVIDERS).default("brevo"),
	/** Verified sender address, e.g. "Website <noreply@client.com>". */
	from: z.string().optional(),
	/** Default notification recipients; individual forms can override. */
	to: z.array(z.string()).default([]),
	/**
	 * Test recipients (the team's test inbox). Opt-in staging sends form email only here (unset → staging holds every
	 * message in the outbox and sends nothing). Single-environment sites: a message sent from any address other than the
	 * production domain — the workers.dev address before go-live, Workers preview URLs after it — goes only here, never
	 * to `to` (unset → kept in the outbox unsent, or refused without one), so a test submission never reaches the client.
	 */
	stagingTo: z.array(z.string().email()).default([]),
	/** Name of the Wrangler secret holding the API key / service-account JSON. Never the value itself. */
	secretName: z.string().default("EMAIL_API_KEY"),
	/** Provider-specific, non-secret options (e.g. Mailgun region, SES region, Workspace delegated user). */
	options: z.record(z.string(), z.string()).default({}),
});

export const kitConfigSchema = z.object({
	/** Short identifier, also the folder name under sites/. */
	slug: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and hyphens"),
	/** Where the deployable project (the client repository) lives, if not sites/<slug>/project. A plain string: "~/Projects/Acme/emdash". */
	projectDir: z.string().min(1).optional(),
	name: z.string(),

	source: z.object({
		/** Live WordPress origin, e.g. https://www.example.com */
		url: z.url(),
		/** Hosts that count as internal (www/apex variants, old domains). */
		alternateHosts: z.array(z.string()).default([]),
		/** Leave empty to auto-detect during audit. */
		builders: z.array(z.enum(BUILDERS)).default([]),
		theme: z.string().optional(),
	}),

	target: z.object({
		/** emdash = Worker + D1 + R2 with admin/visual editing; astro-pagescms = static site edited through Pages CMS (Git). */
		kind: z.enum(TARGETS).default("emdash"),
		/** Production URL after cutover. */
		productionUrl: z.url(),
		/** Staging URL once deployed (opt-in staging only). Setting it also counts as opting in. */
		stagingUrl: z.url().optional(),
		/**
		 * A second environment is OPT-IN (owner decision 2026-11-20). Default: one environment — production, on its
		 * workers.dev address until go-live. `staging: true` (or `{ enabled: true, … }`) adds a staging Worker with its own
		 * D1/R2/KV. A site that already has staging (target.stagingUrl, or staging resources recorded in cloudflare.json)
		 * keeps it unless this says `false`. See src/core/environments.ts, docs/staging-setup.md and docs/PLAN.md §7a.
		 */
		staging: z
			.union([
				z.boolean().transform((enabled) => ({ enabled, host: undefined as string | undefined, protection: "access" as "access" | "noindex" })),
				z.object({
					/** true = opt in; false = never (overrides the legacy signals); unset = only when staging already exists. */
					enabled: z.boolean().optional(),
					/** e.g. "staging.example.com" on the client's zone. Empty = the free *.workers.dev address. */
					host: z.string().optional(),
					/** access = Cloudflare Access login wall + noindex; noindex = robots + X-Robots-Tag only. */
					protection: z.enum(["access", "noindex"]).default("access"),
				}),
			])
			.prefault({}),
		/**
		 * Single environment: when the client repo's CI deploys production on a push to main. "prelaunch" (default) = only
		 * until go-live (workers.dev only, nothing public changes), then by hand (Run workflow); "always"; "manual" = never on push.
		 */
		ciDeploy: z.enum(["prelaunch", "always", "manual"]).default("prelaunch"),
		/** How production traffic moves to the Worker. See docs/PLAN.md §7a. */
		cutover: z
			.object({
				/**
				 * route = Worker route in front of the existing proxied record (zone on Cloudflare; instant rollback by deleting the route).
				 * custom-domain = Worker Custom Domain straight away (replaces the DNS record).
				 * dns = zone not on Cloudflare; repoint DNS with lowered TTL.
				 */
				method: z.enum(["route", "custom-domain", "dns"]).default("route"),
				/** Days of post-launch monitoring before the route can become a Custom Domain. */
				monitorDays: z.number().int().min(1).default(14),
				/** Days WordPress stays running (not public) and restorable after launch. */
				keepWordPressDays: z.number().int().min(0).default(30),
			})
			.prefault({}),
		/** EmDash starter template passed to `npm create emdash`. */
		template: z.string().default("cloudflare:marketing"),
		trailingSlash: z.enum(["always", "never", "preserve"]).default("preserve"),
		canonicalHost: z.enum(["apex", "www"]).default("apex"),
		/**
		 * Other domains that become a permanent, path-preserving 301 to the production domain (e.g. a second WordPress
		 * install merged into this site). Apex hostnames; `www.` is covered automatically. Each zone must be in Cloudflare:
		 * the cutover preflight reads it (go-live token) and the runbook adds one Single Redirect rule per alias.
		 */
		aliasDomains: z
			.array(
				z
					.string()
					.transform((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
					.pipe(z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "an apex hostname, e.g. old-domain.com")),
			)
			.default([]),
	}),

	audit: z
		.object({
			viewports: z.array(viewport).default([
				{ name: "mobile", width: 390, height: 844 },
				{ name: "tablet", width: 768, height: 1024 },
				{ name: "desktop", width: 1440, height: 900 },
			]),
			/** CSS selectors hidden before screenshots (sliders, tickers, cookie banners). */
			maskSelectors: z.array(z.string()).default([]),
			/** URL patterns never crawled (e.g. /cart, /wp-admin). */
			exclude: z.array(z.string()).default(["/wp-admin", "/wp-login.php", "/wp-json", "/xmlrpc.php", "/cdn-cgi"]),
			maxUrls: z.number().int().positive().default(2000),
			concurrency: z.number().int().positive().default(4),
		})
		.prefault({}),

	gates: z
		.object({
			/** Normalised visible-text similarity per page (0–1). */
			textSimilarity: z.number().min(0).max(1).default(0.98),
			/** Transform: share of the live page's distinct words found in the IR. */
			textConservation: z.number().min(0).max(1).default(0.99),
			/** Max pixel difference per page × viewport after masks (0–1). */
			visualDiff: z.number().min(0).max(1).default(0.03),
			lighthousePerformance: z.number().min(0).max(100).default(90),
			maxLcpMs: z.number().default(2500),
			maxCls: z.number().default(0.1),
			/** Verify (remote targets): time to first byte of a cached page, median of 3, from the machine running verify. */
			maxCachedTtfbMs: z.number().positive().default(600),
			/** Verify: bytes the home page transfers until its load event (desktop), background video excluded by design. */
			maxPayloadKb: z.number().positive().default(1500),
		})
		.prefault({}),

	email: emailConfig.prefault({}),

	/**
	 * Analytics carried over from the live site. Unset = the tracking ids the audit found (Google tag GT-/G-/AW-,
	 * Tag Manager GTM-); false = none. Loaded only on the production domain and never for signed-in editors.
	 * cloudflareToken: a Web Analytics beacon to add in code — leave unset when Cloudflare injects it at the edge.
	 */
	analytics: z
		.union([
			z.literal(false),
			z.object({
				google: z.array(z.string().regex(/^(?:GT|G|AW)-[A-Z0-9]{4,14}$/)).default([]),
				gtm: z.string().regex(/^GTM-[A-Z0-9]{4,10}$/).optional(),
				cloudflareToken: z.string().regex(/^[a-f0-9]{32}$/).optional(),
			}),
		])
		.optional(),

	/** Branded sharing cards (og:image) rendered in the Worker (@wp2emdash/og). On by default; { cards: false } turns them off. */
	og: z.object({ cards: z.boolean().default(true) }).default({ cards: true }),
	/**
	 * Entrance motion. "calm" (owner opt-in): sections fade in and rise 14px over 600ms, cards / columns / FAQ items
	 * follow with a short stagger, pictures fade and settle from a 3% zoom, buttons and links ease their colours. The
	 * page's first section is never held back (LCP), nothing moves under prefers-reduced-motion, all is visible without JS.
	 * Unset: calm on Bricks sites whose live pages animate their content (entrance interactions), else the starter's
	 * default reveal; "none" keeps the default.
	 */
	motion: z.enum(["calm", "none"]).optional(),
	/**
	 * Performance package (docs/spikes/performance-findings.md), on by default:
	 * - routeCache: rendered pages kept in Cloudflare's Workers cache (Astro route caching, EmDash purges on publish);
	 *   maxAge/swr in seconds. false = every page rendered per request.
	 * - responsiveImages: srcset/sizes through EmDash's image endpoint (Cloudflare Images binding, no zone setting;
	 *   counts against the account's Images transformations — 5,000 unique/month free; a failed transform falls back to
	 *   the original file). false = original files only.
	 * - warmup: deploy scripts request every sitemap URL once after `wrangler deploy`.
	 * - smartPlacement: Workers Smart Placement (off: not shown to help this stack, see the findings).
	 */
	performance: z
		.object({
			routeCache: z.boolean().default(true),
			maxAge: z.number().int().positive().default(3600),
			swr: z.number().int().nonnegative().default(86400),
			responsiveImages: z.boolean().default(true),
			warmup: z.boolean().default(true),
			smartPlacement: z.boolean().default(false),
		})
		.prefault({}),
	/** SEO panel, dashboard, Search Console and IndexNow (@wp2emdash/seo). On by default; { panel: false } turns it off. */
	seo: z.object({ panel: z.boolean().default(true) }).default({ panel: true }),
	/**
	 * Third-party EmDash plugins that run in EmDash's sandbox (Cloudflare Worker Loader, Workers Paid). Each is pinned
	 * to a reviewed version and enabled per environment; admin installs from the public registry stay off.
	 */
	sandboxedPlugins: z
		.array(
			z.object({
				package: z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/),
				version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/, "an exact, reviewed version"),
				environments: z.array(z.enum(["staging", "production"])).min(1).default(["staging", "production"]),
			}),
		)
		.default([]),

	forms: z
		.object({
			/**
			 * How forms are rebuilt on a site with sensitiveData (an owner decision, recorded in decisions.md):
			 * "contact-only" keeps only contact fields (name, email, phone) and drops free text, so nothing
			 * sensitive can pass through the Worker or email. Unset on a sensitive site = the scaffold gate fails.
			 */
			/**
			 * contact-only: name, email, phone. contact-and-message: also the form's first message box, with the notice
			 * shown right above it (owner decision: visitors can still type health details there).
			 */
			sensitive: z.enum(["contact-only", "contact-and-message"]).optional(),
			/** Note shown above the submit button of a sensitive form. */
			notice: z.string().default("Please don't include health details here — we'll get back to you."),
			/** Submissions per visitor (IP) and form, per period (Workers rate limiting: 10 or 60 s). */
			rateLimit: z.object({ limit: z.number().int().positive().default(5), period: z.union([z.literal(10), z.literal(60)]).default(60) }).prefault({}),
			/**
			 * Keep messages in Workers KV when email cannot be sent (not configured, or the provider refuses) and retry
			 * them from the cron; deleted once emailed, or after `days`. An owner decision (decisions.md): it stores the
			 * form's fields — on a sensitive site only the contact fields the policy allows.
			 */
			outbox: z
				.object({
					days: z.number().int().min(1).max(90).default(30),
					/** Hold: keep every message and send none (a provider that accepts but does not deliver). Off = queue drains. */
					hold: z.boolean().default(false),
					/**
					 * Keep sent: store every message, also once emailed (marked emailed), so Form messages is a full inbox
					 * (FORM_OUTBOX_KEEP_SENT="1", both environments). A data-retention decision (decisions.md): visitors' text
					 * stays in KV for `days` even after it was emailed. Off = only messages that could not be emailed are kept.
					 * On a sensitive site, leave it off unless the owner explicitly wants an inbox.
					 */
					keepSent: z.boolean().default(false),
				})
				.optional(),
			/** Production Turnstile site key (public). Staging uses Cloudflare's always-pass test key. */
			turnstileSiteKey: z.string().optional(),
		})
		.prefault({}),

	/** Site handles sensitive data (health, legal, finance): forms never store or email field values that look sensitive. */
	sensitiveData: z.boolean().default(false),

	/** Third-party widget settings the page markup does not carry (public values, no secrets). */
	embeds: z
		.object({
			/** Mariana Tek web integrations tenant (`<tenant>.marianaiframes.com`); else read from the markup or the live pages. */
			marianatekTenant: z
				.string()
				.regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/)
				.optional(),
		})
		.prefault({}),
});

export type KitConfigInput = z.input<typeof kitConfigSchema>;
export type KitConfig = z.output<typeof kitConfigSchema>;

/** Typed helper for sites/<slug>/kit.config.ts */
export function defineConfig(config: KitConfigInput): KitConfigInput {
	return config;
}
