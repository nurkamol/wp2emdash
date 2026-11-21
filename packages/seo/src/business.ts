/**
 * The admin switch for the footer's business details (name, address, phone, hours: starter BusinessInfo.astro), on the
 * Site checks tab of SEO & Analytics. Some sites do not want the block; the owner turns it off here without a rebuild.
 *
 * Storage: the SEO plugin's KV key `business` = `{ footer: boolean, updatedAt, updatedBy? }` — in EmDash 1.5 a row of the
 * `options` table named `plugin:<pluginId>:business` (see analytics/store.ts). The site reads that row with the chrome
 * on a route-cache miss; saving purges the cached pages with the analytics tags every page carries (PURGE_TAGS).
 *
 * Never saved, or unreadable: the block shows (what the site was built with). The switch only appears on sites built
 * with the block (kit.config `business.footer`, and the migrated footer does not already show the address).
 */
import { SEO_PLUGIN } from "./meta.js";

export const BUSINESS_KEY = "business";
export const BUSINESS_OPTION = `plugin:${SEO_PLUGIN.id}:${BUSINESS_KEY}`;

export interface StoredBusiness {
	footer: boolean;
	updatedAt: string;
	updatedBy?: string;
}

export function parseBusiness(v: unknown): StoredBusiness | undefined {
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	if (typeof o.footer !== "boolean") return undefined;
	return { footer: o.footer, updatedAt: typeof o.updatedAt === "string" ? o.updatedAt.slice(0, 40) : "", ...(typeof o.updatedBy === "string" ? { updatedBy: o.updatedBy.slice(0, 80) } : {}) };
}

interface D1Like {
	prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

/** Whether the footer block shows: false only when an admin turned it off (a failed read keeps it on). */
export async function readBusinessFooter(db: D1Like | undefined): Promise<boolean> {
	if (!db) return true;
	try {
		const row = await db.prepare("SELECT value FROM options WHERE name = ? LIMIT 1").bind(BUSINESS_OPTION).first<{ value: string }>();
		return row ? (parseBusiness(JSON.parse(row.value))?.footer ?? true) : true;
	} catch {
		return true;
	}
}

type Block = Record<string, unknown>;

/** The Site checks tab section: a toggle for admins, the state for editors. */
export function businessFooterBlocks(s: { on: boolean; admin: boolean; stored?: StoredBusiness }): Block[] {
	const last = s.stored?.updatedBy ? ` Last change ${s.stored.updatedAt.slice(0, 16).replace("T", " ")} UTC by ${s.stored.updatedBy}.` : "";
	return [
		{ type: "divider" },
		{ type: "header", text: "Business details in the footer" },
		{ type: "context", text: `The business name, address, phone, email and opening hours at the bottom of every page, from the same details Google reads in the page's structured data. Visible contact details help local search; turn it off when the footer already shows them in its own design.${last}` },
		s.admin
			? { type: "form", block_id: "biz-footer", fields: [{ type: "toggle", action_id: "footer", label: "Show business details in the footer", initial_value: s.on }], submit: { label: "Save", action_id: "biz-footer" } }
			: { type: "fields", fields: [{ label: "Business details in the footer", value: s.on ? "On" : "Off" }] },
		...(s.admin ? [] : [{ type: "context", text: "Only administrators can change this." }]),
	];
}
