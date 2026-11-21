/**
 * WebMCP form annotations (@wp2emdash/forms webmcp.ts): tool name and description from the form's own data, parameter
 * descriptions, sensitive forms and sites left out, the kit.config switch. All data is synthetic.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { commentTool, formTool, HONEYPOT_DESCRIPTION, paramDescription, searchTool, toolNameOf } from "../packages/forms/src/webmcp.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { workerVars } from "../src/phases/scaffold.js";

const booking: FormDefinition = {
	id: "fluent-forms-3",
	title: "Book a class",
	submitLabel: "Send request",
	successMessage: "Thanks.",
	fields: [
		{ name: "full_name", label: "Your name *", type: "text", required: true },
		{ name: "email", label: "Email:", type: "email", required: true },
		{ name: "class", label: "Class", type: "select", options: ["Mat", "Reformer"], required: true },
		{ name: "level", label: "Level", type: "radio", options: ["New", "Regular"] },
		{ name: "days", label: "Days that suit you", type: "checkbox", options: ["Mon", "Tue"] },
		{ name: "injury", label: "Tell us about it", type: "textarea", showIf: { field: "level", equals: ["New"] } },
		{ name: "cv", label: "Attachment", type: "file" },
		{ name: "waiver_text", label: "", type: "content", content: [] },
		{ name: "sig", label: "Signature", type: "signature", required: true },
		{ name: "terms", label: "Terms and Conditions", type: "consent", required: true },
	],
};
const f = (name: string) => booking.fields.find((x) => x.name === name)!;
const config = (o: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" }, email: { from: "Acme <noreply@acme.example>", to: ["owner@acme.example"] }, ...o });

describe("WebMCP form tool", () => {
	it("names the tool from the form id: stable, lowercase, underscores", () => {
		expect(toolNameOf("fluent-forms-3")).toBe("fluent_forms_3");
		expect(toolNameOf("Contact")).toBe("contact");
		expect(toolNameOf("42")).toBe("form_42");
		expect(toolNameOf("--")).toBe("form");
	});

	it("describes the form from its title, submit label, choice fields and file fields", () => {
		const t = formTool(booking, {});
		expect(t?.toolname).toBe("fluent_forms_3");
		expect(t?.tooldescription).toBe("Fill in the “Book a class” form on this page. The visitor checks the answers and presses “Send request” to send it. Choice fields: “Level” is level (pick one); “Days that suit you” is days (pick any). Files can only be attached by the visitor.");
		// Never submitted by the agent: the visitor presses Submit (Turnstile and the honeypot run as for a person).
		expect(t).not.toHaveProperty("toolautosubmit");
	});

	it("describes each parameter from its label, without the trailing * or :", () => {
		expect(paramDescription(f("full_name"), booking, {})).toBe("Your name");
		expect(paramDescription(f("email"), booking, {})).toBe("Email");
		expect(paramDescription(f("class"), booking, {})).toBe("Class");
		expect(paramDescription(f("terms"), booking, {})).toBe("Terms and Conditions");
		expect(paramDescription(f("sig"), booking, {})).toBe("Signature: type the visitor's full name as their signature");
	});

	it("says when a conditional field applies", () => {
		expect(paramDescription(f("injury"), booking, {})).toBe("Tell us about it. Only when “Level” is “New”");
		const not = { ...booking, fields: [f("level"), { ...f("injury"), showIf: { field: "level", equals: ["New", "Regular"], not: true } }] };
		expect(paramDescription(not.fields[1]!, not, {})).toBe("Tell us about it. Only when “Level” is not “New” or “Regular”");
	});

	it("gives no description to fields that are no parameters (file, content)", () => {
		expect(paramDescription(f("cv"), booking, {})).toBeUndefined();
		expect(paramDescription(f("waiver_text"), booking, {})).toBeUndefined();
	});

	it("does not expose a sensitive form, or any form of a sensitive site", () => {
		expect(formTool({ ...booking, sensitive: true }, {})).toBeUndefined();
		expect(paramDescription(f("email"), { ...booking, sensitive: true }, {})).toBeUndefined();
		expect(formTool(booking, { FORM_SENSITIVE: "1" })).toBeUndefined();
		expect(commentTool({ FORM_SENSITIVE: "1" }, "Post comment")).toBeUndefined();
		// Search covers public pages only: still a tool on a sensitive site.
		expect(searchTool({ FORM_SENSITIVE: "1" })?.toolname).toBe("search_site");
	});

	it("switch off removes every annotation", () => {
		const off = { FORM_WEBMCP: "0" };
		expect(formTool(booking, off)).toBeUndefined();
		expect(paramDescription(f("email"), booking, off)).toBeUndefined();
		expect(searchTool(off)).toBeUndefined();
		expect(commentTool(off, "Post comment")).toBeUndefined();
	});

	it("search submits itself (GET, no side effects); comments do not", () => {
		expect(searchTool({})).toEqual({ toolname: "search_site", tooldescription: expect.stringContaining("Search this website"), toolautosubmit: true });
		expect(commentTool({}, "Post comment")).toEqual({ toolname: "post_comment", tooldescription: "Write a public comment on this page. The visitor checks it and presses “Post comment” to post it." });
	});

	it("tells agents to leave the honeypot empty", () => {
		expect(HONEYPOT_DESCRIPTION).toMatch(/leave this empty/);
	});
});

describe("kit.config forms.webmcp", () => {
	it("is on by default: no Worker var", () => {
		expect(config().forms.webmcp).toBe(true);
		const v = workerVars(config(), { staging: true, productionHost: "acme.example" });
		expect(v.production).not.toHaveProperty("FORM_WEBMCP");
		expect(v.staging).not.toHaveProperty("FORM_WEBMCP");
	});

	it("false sets FORM_WEBMCP=0 in both environments", () => {
		const v = workerVars(config({ forms: { webmcp: false } }), { staging: true, productionHost: "acme.example" });
		expect(v.production.FORM_WEBMCP).toBe("0");
		expect(v.staging.FORM_WEBMCP).toBe("0");
	});
});

describe("starter markup", () => {
	const starter = (p: string) => readFileSync(new URL(`../starter/src/${p}`, import.meta.url), "utf8");
	it("annotates the form section, the comment form and search, with no inline script", () => {
		const form = starter("components/sections/Form.astro");
		expect(form).toContain("{...(tool ?? {})}");
		expect(form.match(/toolparamdescription=\{pd\(f\)\}/g)?.length).toBe(7);
		expect(form).toContain("toolparamdescription={tool ? HONEYPOT_DESCRIPTION : undefined}");
		expect(starter("components/comments/Comments.astro")).toContain("toolparamdescription={tool && HONEYPOT_DESCRIPTION}");
		expect(starter("pages/search.astro")).toContain("searchTool(env as WebMcpEnv)");
		for (const p of ["components/sections/Form.astro", "components/comments/Comments.astro", "pages/search.astro"]) expect(starter(p)).not.toMatch(/modelContext/);
	});
});
