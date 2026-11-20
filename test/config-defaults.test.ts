import { describe, expect, it } from "vitest";
import { withDefaults } from "../src/config/load.js";
import { kitConfigSchema } from "../src/config/schema.js";

const base = { slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" } };
const load = (raw: Record<string, unknown>) => withDefaults(kitConfigSchema.parse(raw), raw);

describe("Form messages default (forms outbox)", () => {
	it("is on (30 days, no hold, no full inbox) when unset on a normal site", () => {
		expect(load(base).forms.outbox).toEqual({ days: 30, hold: false, keepSent: false });
	});
	it("stays off on sensitive sites unless set", () => {
		expect(load({ ...base, sensitiveData: true }).forms.outbox).toBeUndefined();
		expect(load({ ...base, sensitiveData: true, forms: { outbox: { days: 14 } } }).forms.outbox).toMatchObject({ days: 14 });
	});
	it("forms.outbox: false turns it off anywhere", () => {
		expect(load({ ...base, forms: { outbox: false } }).forms.outbox).toBeUndefined();
	});
});
