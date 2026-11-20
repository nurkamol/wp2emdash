/**
 * Read chosen WordPress options from a MySQL dump (a host or plugin backup's database.sql) without a database or PHP:
 * a streaming scan of the `<prefix>options` INSERT statements and a PHP `unserialize` for the values.
 *
 * Only option names on the caller's allow-list are returned — never anything else in the dump (form entries, users,
 * licence keys). Used for builder settings the REST API does not serve (Bricks palette / global classes / theme
 * styles / components, Salient Redux options).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** PHP serialize() → JS (strings, ints, floats, bools, null, arrays → arrays or objects, objects → plain objects). */
export function phpUnserialize(input: string): unknown {
	// PHP string lengths are in bytes: work on the UTF-8 bytes.
	const buf = Buffer.from(input, "utf8");
	let i = 0;
	const fail = (msg: string) => new Error(`unserialize: ${msg} at byte ${i}`);
	const readUntil = (ch: string) => {
		const end = buf.indexOf(ch, i);
		if (end < 0) throw fail(`expected "${ch}"`);
		const s = buf.subarray(i, end).toString("utf8");
		i = end + 1;
		return s;
	};
	const expect = (ch: string) => {
		if (String.fromCharCode(buf[i] ?? 0) !== ch) throw fail(`expected "${ch}"`);
		i++;
	};
	const value = (): unknown => {
		const t = String.fromCharCode(buf[i] ?? 0);
		i += 2; // type + ':' (or ';' for N)
		switch (t) {
			case "N":
				return null;
			case "b":
				return readUntil(";") === "1";
			case "i":
				return Number.parseInt(readUntil(";"), 10);
			case "d":
				return Number.parseFloat(readUntil(";"));
			case "s": {
				const len = Number.parseInt(readUntil(":"), 10);
				expect('"');
				const s = buf.subarray(i, i + len).toString("utf8");
				i += len;
				expect('"');
				expect(";");
				return s;
			}
			case "a":
			case "O": {
				if (t === "O") {
					readUntil(":"); // class name length
					readUntil(":"); // "Class":
				}
				const n = Number.parseInt(readUntil(":"), 10);
				expect("{");
				const entries: [string | number, unknown][] = [];
				for (let k = 0; k < n; k++) entries.push([value() as string | number, value()]);
				expect("}");
				const isList = t === "a" && entries.every(([key], idx) => key === idx);
				return isList ? entries.map(([, v]) => v) : Object.fromEntries(entries.map(([key, v]) => [String(key), v]));
			}
			default:
				throw fail(`unknown type "${t}"`);
		}
	};
	const out = value();
	return out;
}

/** A MySQL string literal's body (between the quotes) → the raw text. */
function unescapeMysql(s: string): string {
	return s.replace(/\\(.)/g, (_, c: string) => ({ "0": "\0", n: "\n", r: "\r", t: "\t", Z: "\x1a", b: "\b" })[c as "n"] ?? c);
}

/** Tuples of one `VALUES (…),(…);` statement → arrays of raw cell strings (NULL → null). */
export function parseValues(sql: string): (string | null)[][] {
	const rows: (string | null)[][] = [];
	let i = sql.indexOf("VALUES");
	if (i < 0) return rows;
	i += 6;
	let row: (string | null)[] | null = null;
	while (i < sql.length) {
		const c = sql[i];
		if (c === "(" && !row) {
			row = [];
			i++;
		} else if (row && c === "'") {
			let j = i + 1;
			let body = "";
			while (j < sql.length) {
				const d = sql[j];
				if (d === "\\") {
					body += sql.slice(j, j + 2);
					j += 2;
				} else if (d === "'" && sql[j + 1] === "'") {
					body += "\\'";
					j += 2;
				} else if (d === "'") break;
				else {
					body += d;
					j++;
				}
			}
			row.push(unescapeMysql(body));
			i = j + 1;
		} else if (row && (c === "," || c === " " || c === "\n" || c === "\r" || c === "\t")) i++;
		else if (row && c === ")") {
			rows.push(row);
			row = null;
			i++;
		} else if (row) {
			const m = /^[^,)]+/.exec(sql.slice(i, i + 64));
			const tok = (m?.[0] ?? "").trim();
			row.push(tok.toUpperCase() === "NULL" ? null : tok);
			i += m?.[0].length ?? 1;
		} else i++;
	}
	return rows;
}

/**
 * Stream a dump and return the allow-listed options (decoded when serialized). The options table is found by name
 * (`<anything>options`) and its columns by the dump's own CREATE TABLE when present, else WordPress's default order
 * (option_id, option_name, option_value, autoload).
 */
export async function readOptionsFromDump(file: string, allow: readonly string[]): Promise<Record<string, unknown>> {
	const want = new Set(allow);
	const out: Record<string, unknown> = {};
	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
	let cols: string[] = ["option_id", "option_name", "option_value", "autoload"];
	let inCreate = false;
	let createCols: string[] = [];
	let pending = "";
	for await (const line of rl) {
		if (/^CREATE TABLE `[A-Za-z0-9_]*options`/.test(line)) {
			inCreate = true;
			createCols = [];
			continue;
		}
		if (inCreate) {
			const m = /^\s+`([a-z_]+)`/.exec(line);
			if (m?.[1]) createCols.push(m[1]);
			if (/^\)/.test(line)) {
				inCreate = false;
				if (createCols.includes("option_name")) cols = createCols;
			}
			continue;
		}
		if (!pending && !/^INSERT INTO `[A-Za-z0-9_]*options`/.test(line)) continue;
		pending += pending ? `\n${line}` : line;
		if (!/\);\s*$/.test(line)) continue; // statement continues on the next line
		const stmt = pending;
		pending = "";
		const ni = cols.indexOf("option_name");
		const vi = cols.indexOf("option_value");
		for (const row of parseValues(stmt)) {
			const name = row[ni];
			if (!name || !want.has(name)) continue;
			const raw = row[vi] ?? "";
			let value: unknown = raw;
			if (/^(a|O|s|i|d|b):|^N;$/.test(raw)) {
				try {
					value = phpUnserialize(raw);
				} catch {
					value = raw;
				}
			} else if (/^[[{]/.test(raw)) {
				try {
					value = JSON.parse(raw);
				} catch {
					value = raw;
				}
			}
			out[name] = value;
		}
	}
	return out;
}

/**
 * Stream a dump and return every row of the tables whose name ends with one of `suffixes` (after the table prefix:
 * `wp_fbv` matches "fbv", `wp_fbv_attachment_folder` does not), as objects keyed by the dump's own CREATE TABLE columns.
 * Only those tables are parsed; nothing else in the dump is read into memory. Rows of a table without a CREATE TABLE
 * in the dump are keyed by `fallbackColumns[suffix]` when given, else skipped.
 */
export async function readTablesFromDump(file: string, suffixes: readonly string[], fallbackColumns: Record<string, string[]> = {}): Promise<Record<string, Record<string, string | null>[]>> {
	const out: Record<string, Record<string, string | null>[]> = {};
	const match = (table: string) => suffixes.find((s) => table === s || table.endsWith(`_${s}`));
	const cols = new Map<string, string[]>();
	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
	let creating: string | undefined;
	let createCols: string[] = [];
	let pending = "";
	let pendingSuffix = "";
	for await (const line of rl) {
		if (creating) {
			const m = /^\s+`([A-Za-z0-9_]+)`/.exec(line);
			if (m?.[1]) createCols.push(m[1]);
			if (/^\)/.test(line)) {
				cols.set(creating, createCols);
				creating = undefined;
			}
			continue;
		}
		const ct = /^CREATE TABLE (?:IF NOT EXISTS )?`([A-Za-z0-9_]+)`/.exec(line);
		if (ct?.[1]) {
			const s = match(ct[1]);
			if (s) {
				creating = s;
				createCols = [];
			}
			continue;
		}
		if (!pending) {
			const ins = /^INSERT INTO `([A-Za-z0-9_]+)`/.exec(line);
			const s = ins?.[1] ? match(ins[1]) : undefined;
			if (!s) continue;
			pendingSuffix = s;
		}
		pending += pending ? `\n${line}` : line;
		if (!/\);\s*$/.test(line)) continue;
		const stmt = pending;
		pending = "";
		const listed = /^INSERT INTO `[A-Za-z0-9_]+`\s*\(([^)]*)\)\s*VALUES/.exec(stmt)?.[1];
		const names = listed ? [...listed.matchAll(/`([A-Za-z0-9_]+)`/g)].map((m) => m[1] as string) : (cols.get(pendingSuffix) ?? fallbackColumns[pendingSuffix]);
		if (!names) continue;
		const list = (out[pendingSuffix] ??= []);
		for (const row of parseValues(stmt)) list.push(Object.fromEntries(names.map((c, i) => [c, row[i] ?? null])));
	}
	return out;
}
