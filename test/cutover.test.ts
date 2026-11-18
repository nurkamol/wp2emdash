import { describe, expect, it } from "vitest";
import { runbook } from "../src/phases/cutover.js";

describe("cutover runbook", () => {
	const md = runbook({ domain: "example.com", worker: "example", zoneId: "z123", apexFirst: true });
	it("switches with routes for apex and www to the production Worker", () => {
		expect(md).toContain("ZONE=z123");
		expect(md).toContain("for host in example.com www.example.com");
		expect(md).toContain('\\"script\\":\\"example\\"');
	});
	it("rolls back by deleting only this Worker's routes, never DNS", () => {
		expect(md).toMatch(/r\.script==="example"/);
		expect(md).toContain("-X DELETE");
		expect(md).not.toMatch(/dns_records/);
	});
});
