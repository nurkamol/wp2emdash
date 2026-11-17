#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so site configs (kit.config.ts) can be imported directly.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const res = spawnSync(tsx, [join(root, "src", "cli", "index.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
