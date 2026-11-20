/**
 * PHP `serialize()` → JSON values, for WordPress data the Exporter returns as stored text: ACF keeps each field's
 * settings as a serialized array in the `acf-field` post's content. Objects are never instantiated (they become plain
 * records, like PHP's `allowed_classes => false`); string lengths are byte counts (UTF-8). Throws on malformed input.
 */
export function phpUnserialize(input: string): unknown {
	const bytes = Buffer.from(input, "utf8");
	let at = 0;
	const fail = (why: string): never => {
		throw new Error(`php unserialize: ${why} at byte ${at}`);
	};
	const until = (ch: string) => {
		const end = bytes.indexOf(ch, at, "utf8");
		if (end < 0) fail(`missing "${ch}"`);
		const s = bytes.toString("utf8", at, end);
		at = end + 1;
		return s;
	};
	const expect = (ch: string) => {
		if (bytes.toString("utf8", at, at + ch.length) !== ch) fail(`expected "${ch}"`);
		at += ch.length;
	};
	const value = (): unknown => {
		const type = bytes.toString("utf8", at, at + 1);
		at += 1;
		switch (type) {
			case "N":
				expect(";");
				return null;
			case "b":
				expect(":");
				return until(";") === "1";
			case "i":
				expect(":");
				return Number.parseInt(until(";"), 10);
			case "d": {
				expect(":");
				const s = until(";");
				return s === "INF" ? Number.POSITIVE_INFINITY : s === "-INF" ? Number.NEGATIVE_INFINITY : Number.parseFloat(s);
			}
			case "s": {
				expect(":");
				const len = Number.parseInt(until(":"), 10);
				expect('"');
				const s = bytes.toString("utf8", at, at + len);
				at += len;
				expect('";');
				return s;
			}
			case "a": {
				expect(":");
				const n = Number.parseInt(until(":"), 10);
				expect("{");
				const entries: [string | number, unknown][] = [];
				for (let i = 0; i < n; i++) {
					const k = value();
					entries.push([k as string | number, value()]);
				}
				expect("}");
				// A list (keys 0..n-1 in order) becomes an array, anything else a record.
				return entries.every(([k], i) => k === i) ? entries.map(([, v]) => v) : Object.fromEntries(entries.map(([k, v]) => [String(k), v]));
			}
			case "O": {
				expect(":");
				until(":");
				expect('"');
				until('"');
				expect(":");
				const n = Number.parseInt(until(":"), 10);
				expect("{");
				const o: Record<string, unknown> = {};
				for (let i = 0; i < n; i++) {
					const k = String(value()).replace(/^\0[^\0]*\0/, "");
					o[k] = value();
				}
				expect("}");
				return o;
			}
			default:
				return fail(`unknown type "${type}"`);
		}
	};
	const out = value();
	return out;
}

/** Whether a string looks like PHP serialized data (as WordPress's `is_serialized`). */
export function isPhpSerialized(s: unknown): s is string {
	return typeof s === "string" && /^(?:N;|b:[01];|i:-?\d+;|d:[-\d.EINF]+;|s:\d+:".*";|a:\d+:\{.*\}|O:\d+:".*)$/s.test(s.trim());
}
