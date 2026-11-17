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
	return result.data;
}
