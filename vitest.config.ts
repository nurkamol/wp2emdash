import { defineConfig } from "vitest/config";

export default defineConfig({
	// Tests also import plain starter modules (starter/src/forms/*.ts); the starter's tsconfig extends Astro's,
	// which is only installed in generated projects, so the transform skips tsconfig lookup.
	oxc: { tsconfig: false },
	// Agent worktrees (.claude/worktrees) hold full copies of the repo: their tests are not this checkout's.
	test: { exclude: ["**/node_modules/**", "**/.claude/**", "sites/**"] },
	// Starter modules that run inside the generated site import these; tests use small stand-ins.
	// "emdash/middleware" before "emdash": an alias also matches its subpaths, and the first match wins.
	// Kit packages importing each other (@wp2emdash/health → forms, seo) resolve to their sources, as `link:` does in a site.
	resolve: {
		alias: [
			{ find: "emdash/runtime", replacement: new URL("./test/stubs/emdash-runtime.ts", import.meta.url).pathname },
			{ find: "emdash/middleware", replacement: new URL("./test/stubs/emdash-middleware.ts", import.meta.url).pathname },
			{ find: /^emdash$/, replacement: new URL("./test/stubs/emdash.ts", import.meta.url).pathname },
			{ find: "cloudflare:workers", replacement: new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname },
			{ find: "@cf-wasm/satori", replacement: new URL("./test/stubs/cf-wasm-satori.ts", import.meta.url).pathname },
			{ find: "@cf-wasm/resvg", replacement: new URL("./test/stubs/cf-wasm-resvg.ts", import.meta.url).pathname },
			{ find: /^@wp2emdash\/(forms|seo|consent)\/(.+)$/, replacement: `${new URL("./packages/", import.meta.url).pathname}$1/src/$2.ts` },
		],
	},
});
