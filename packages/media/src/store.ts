/**
 * What the plugin keeps (EmDash plugin KV: one D1 `options` row per key, JSON): the last scan, its counts for Site
 * health, settings, alt text suggestions, the trash ledger, the optimize log, the upload queue, Images transformations
 * counted per month, and short-lived confirmation plans. File names, ids, sizes and dates only — no content.
 */
import type { Suggestion } from "./alt.js";
import { SUMMARY_KEY } from "./meta.js";

export interface Kv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list?(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

export const KEYS = {
	report: "report",
	summary: SUMMARY_KEY,
	settings: "settings",
	suggestions: "alt:suggestions",
	rejected: "alt:rejected",
	trash: "trash",
	optimized: "optimized",
	queue: "queue",
	ai: "ai",
	transforms: (month: string) => `transforms:${month}`,
	plan: (token: string) => `plan:${token}`,
} as const;

export interface Settings {
	aiAlt?: boolean;
	autoOptimize?: boolean;
	maxDimension?: number;
}

export interface TrashEntry {
	id: string;
	filename: string;
	size: number | null;
	at: string;
	/** Undo possible until (30 days); afterwards an editor may delete it for good. */
	until: string;
	/** The folder it came from (null: no folder). */
	from: string | null;
	by?: string;
}

export interface OptimizedEntry {
	id: string;
	filename: string;
	at: string;
	before: number;
	after: number;
	width: number;
	height: number;
	backup: string;
	until: string;
	restored?: string;
}

export interface AiState {
	/** The model's licence must be accepted once per account (Meta Llama 3.2). */
	needsAgreement?: boolean;
	agreedAt?: string;
	lastError?: string;
}

export type PlanKind = "optimize" | "trash" | "delete" | "restore-original";
export interface Plan {
	kind: PlanKind;
	ids: string[];
	/** restore-original: the backup key per id. */
	keys?: Record<string, string>;
	until: string;
	user?: string;
}

export const TRASH_DAYS = 30;
export const PLAN_MS = 10 * 60_000;
export const MAX_SUGGESTIONS = 200;
export const MAX_LOG = 200;

export const getList = async <T>(kv: Kv, key: string): Promise<T[]> => (await kv.get<T[]>(key)) ?? [];

export async function grantPlan(kv: Kv, p: Omit<Plan, "until">, now = Date.now()): Promise<string> {
	const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
	for (const { key, value } of (await kv.list?.("plan:")) ?? []) if (!(Date.parse((value as Plan | null)?.until ?? "") >= now)) await kv.delete(key);
	await kv.set(KEYS.plan(token), { ...p, until: new Date(now + PLAN_MS).toISOString() } satisfies Plan);
	return token;
}

/** A confirmation plan, once, unexpired, of the expected kind, made by the same person. */
export async function redeemPlan(kv: Kv, token: unknown, kind: PlanKind, user: string | undefined, now = Date.now()): Promise<Plan | undefined> {
	if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return undefined;
	const p = await kv.get<Plan>(KEYS.plan(token));
	if (!p) return undefined;
	await kv.delete(KEYS.plan(token));
	if (p.kind !== kind || Date.parse(p.until) < now || (p.user && p.user !== user)) return undefined;
	return p;
}

export type { Suggestion };
