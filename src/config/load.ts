import { pathToFileURL } from "node:url";
import { type KitConfig, kitConfigSchema } from "./schema.js";

/** Loads and validates sites/<slug>/kit.config.ts (the CLI runs under tsx, so .ts imports work). */
export async function loadConfig(file: string): Promise<KitConfig> {
	const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
	const result = kitConfigSchema.safeParse(mod.default);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
		throw new Error(`Invalid config in ${file}:\n${issues}`);
	}
	return withDefaults(result.data, mod.default);
}

/**
 * Defaults that depend on more than one field. Form messages (the forms outbox) is on by default — messages that could
 * not be emailed are kept and retried, and the admin gets Plugins → Form messages — except on sensitiveData sites, where
 * storing visitors' text is an owner decision; `forms: { outbox: false }` turns it off anywhere.
 */
export function withDefaults(c: KitConfig, raw: unknown): KitConfig {
	const rawOutbox = (raw as { forms?: { outbox?: unknown } } | undefined)?.forms?.outbox;
	if (rawOutbox === undefined && !c.sensitiveData && !c.forms.outbox) c.forms.outbox = { days: 30, hold: false, keepSent: false };
	return c;
}
