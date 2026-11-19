import { defineConfig } from "vitest/config";

export default defineConfig({
	// Tests also import plain starter modules (starter/src/forms/*.ts); the starter's tsconfig extends Astro's,
	// which is only installed in generated projects, so the transform skips tsconfig lookup.
	oxc: { tsconfig: false },
	// Starter modules that run inside the generated site import these; tests use small stand-ins.
	resolve: { alias: { emdash: new URL("./test/stubs/emdash.ts", import.meta.url).pathname, "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname } },
});
