import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSite } from "../src/commands/init.js";
import { copyMedia, d1Reader, defaultRunWrangler, syncReport, syncStaging } from "../src/commands/sync-staging.js";
import { upgrade } from "../src/commands/upgrade.js";
import { sitePaths } from "../src/core/paths.js";
import { assertReadOnly, assertStagingBucket, assertStagingDatabase, buildPlan, buildSyncSql, classifySyncTable, type DbSchema, mediaKeyAllowed, optionAllowedForSync, optionsWhere, readSchema, SYNC_TABLES, sqlLiteral, syncRefusals } from "../src/sync/staging.js";
import { EXCLUDED_TABLES, INCLUDED_TABLES } from "../packages/backups/src/format.js";

// Synthetic EmDash-shaped databases (real SQLite through node:sqlite, foreign keys on like D1). No client data.
const SCHEMA = `
CREATE TABLE _emdash_migrations (name TEXT PRIMARY KEY, timestamp TEXT);
CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
CREATE TABLE credentials (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key TEXT);
CREATE TABLE auth_tokens (id TEXT PRIMARY KEY, token_hash TEXT);
CREATE TABLE _emdash_api_tokens (id TEXT PRIMARY KEY, token_hash TEXT);
CREATE TABLE _plugin_storage (plugin_id TEXT, collection TEXT, id TEXT, data TEXT, PRIMARY KEY (plugin_id, collection, id));
CREATE TABLE _emdash_collections (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
CREATE TABLE ec_pages (id TEXT PRIMARY KEY, slug TEXT, status TEXT, title TEXT, author_id TEXT, locale TEXT NOT NULL DEFAULT 'en');
CREATE INDEX idx_pages_slug ON ec_pages (slug);
CREATE TABLE media_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE media (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER, storage_key TEXT NOT NULL, folder_id TEXT REFERENCES media_folders(id) ON DELETE SET NULL);
CREATE TABLE _emdash_bylines (id TEXT PRIMARY KEY, slug TEXT NOT NULL, display_name TEXT NOT NULL, avatar_media_id TEXT REFERENCES media(id) ON DELETE SET NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE _emdash_content_bylines (id TEXT PRIMARY KEY, collection_slug TEXT NOT NULL, content_id TEXT NOT NULL, byline_id TEXT NOT NULL REFERENCES _emdash_bylines(id) ON DELETE CASCADE);
CREATE TABLE _emdash_redirects (id TEXT PRIMARY KEY, source TEXT NOT NULL, destination TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE _emdash_404_log (id INTEGER PRIMARY KEY, path TEXT);
`;
const MIGRATIONS = ["001_initial", "002_media_status"];
const PAGE_TITLE = "Zebra Lantern Original Heading"; // must never appear in logs

function production(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(SCHEMA);
	for (const m of MIGRATIONS) db.prepare("INSERT INTO _emdash_migrations VALUES (?, '2026-01-01')").run(m);
	db.exec(`
INSERT INTO users VALUES ('u-prod', 'owner@client.example', 'hash-prod');
INSERT INTO credentials VALUES ('c-prod', 'u-prod', 'pk-prod');
INSERT INTO _emdash_api_tokens VALUES ('t-prod', 'th-prod');
INSERT INTO _plugin_storage VALUES ('site-forms', 'messages', 'm1', '{"email":"visitor@example.com"}');
INSERT INTO _emdash_collections VALUES ('col-pages', 'pages');
INSERT INTO ec_pages VALUES ('p1', 'home', 'published', '${PAGE_TITLE}', 'u-prod', 'en');
INSERT INTO ec_pages VALUES ('p2', 'about', 'published', 'About O''Brien & Co', 'u-prod', 'en');
INSERT INTO ec_pages VALUES ('p3', 'new', 'draft', 'Added in production', NULL, 'en');
INSERT INTO media_folders VALUES ('f1', 'Photos');
INSERT INTO media VALUES ('m1', 'a.jpg', 'image/jpeg', 5, '01ABC.jpg', 'f1');
INSERT INTO media VALUES ('m2', 'b.png', 'image/png', 3, '01DEF.png', NULL);
INSERT INTO media VALUES ('m3', 'x.bin', 'application/octet-stream', 4, 'backups/2026/x.json.gz', NULL);
INSERT INTO _emdash_bylines VALUES ('b1', 'owner', 'The Owner', 'm1', 'u-prod');
INSERT INTO _emdash_content_bylines VALUES ('cb1', 'pages', 'p1', 'b1');
INSERT INTO _emdash_redirects VALUES ('r1', '/old/', '/new/', 1);
INSERT INTO _emdash_404_log VALUES (1, '/missing');
INSERT INTO options VALUES ('site:title', '"Acme"');
INSERT INTO options VALUES ('site:url', '"https://acme.example"');
INSERT INTO options VALUES ('site:staging', 'false');
INSERT INTO options VALUES ('emdash:site_title', '"Acme"');
INSERT INTO options VALUES ('emdash:preview_secret', '"prod-preview-secret"');
INSERT INTO options VALUES ('plugin:site-forms:cfg:crm', '{"apiKey":"crm-secret"}');
INSERT INTO options VALUES ('plugin:site-forms:cfg:recipients', '["owner@client.example"]');
INSERT INTO options VALUES ('plugin:site-og:secret', '"og-signing-secret"');
INSERT INTO options VALUES ('plugin:site-og:settings', '{"enabled":true}');
INSERT INTO options VALUES ('plugin:privacy-consent:settings', '{"banner":"on"}');
INSERT INTO options VALUES ('plugin:site-seo:social:pages:p1', '{"image":"x"}');
INSERT INTO options VALUES ('plugin:site-seo:analytics', '{"ga":"G-PROD"}');
INSERT INTO options VALUES ('site:encrypted', '{"$emdash":"enc"}');
`);
	return db;
}

function staging(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(SCHEMA);
	for (const m of MIGRATIONS) db.prepare("INSERT INTO _emdash_migrations VALUES (?, '2026-01-01')").run(m);
	db.exec(`
INSERT INTO users VALUES ('u-agency', 'agency@agency.example', 'hash-agency');
INSERT INTO credentials VALUES ('c-agency', 'u-agency', 'pk-agency');
INSERT INTO _emdash_api_tokens VALUES ('t-stg', 'th-stg');
INSERT INTO _plugin_storage VALUES ('site-forms', 'messages', 's1', '{"test":true}');
INSERT INTO _emdash_collections VALUES ('col-pages', 'pages');
INSERT INTO ec_pages VALUES ('p1', 'home', 'published', 'Old staging title', 'u-agency', 'en');
INSERT INTO ec_pages VALUES ('p9', 'gone', 'published', 'Deleted in production', NULL, 'en');
INSERT INTO media_folders VALUES ('f9', 'Old');
INSERT INTO media VALUES ('m1', 'a.jpg', 'image/jpeg', 5, '01ABC.jpg', 'f9');
INSERT INTO options VALUES ('site:title', '"Acme (old)"');
INSERT INTO options VALUES ('site:url', '"https://acme-staging.x.workers.dev"');
INSERT INTO options VALUES ('site:staging', 'true');
INSERT INTO options VALUES ('site:removed-in-prod', '"x"');
INSERT INTO options VALUES ('plugin:site-forms:cfg:recipients', '["agency@agency.example"]');
INSERT INTO options VALUES ('emdash:preview_secret', '"stg-preview-secret"');
`);
	return db;
}

const dump = (db: DatabaseSync) => JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]));
const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
const queryOf = (db: DatabaseSync) => async (sql: string) => {
	assertReadOnly(sql);
	return rows(db, sql).map((r) => ({ ...r }));
};

const CF = {
	production: { accountId: "acct-1", d1: { id: "prod-db-id", name: "acme-db" }, r2: { bucket: "acme-media" }, worker: { url: "https://acme.x.workers.dev" } },
	staging: { accountId: "acct-1", d1: { id: "stg-db-id", name: "acme-staging-db" }, r2: { bucket: "acme-stg-media" }, worker: { url: "https://acme-staging.x.workers.dev" } },
};
const VARS = { CLOUDFLARE_API_TOKEN: "cf-token-abcdef123456", CLOUDFLARE_ACCOUNT_ID: "acct-1", EMDASH_TOKEN: "emdash-token-abcdef123456" };

/** A fake Cloudflare API + staging EmDash: D1 query → SQLite, bookmarks, R2 objects in maps, settings. Records every call. */
function fakeCloud(prod: DatabaseSync, stg: DatabaseSync, o: { prodObjects?: Record<string, Uint8Array>; stgObjects?: Record<string, Uint8Array>; bookmarkFails?: boolean } = {}) {
	const calls: { method: string; url: string; sql?: string }[] = [];
	const prodObjects = o.prodObjects ?? { "01ABC.jpg": new Uint8Array([1, 2, 3, 4, 5]), "01DEF.png": new Uint8Array([7, 8, 9]), "backups/2026/x.json.gz": new Uint8Array([0, 0, 0, 0]) };
	const stgObjects: Record<string, Uint8Array> = o.stgObjects ?? { "01ABC.jpg": new Uint8Array([1, 2, 3, 4, 5]) };
	let settingsSaved: unknown;
	const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const d1 = /\/d1\/database\/([^/]+)\/(query|time_travel\/bookmark)$/.exec(url);
		if (d1) {
			const db = d1[1] === "prod-db-id" ? prod : d1[1] === "stg-db-id" ? stg : undefined;
			if (!db) return json({ success: false, errors: [{ message: "no such database" }] }, 404);
			if (d1[2] === "time_travel/bookmark") {
				calls.push({ method, url });
				return o.bookmarkFails ? json({ success: false, errors: [{ message: "denied" }] }, 403) : json({ success: true, result: { bookmark: `bm-${d1[1]}` } });
			}
			const { sql } = JSON.parse(String(init?.body)) as { sql: string };
			calls.push({ method, url, sql });
			try {
				return json({ success: true, result: [{ results: rows(db, sql).map((r) => ({ ...r })), success: true }] });
			} catch (e) {
				return json({ success: false, errors: [{ message: (e as Error).message }] }, 400);
			}
		}
		const r2 = /\/r2\/buckets\/([^/]+)\/objects\/(.+)$/.exec(url);
		if (r2) {
			calls.push({ method, url });
			const store = r2[1] === "acme-media" ? prodObjects : r2[1] === "acme-stg-media" ? stgObjects : undefined;
			const key = (r2[2] as string).split("/").map(decodeURIComponent).join("/");
			if (!store) return new Response("no bucket", { status: 404 });
			if (method === "PUT") {
				store[key] = new Uint8Array(init?.body as Uint8Array);
				return json({ success: true });
			}
			const obj = store[key];
			if (!obj) return new Response(null, { status: 404 });
			return new Response(method === "HEAD" ? null : (obj as unknown as BodyInit), { status: 200, headers: { "content-length": String(obj.byteLength), "content-type": "image/jpeg" } });
		}
		if (url.endsWith("/_emdash/api/settings")) {
			calls.push({ method, url });
			if (method === "POST") {
				settingsSaved = JSON.parse(String(init?.body));
				return json({ data: {} });
			}
			return json({ data: { title: "Acme" } });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetcher, calls, prodObjects, stgObjects, saved: () => settingsSaved };
}

/** Stands in for `wrangler d1 execute --remote --file`: applies the file to staging in one transaction (D1's import is atomic). */
function fakeWrangler(stg: DatabaseSync, seen: { args: string[]; sql: string; config: unknown; env: Record<string, string> }[]) {
	return async (args: string[], _cwd: string, env: Record<string, string>) => {
		const file = args[args.indexOf("--file") + 1] as string;
		const sql = readFileSync(file, "utf8");
		const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1] as string, "utf8"));
		seen.push({ args, sql, config, env });
		try {
			stg.exec("BEGIN");
			stg.exec(sql);
			stg.exec("COMMIT");
			return { code: 0, out: "🚣 Executed" };
		} catch (e) {
			stg.exec("ROLLBACK");
			return { code: 1, out: `✘ ${(e as Error).message} token=${env.CLOUDFLARE_API_TOKEN}` };
		}
	};
}

describe("sync-staging allowlist", () => {
	it("copies content, media, menus, taxonomies, widgets, sections, SEO, redirects and settings — never auth, secrets, form data or logs", () => {
		for (const t of ["ec_pages", "media", "media_folders", "taxonomies", "content_taxonomies", "_emdash_menus", "_emdash_menu_items", "_emdash_widgets", "_emdash_sections", "_emdash_seo", "_emdash_redirects", "options", "revisions"]) expect(classifySyncTable(t).include).toBe(true);
		for (const t of ["users", "credentials", "auth_tokens", "auth_challenges", "oauth_accounts", "_emdash_api_tokens", "_emdash_oauth_clients", "_emdash_oauth_tokens", "_emdash_device_codes", "_emdash_authorization_codes", "_plugin_storage", "_plugin_state", "_emdash_comments", "audit_logs", "_emdash_404_log", "_emdash_migrations", "_emdash_rooms", "_emdash_media_usage_sources", "_emdash_fts_pages", "_emdash_transfer_operations", "some_new_table"]) expect(classifySyncTable(t).include).toBe(false);
		expect(classifySyncTable("some_new_table").why).toMatch(/not classified/);
		// The sync never copies more than a backup holds.
		for (const t of Object.keys(SYNC_TABLES)) expect(INCLUDED_TABLES[t]).toBeDefined();
		for (const t of Object.keys(EXCLUDED_TABLES)) expect(classifySyncTable(t).include).toBe(false);
	});

	it("options: site settings and allowlisted plugin configuration only", () => {
		expect(optionAllowedForSync("site:title", '"A"')).toBe(true);
		expect(optionAllowedForSync("emdash:site_tagline", '"A"')).toBe(true);
		expect(optionAllowedForSync("plugin:privacy-consent:settings", "{}")).toBe(true);
		expect(optionAllowedForSync("plugin:site-seo:term:category:news", "{}")).toBe(true);
		for (const k of ["site:url", "site:staging", "emdash:preview_secret", "emdash:setup_complete", "plugin:site-forms:cfg:crm", "plugin:site-forms:cfg:recipients", "plugin:site-forms:cfg:chat", "plugin:site-og:secret", "plugin:site-seo:analytics", "plugin:change-requests:req:1", "plugin:site-health:maintenance", "plugin:site-backups:index"]) expect(optionAllowedForSync(k, "{}")).toBe(false);
		expect(optionAllowedForSync("site:anything", '{"$emdash":"x"}')).toBe(false);
		// SQL and code agree.
		const db = production();
		const viaSql = rows(db, `SELECT name FROM options WHERE ${optionsWhere()} ORDER BY name`).map((r) => r.name);
		const viaCode = rows(db, "SELECT name, value FROM options ORDER BY name").filter((r) => optionAllowedForSync(String(r.name), r.value)).map((r) => r.name);
		expect(viaSql).toEqual(viaCode);
		expect(viaSql).toEqual(["emdash:site_title", "plugin:privacy-consent:settings", "plugin:site-og:settings", "plugin:site-seo:social:pages:p1", "site:title"]);
	});

	it("only read-only statements reach a database over the REST API", () => {
		expect(() => assertReadOnly("SELECT * FROM \"ec_pages\" WHERE (1 = 1) ORDER BY rowid LIMIT 500")).not.toThrow();
		expect(() => assertReadOnly('PRAGMA table_info("ec_pages")')).not.toThrow();
		expect(() => assertReadOnly(`SELECT COUNT(*) AS n FROM "options" WHERE ${optionsWhere()}`)).not.toThrow();
		expect(() => assertReadOnly("SELECT updated_at, deleted_at FROM ec_pages")).not.toThrow();
		for (const bad of ["DELETE FROM users", "SELECT 1; DROP TABLE users", "INSERT INTO options VALUES ('a','b')", "PRAGMA foreign_keys = OFF", "UPDATE ec_pages SET title = 'x'", "WITH x AS (SELECT 1) DELETE FROM users", "SELECT * FROM t WHERE id IN (SELECT id FROM t); VACUUM"]) expect(() => assertReadOnly(bad)).toThrow(/Refused/);
	});

	it("SQL literals escape quotes, keep numbers and NULL", () => {
		expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
		expect(sqlLiteral(null)).toBe("NULL");
		expect(sqlLiteral(42)).toBe("42");
		expect(sqlLiteral(true)).toBe("1");
		expect(sqlLiteral({ a: 1 })).toBe(`'{"a":1}'`);
		expect(sqlLiteral([1, 255])).toBe("X'01ff'");
	});

	it("media keys: relative, no traversal, never backups or transfers", () => {
		expect(mediaKeyAllowed("01ABC.jpg")).toBe(true);
		expect(mediaKeyAllowed("2026/11/a.webp")).toBe(true);
		for (const k of ["", "/abs.jpg", "a/../b.jpg", "backups/x.json.gz", "transfers/a"]) expect(mediaKeyAllowed(k)).toBe(false);
	});
});

describe("sync-staging plan and SQL (fake schema)", () => {
	let prod: DatabaseSync;
	let stg: DatabaseSync;
	beforeEach(() => {
		prod = production();
		stg = staging();
	});
	const schemas = async (): Promise<[DbSchema, DbSchema]> => [await readSchema(queryOf(prod)), await readSchema(queryOf(stg))];

	it("builds the plan from the allowlist, lists every other table as skipped, nulls links to staging's users", async () => {
		const [p, s] = await schemas();
		const plan = buildPlan(p, s);
		expect(plan.blockers).toEqual([]);
		expect(plan.tables.map((t) => t.table).sort()).toEqual(["_emdash_bylines", "_emdash_collections", "_emdash_content_bylines", "_emdash_redirects", "ec_pages", "media", "media_folders", "options"]);
		expect(plan.skipped.map((t) => t.table).sort()).toEqual(["_emdash_404_log", "_emdash_api_tokens", "_emdash_migrations", "_plugin_storage", "auth_tokens", "credentials", "users"]);
		expect(plan.skipped.find((x) => x.table === "users")?.why).toMatch(/auth/);
		expect(plan.tables.find((t) => t.table === "_emdash_bylines")?.nullColumns).toEqual([{ column: "user_id", why: "references users (staging keeps its own)" }]);
		// Referenced tables first on insert, dependents first on delete.
		const ins = plan.order.insert;
		expect(ins.indexOf("media_folders")).toBeLessThan(ins.indexOf("media"));
		expect(ins.indexOf("media")).toBeLessThan(ins.indexOf("_emdash_bylines"));
		expect(ins.indexOf("_emdash_bylines")).toBeLessThan(ins.indexOf("_emdash_content_bylines"));
		expect(plan.order.delete).toEqual([...ins].reverse());
	});

	it("refuses a staging schema behind production's; creates a new collection; adds a field production gained", async () => {
		prod.exec("INSERT INTO _emdash_migrations VALUES ('003_menus', 'x')");
		let [p, s] = await schemas();
		expect(buildPlan(p, s).blockers.join("\n")).toMatch(/behind production's schema.*003_menus/);
		prod.exec("DELETE FROM _emdash_migrations WHERE name = '003_menus'");
		prod.exec("CREATE TABLE ec_posts (id TEXT PRIMARY KEY, title TEXT); CREATE INDEX idx_posts_title ON ec_posts (title); INSERT INTO ec_posts VALUES ('n1', 'Post');");
		prod.exec("ALTER TABLE ec_pages ADD COLUMN subtitle TEXT");
		[p, s] = await schemas();
		const plan = buildPlan(p, s);
		expect(plan.blockers).toEqual([]);
		expect(plan.tables.find((t) => t.table === "ec_posts")?.action).toBe("create");
		expect(plan.tables.find((t) => t.table === "ec_pages")?.addColumns.map((c) => c.name)).toEqual(["subtitle"]);
		const all: Record<string, Record<string, unknown>[]> = {};
		for (const t of plan.tables) all[t.table] = rows(prod, `SELECT * FROM "${t.table}"${t.table === "options" ? ` WHERE ${optionsWhere()}` : ""}`);
		const { sql } = buildSyncSql(plan, p, all);
		stg.exec("BEGIN");
		stg.exec(sql);
		stg.exec("COMMIT");
		expect(rows(stg, "SELECT id, title FROM ec_posts")).toEqual([{ id: "n1", title: "Post" }]);
		expect(rows(stg, "SELECT name FROM sqlite_master WHERE name = 'idx_posts_title'")).toHaveLength(1);
		expect(rows(stg, "PRAGMA table_info(ec_pages)").map((c) => c.name)).toContain("subtitle");
	});

	it("generates SQL that replaces only allowlisted tables and rows, and leaves users, auth and form data alone", async () => {
		const [p, s] = await schemas();
		const plan = buildPlan(p, s);
		const all: Record<string, Record<string, unknown>[]> = {};
		for (const t of plan.tables) all[t.table] = rows(prod, `SELECT * FROM "${t.table}"${t.table === "options" ? ` WHERE ${optionsWhere()}` : ""}`);
		// A disallowed row slipped into the input is still filtered out.
		all.options?.push({ name: "plugin:site-forms:cfg:crm", value: '{"apiKey":"crm-secret"}' });
		const out = buildSyncSql(plan, p, all);
		expect(out.sql.startsWith("PRAGMA defer_foreign_keys = true;")).toBe(true);
		for (const t of ["users", "credentials", "auth_tokens", "_emdash_api_tokens", "_plugin_storage", "_emdash_migrations", "_emdash_404_log"]) expect(out.sql).not.toMatch(new RegExp(`(INTO|FROM|TABLE) "${t}"`));
		expect(out.sql).toContain(`DELETE FROM "options" WHERE ${optionsWhere()};`);
		expect(out.sql).not.toContain("crm-secret");
		expect(out.sql).not.toContain("og-signing-secret");
		expect(out.sql).not.toContain("prod-preview-secret");
		expect(out.sql).toContain(`INSERT INTO "_emdash_bylines" ("id", "slug", "display_name", "avatar_media_id", "user_id") VALUES ('b1', 'owner', 'The Owner', 'm1', NULL);`); // the user link → NULL
		expect(out.sql).toContain("'About O''Brien & Co'");
		expect(out.rows).toMatchObject({ ec_pages: 3, media: 3, options: 5, _emdash_bylines: 1 });
		stg.exec("BEGIN");
		stg.exec(out.sql);
		stg.exec("COMMIT");
		expect(rows(stg, "PRAGMA foreign_key_check")).toEqual([]);
		expect(rows(stg, "SELECT id FROM ec_pages ORDER BY id").map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
		expect(rows(stg, "SELECT id FROM users").map((r) => r.id)).toEqual(["u-agency"]);
		expect(rows(stg, "SELECT id FROM credentials").map((r) => r.id)).toEqual(["c-agency"]);
		expect(rows(stg, "SELECT id FROM _plugin_storage").map((r) => r.id)).toEqual(["s1"]);
		const opts = Object.fromEntries(rows(stg, "SELECT name, value FROM options").map((r) => [r.name, r.value]));
		expect(opts["site:url"]).toBe('"https://acme-staging.x.workers.dev"');
		expect(opts["site:staging"]).toBe("true");
		expect(opts["site:title"]).toBe('"Acme"');
		expect(opts["site:removed-in-prod"]).toBeUndefined();
		expect(opts["plugin:site-forms:cfg:recipients"]).toBe('["agency@agency.example"]');
		expect(opts["emdash:preview_secret"]).toBe('"stg-preview-secret"');
		expect(opts["plugin:site-forms:cfg:crm"]).toBeUndefined();
		expect(rows(stg, "SELECT user_id, avatar_media_id FROM _emdash_bylines")).toEqual([{ user_id: null, avatar_media_id: "m1" }]);
	});
});

describe("sync-staging refusals", () => {
	it("no staging, unrecorded resources, shared database or bucket", () => {
		expect(syncRefusals(false, CF)[0]).toMatch(/one environment/);
		expect(syncRefusals(true, CF)).toEqual([]);
		expect(syncRefusals(true, { production: CF.production }).join("\n")).toMatch(/staging D1/);
		expect(syncRefusals(true, { ...CF, staging: { ...CF.staging, d1: { id: "prod-db-id", name: "acme-staging-db" } } }).join("\n")).toMatch(/staging's D1 database id is production's/);
		expect(syncRefusals(true, { ...CF, production: { ...CF.production, restoreDrill: { id: "stg-db-id" } } }).join("\n")).toMatch(/database id is production's/);
		expect(syncRefusals(true, { ...CF, staging: { ...CF.staging, d1: { id: "other", name: "acme-db" } } }).join("\n")).toMatch(/same D1 database/);
		expect(syncRefusals(true, { ...CF, staging: { ...CF.staging, r2: { bucket: "acme-media" } } }).join("\n")).toMatch(/share the R2 bucket acme-media/);
		expect(syncRefusals(true, { ...CF, staging: { ...CF.staging, sessions: { bucket: "acme-sessions" } }, production: { ...CF.production, sessions: { bucket: "acme-sessions" } } }).join("\n")).toMatch(/share the R2 bucket acme-sessions/);
		// Same bucket name in two different accounts are two buckets.
		expect(syncRefusals(true, { ...CF, staging: { ...CF.staging, accountId: "acct-2", r2: { bucket: "acme-media" } } })).toEqual([]);
	});

	it("the write chokepoints never accept a production target", () => {
		expect(() => assertStagingDatabase("prod-db-id", CF)).toThrow(/production/);
		expect(() => assertStagingDatabase("someone-else", CF)).toThrow(/not staging/);
		expect(() => assertStagingDatabase("stg-db-id", CF)).not.toThrow();
		expect(() => assertStagingBucket("acme-media", CF)).toThrow(/production bucket/);
		expect(() => assertStagingBucket("acme-stg-media", CF)).not.toThrow();
	});

	it("the default Wrangler runner only runs a remote file import", async () => {
		await expect(defaultRunWrangler(["d1", "export", "acme-db", "--remote", "--output", "x.sql"], "/tmp", {})).rejects.toThrow(/Refused/);
		await expect(defaultRunWrangler(["deploy"], "/tmp", {})).rejects.toThrow(/Refused/);
	});

	it("the REST reader refuses a write before sending it", async () => {
		let sent = 0;
		const q = d1Reader((async () => (sent++, new Response("{}"))) as typeof fetch, { token: "t", accountId: "a", databaseId: "prod-db-id" });
		await expect(q("DELETE FROM users")).rejects.toThrow(/Refused/);
		expect(sent).toBe(0);
	});
});

describe("wp2emdash sync-staging (command, fake Cloudflare)", () => {
	let dir: string;
	let sites: string;
	const slug = "acme";
	let prod: DatabaseSync;
	let stg: DatabaseSync;
	const now = () => new Date(Date.UTC(2026, 10, 22, 12, 0, 0));
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-sync-"));
		sites = join(dir, "sites");
		initSite({ slug, name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, sites);
		writeFileSync(join(sitePaths(slug, sites).root, "cloudflare.json"), JSON.stringify(CF));
		prod = production();
		stg = staging();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("dry run by default: prints counts, writes nothing anywhere, logs no row contents", async () => {
		const cloud = fakeCloud(prod, stg);
		const lines: string[] = [];
		const seen: { args: string[]; sql: string; config: unknown; env: Record<string, string> }[] = [];
		const before = { prod: dump(prod), stg: dump(stg) };
		const r = await syncStaging(slug, { sitesDir: sites, vars: VARS, log: (l) => lines.push(l) }, { fetcher: cloud.fetcher, runWrangler: fakeWrangler(stg, seen), now });
		expect(r.exitCode).toBe(0);
		expect(r.applied).toBe(false);
		expect(seen).toEqual([]);
		expect(dump(prod)).toBe(before.prod);
		expect(dump(stg)).toBe(before.stg);
		expect(cloud.calls.filter((c) => c.method !== "POST" || !c.url.endsWith("/query"))).toEqual([]); // no bookmark, no R2, no settings
		expect(r.plan?.tables.find((t) => t.table === "ec_pages")).toEqual({ table: "ec_pages", action: "replace", production: 3, staging: 2 });
		expect(r.plan?.tables.find((t) => t.table === "options")).toMatchObject({ production: 5, staging: 2 });
		expect(r.plan?.mediaFiles).toBe(3);
		expect(r.next.join(" ")).toMatch(/--yes/);
		const text = lines.join("\n") + syncReport(r) + JSON.stringify(r);
		for (const secret of [PAGE_TITLE, "O'Brien", "owner@client.example", "crm-secret", "visitor@example.com", VARS.CLOUDFLARE_API_TOKEN]) expect(text).not.toContain(secret);
		expect(existsSync(join(sitePaths(slug, sites).root, "sync"))).toBe(false);
	});

	it("--yes: bookmarks staging first, copies media (production GET only), imports atomically, purges, never touches production", async () => {
		const cloud = fakeCloud(prod, stg);
		const lines: string[] = [];
		const seen: { args: string[]; sql: string; config: unknown; env: Record<string, string> }[] = [];
		const prodBefore = dump(prod);
		const r = await syncStaging(slug, { sitesDir: sites, vars: VARS, yes: true, log: (l) => lines.push(l) }, { fetcher: cloud.fetcher, runWrangler: fakeWrangler(stg, seen), now });
		expect(r.exitCode).toBe(0);
		expect(r.applied).toBe(true);
		expect(dump(prod)).toBe(prodBefore);
		// Every production call was a read.
		for (const c of cloud.calls.filter((x) => x.url.includes("prod-db-id"))) {
			expect(c.url.endsWith("/query")).toBe(true);
			expect(() => assertReadOnly(c.sql as string)).not.toThrow();
		}
		expect(cloud.calls.filter((c) => c.url.includes("/acme-media/")).every((c) => c.method === "GET")).toBe(true);
		// Bookmark of staging before the import; never of production.
		const bmIdx = cloud.calls.findIndex((c) => c.url.endsWith("stg-db-id/time_travel/bookmark"));
		expect(bmIdx).toBeGreaterThanOrEqual(0);
		expect(cloud.calls.some((c) => c.url.includes("prod-db-id/time_travel"))).toBe(false);
		expect(r.bookmark?.restore).toBe("npx wrangler d1 time-travel restore acme-staging-db --bookmark=bm-stg-db-id");
		expect(readFileSync(join(sitePaths(slug, sites).root, "sync", "d1-bookmarks.jsonl"), "utf8")).toContain("bm-stg-db-id");
		// One import, addressed by staging's id through a one-binding config, with staging credentials.
		expect(seen).toHaveLength(1);
		expect(seen[0]?.args.slice(0, 4)).toEqual(["d1", "execute", "acme-staging-db", "--remote"]);
		expect(seen[0]?.config).toMatchObject({ d1_databases: [{ binding: "DB", database_name: "acme-staging-db", database_id: "stg-db-id" }] });
		expect(seen[0]?.env).toEqual({ CLOUDFLARE_API_TOKEN: VARS.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: "acct-1" });
		expect(existsSync(seen[0]?.args[seen[0].args.indexOf("--file") + 1] as string)).toBe(false); // temp file removed
		// Media: the same-size file is skipped, the missing one copied, backups never.
		expect(r.media).toMatchObject({ records: 3, files: 2, copied: 1, alreadyThere: 1, failed: 0 });
		expect(Object.keys(cloud.stgObjects).sort()).toEqual(["01ABC.jpg", "01DEF.png"]);
		// Content replaced; staging users, auth and form data kept.
		expect(rows(stg, "SELECT id, title FROM ec_pages ORDER BY id").map((x) => x.id)).toEqual(["p1", "p2", "p3"]);
		expect(rows(stg, "SELECT email FROM users").map((x) => x.email)).toEqual(["agency@agency.example"]);
		expect(rows(stg, "SELECT id FROM _plugin_storage").map((x) => x.id)).toEqual(["s1"]);
		expect(rows(stg, "SELECT value FROM options WHERE name = 'site:staging'")[0]?.value).toBe("true");
		expect(r.verify?.every((v) => v.expected === v.actual)).toBe(true);
		// Cache purge: the settings saved back unchanged.
		expect(cloud.saved()).toEqual({ title: "Acme" });
		expect(r.purge?.done).toBe(true);
		const text = lines.join("\n") + syncReport(r) + JSON.stringify(r);
		for (const secret of [PAGE_TITLE, "O'Brien", "owner@client.example", "crm-secret", VARS.CLOUDFLARE_API_TOKEN, VARS.EMDASH_TOKEN]) expect(text).not.toContain(secret);
	});

	it("refuses (exit 2) for a site without staging, or staging sharing production's database", async () => {
		const cloud = fakeCloud(prod, stg);
		const root = sitePaths(slug, sites).root;
		writeFileSync(join(root, "cloudflare.json"), JSON.stringify({ production: CF.production }));
		const none = await syncStaging(slug, { sitesDir: sites, vars: VARS, yes: true }, { fetcher: cloud.fetcher, now });
		expect(none.exitCode).toBe(2);
		expect(none.refusals[0]).toMatch(/one environment/);
		writeFileSync(join(root, "cloudflare.json"), JSON.stringify({ ...CF, staging: { ...CF.staging, d1: { id: "prod-db-id", name: "acme-staging-db" } } }));
		const shared = await syncStaging(slug, { sitesDir: sites, vars: VARS, yes: true }, { fetcher: cloud.fetcher, now });
		expect(shared.exitCode).toBe(2);
		expect(shared.refusals.join(" ")).toMatch(/production's/);
		expect(cloud.calls).toEqual([]);
	});

	it("no bookmark, no write; a failed import leaves staging unchanged and logs without secrets", async () => {
		const seen: { args: string[]; sql: string; config: unknown; env: Record<string, string> }[] = [];
		const noBm = await syncStaging(slug, { sitesDir: sites, vars: VARS, yes: true }, { fetcher: fakeCloud(prod, stg, { bookmarkFails: true }).fetcher, runWrangler: fakeWrangler(stg, seen), now });
		expect(noBm.exitCode).toBe(1);
		expect(noBm.error).toMatch(/bookmark failed/);
		expect(seen).toEqual([]);
		const stgBefore = dump(stg);
		stg.exec("CREATE TRIGGER no_pages BEFORE INSERT ON ec_pages BEGIN SELECT RAISE(ABORT, 'boom'); END;");
		const failed = await syncStaging(slug, { sitesDir: sites, vars: VARS, yes: true, media: false }, { fetcher: fakeCloud(prod, stg).fetcher, runWrangler: fakeWrangler(stg, seen), now });
		expect(failed.exitCode).toBe(1);
		stg.exec("DROP TRIGGER no_pages");
		expect(dump(stg)).toBe(stgBefore);
		const logFile = failed.next.join(" ").match(/sync\/\S+-wrangler\.log/)?.[0] as string;
		const log = readFileSync(join(sitePaths(slug, sites).root, logFile), "utf8");
		expect(log).toContain("boom");
		expect(log).not.toContain(VARS.CLOUDFLARE_API_TOKEN);
	});

	it("copyMedia writes only to staging's bucket", async () => {
		await expect(copyMedia(fakeCloud(prod, stg).fetcher, { prod: { token: "t", accountId: "acct-1", bucket: "acme-media" }, stg: { token: "t", accountId: "acct-1", bucket: "acme-media" }, objects: [], cf: CF })).rejects.toThrow(/production bucket/);
	});
});

describe("upgrade --deploy-staging --sync-staging", () => {
	let dir: string;
	let sites: string;
	const slug = "acme";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-upgrade-sync-"));
		sites = join(dir, "sites");
		initSite({ slug, name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, sites);
		writeFileSync(join(sitePaths(slug, sites).root, "cloudflare.json"), JSON.stringify(CF));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const order: string[] = [];
	const fetcher = (async (u: string | URL | Request) => {
		order.push(`snapshot ${new URL(String(u)).host}`);
		return new Response("<html><title>x</title></html>", { status: 200, headers: { "content-type": "text/html" } });
	}) as typeof fetch;

	it("without --yes: shows the sync plan and stops before any snapshot, rebuild or deploy", async () => {
		order.length = 0;
		let yes: boolean | undefined;
		const r = await upgrade(slug, { sitesDir: sites, deployStaging: true, syncStaging: true }, { fetcher, syncStaging: async (_s, o) => ((yes = o.yes), order.push("sync"), { slug, applied: false, refusals: [], next: [], exitCode: 0 }), runScaffold: async () => (order.push("scaffold"), { ok: true, runId: "r", checks: [] }), runScript: async () => (order.push("deploy"), { code: 0, out: "" }) });
		expect(yes).toBe(false);
		expect(order).toEqual(["sync"]);
		expect(r.exitCode).toBe(1);
		expect(r.next.join(" ")).toMatch(/--sync-staging --yes/);
	});

	it("with --yes: the sync runs before the staging before-snapshot", async () => {
		order.length = 0;
		const r = await upgrade(slug, { sitesDir: sites, deployStaging: true, syncStaging: true, yes: true }, { fetcher, sleep: async () => {}, syncStaging: async (_s, o) => (order.push(`sync yes=${o.yes}`), { slug, applied: true, refusals: [], next: [], exitCode: 0 }), runScaffold: async () => (order.push("scaffold"), { ok: true, runId: "r", checks: [] }), runScript: async () => (order.push("deploy"), { code: 0, out: "" }) });
		expect(order[0]).toBe("sync yes=true");
		const firstStaging = order.findIndex((x) => x.startsWith("snapshot acme-staging"));
		expect(firstStaging).toBeGreaterThan(0);
		expect(firstStaging).toBeLessThan(order.indexOf("scaffold"));
		expect(r.syncStaging?.applied).toBe(true);
	});

	it("needs --deploy-staging and a site with staging", async () => {
		const runScaffold = async () => ({ ok: true, runId: "r", checks: [] });
		const noDeploy = await upgrade(slug, { sitesDir: sites, syncStaging: true }, { fetcher, runScaffold, syncStaging: async () => { throw new Error("must not run"); } });
		expect(noDeploy.exitCode).toBe(1);
		expect(noDeploy.error).toMatch(/without --deploy-staging/);
		writeFileSync(join(sitePaths(slug, sites).root, "cloudflare.json"), JSON.stringify({ production: CF.production }));
		const single = await upgrade(slug, { sitesDir: sites, deployStaging: true, syncStaging: true }, { fetcher, runScaffold, syncStaging: async () => { throw new Error("must not run"); } });
		expect(single.exitCode).toBe(1);
		expect(single.error).toMatch(/no staging/);
	});
});
