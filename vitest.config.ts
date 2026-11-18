import { defineConfig } from "vitest/config";

export default defineConfig({
	// Tests also import plain starter modules (starter/src/forms/*.ts); the starter's tsconfig extends Astro's,
	// which is only installed in generated projects, so the transform skips tsconfig lookup.
	oxc: { tsconfig: false },
});
