import { defineConfig } from "vitest/config";

export default defineConfig({
	// Tests also import plain starter modules (starter/src/forms/*.ts); the starter's tsconfig extends Astro's,
	// which is only installed in generated projects, so the transform skips tsconfig lookup.
	oxc: { tsconfig: false },
	// Starter modules that run inside the generated site import these; tests use small stand-ins.
	// "emdash/middleware" before "emdash": an alias also matches its subpaths, and the first match wins.
	resolve: { alias: { "emdash/middleware": new URL("./test/stubs/emdash-middleware.ts", import.meta.url).pathname, emdash: new URL("./test/stubs/emdash.ts", import.meta.url).pathname, "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname, "@cf-wasm/satori": new URL("./test/stubs/cf-wasm-satori.ts", import.meta.url).pathname, "@cf-wasm/resvg": new URL("./test/stubs/cf-wasm-resvg.ts", import.meta.url).pathname } },
});
