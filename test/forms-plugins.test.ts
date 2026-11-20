/**
 * Ninja Forms, Formidable, WS Form and Forminator exports (synthetic fixtures in test/fixtures/forms, goldens in
 * test/golden/forms; UPDATE_GOLDEN=1 rewrites them), the rendered-HTML fallback, and the shared pieces every parser
 * uses: file fields, simple conditional logic, steps and payment fields.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { showIfFrom, withSteps } from "../src/extract/form-logic.js";
import { formFromSnapshot, recognise } from "../src/extract/plugin-exports.js";
import { applySensitivePolicy, applyUploadPolicy, type FormDefinitionOut, fluentFormToDefinition } from "../src/scaffold/forms.js";

const hosts = ["studio.example"];
const fixture = (f: string) => readFileSync(new URL(`./fixtures/forms/${f}`, import.meta.url), "utf8");
const update = process.env.UPDATE_GOLDEN === "1";
function golden(name: string, value: unknown) {
	const file = new URL(`./golden/forms/${name}.json`, import.meta.url);
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (update || !existsSync(file)) {
		mkdirSync(new URL("./golden/forms/", import.meta.url), { recursive: true });
		writeFileSync(file, text);
	}
	expect(text).toBe(readFileSync(file, "utf8"));
}
const forms = (file: string) => {
	const r = recognise(file, fixture(file), hosts);
	if (r.kind !== "forms") throw new Error(`${file}: ${r.kind === "unknown" ? r.reason : r.kind}`);
	return r;
};

describe("Ninja Forms (.nff)", () => {
	const r = forms("ninja-form-3.nff");
	const d = r.forms[0]?.definition as FormDefinitionOut;
	it("recognises the file and takes the form id from the file name", () => {
		expect(r.provider).toBe("ninja-forms");
		expect(d.id).toBe("ninja-forms-3");
		golden("ninja-form-3", r.forms);
	});
	it("maps fields, steps (Multi-Part), the condition it can express and the upload limits", () => {
		expect(d.fields.map((f) => `${f.name}:${f.type}${f.required ? "*" : ""}@${f.step ?? 0}`)).toEqual(["first_name:text*@0", "last_name:text*@0", "email:email*@0", "phone:tel@0", "visit_type:radio*@1", "group_size:number*@1", "notes:textarea@1", "attachment:file@1"]);
		expect(d.steps).toEqual([{ title: "About you" }, { title: "Your visit" }]);
		expect(d.fields.find((f) => f.name === "group_size")?.showIf).toEqual({ field: "visit_type", equals: ["group"] });
		expect(d.fields.find((f) => f.name === "attachment")).toMatchObject({ accept: ["pdf", "jpg"], maxMb: 4 });
		expect(d.notes?.join()).toMatch(/Notes.*not carried.*greater/);
		expect(d.submitLabel).toBe("Request booking");
		expect(d.successMessage).toBe("Thanks, we will confirm your visit.");
	});
	it("reports the payment field (blocking) and counts recipients without copying them into the definition", () => {
		expect(d.warnings.join()).toMatch(/payment field "Day pass"/);
		expect(r.forms[0]?.recipients).toEqual(["frontdesk@studio.example"]);
		expect(JSON.stringify(d)).not.toMatch(/frontdesk/);
	});
});

describe("Formidable (XML)", () => {
	const r = forms("formidable-export.xml");
	it("reads every form but the templates", () => {
		expect(r.provider).toBe("formidable");
		expect(r.forms.map((f) => f.id)).toEqual(["7"]);
		golden("formidable-7", r.forms);
	});
	it("fields, page break, condition, uploads, payment, recipients", () => {
		const d = r.forms[0]?.definition as FormDefinitionOut;
		expect(d.fields.map((f) => `${f.name}:${f.type}@${f.step ?? 0}`)).toEqual(["your_name:text@0", "email:email@0", "contact_me_by:select@0", "phone:tel@0", "message:textarea@1", "fl7:file@1"]);
		expect(d.steps?.map((s) => s.title)).toEqual(["Step 1", "Details"]);
		expect(d.fields.find((f) => f.name === "phone")?.showIf).toEqual({ field: "contact_me_by", equals: ["Phone"] });
		expect(d.fields.find((f) => f.type === "file")).toMatchObject({ accept: ["pdf", "jpg", "jpeg", "jpe"], maxMb: 8, maxFiles: 3 });
		expect(d.warnings.join()).toMatch(/credit_card/);
		expect([d.submitLabel, d.successMessage]).toEqual(["Send it", "Got it, thank you."]);
		expect(r.forms[0]?.recipients).toEqual(["office@studio.example"]);
	});
});

describe("WS Form (JSON)", () => {
	const r = forms("ws-form-4.json");
	const d = r.forms[0]?.definition as FormDefinitionOut;
	it("groups are steps; choices, uploads; form-level conditions and prices reported", () => {
		expect(r.provider).toBe("ws-form");
		golden("ws-form-4", r.forms);
		expect(d.fields.map((f) => `${f.name}:${f.type}@${f.step ?? 0}`)).toEqual(["full_name:text@0", "email:email@0", "phone:tel@0", "plan:radio@1", "id_document:file@1"]);
		expect(d.steps?.map((s) => s.title)).toEqual(["Contact", "Membership"]);
		expect(d.fields[3]?.options).toEqual(["Monthly", "Yearly"]);
		expect(d.fields[4]).toMatchObject({ accept: ["pdf", "png"], maxMb: 6 });
		expect(d.notes?.join()).toMatch(/conditional logic/);
		expect(d.warnings.join()).toMatch(/price/);
		expect(d.submitLabel).toBe("Send enquiry");
	});
});

describe("Forminator (JSON)", () => {
	const r = forms("forminator-12.json");
	const d = r.forms[0]?.definition as FormDefinitionOut;
	it("fields, page break, conditions (one carried, one reported), upload limit, stripe", () => {
		expect(r.provider).toBe("forminator");
		expect(d.id).toBe("forminator-12");
		golden("forminator-12", r.forms);
		expect(d.fields.map((f) => `${f.name}:${f.type}${f.required ? "*" : ""}@${f.step ?? 0}`)).toEqual(["name_1:text*@0", "email:email*@0", "select_1:select@0", "textarea_1:textarea*@0", "upload_1:file@0", "gdprcheckbox_1:checkbox*@1"]);
		expect(d.fields[3]?.showIf).toEqual({ field: "select_1", equals: ["Complaint"] });
		expect(d.fields[4]?.showIf).toBeUndefined();
		expect(d.notes?.join()).toMatch(/Photo.*more than one field/);
		expect(d.fields[4]).toMatchObject({ accept: ["jpg", "png"], maxMb: 2 });
		expect(d.warnings.join()).toMatch(/stripe/);
		expect([d.submitLabel, d.successMessage]).toEqual(["Submit feedback", "Thanks for the feedback."]);
		expect(r.forms[0]?.recipients).toEqual(["care@studio.example"]);
	});
});

describe("rendered-HTML fallback", () => {
	it("rebuilds a live form from the audit snapshot, with a warning that keeps the scaffold gate red", () => {
		const f = formFromSnapshot({ provider: "ninja-forms", providerFormId: "5", submitLabel: "Go", fields: [{ name: "nf-field-1", type: "text", label: "Name", required: true }, { name: "nf-field-2", type: "email", label: "Email" }, { name: "nf-field-3", type: "radio", label: "Day", options: ["Mon", "Tue"] }, { name: "nf-field-4", type: "checkbox", label: "x", options: ["Send me news"] }, { name: "nf-field-5", type: "file", label: "CV" }] });
		expect(f?.definition?.id).toBe("ninja-forms-5");
		expect(f?.definition?.fields.map((x) => `${x.name}:${x.type}:${x.label}`)).toEqual(["1:text:Name", "2:email:Email", "3:radio:Day", "4:checkbox:Send me news", "5:file:CV"]);
		expect(f?.definition?.warnings[0]).toMatch(/live page's HTML/);
		expect(formFromSnapshot({ provider: "formidable", fields: [{ name: "a", type: "text" }] })).toBeUndefined();
	});
});

describe("Gravity Forms, WPForms, CF7: uploads, logic, steps, payments", () => {
	it("Gravity: fileupload limits, page fields, conditional logic by field id, product fields", () => {
		const gf = { "0": { id: 8, title: "Apply", fields: [{ id: 1, type: "text", label: "Name" }, { id: 2, type: "select", label: "Role", choices: [{ text: "Coach" }, { text: "Front desk" }] }, { id: 3, type: "page" }, { id: 4, type: "fileupload", label: "Certificate", allowedExtensions: "pdf, jpg", maxFileSize: 5, multipleFiles: true, maxFiles: 2, conditionalLogic: { actionType: "show", logicType: "all", rules: [{ fieldId: "2", operator: "is", value: "Coach" }] } }, { id: 5, type: "product", label: "Fee" }], pagination: { pages: ["You", "Documents"] }, button: { text: "Apply" } }, version: "2.8" };
		const d = (recognise("gf.json", JSON.stringify(gf), hosts) as { forms: { definition: FormDefinitionOut }[] }).forms[0]?.definition as FormDefinitionOut;
		expect(d.fields.map((f) => `${f.name}:${f.type}@${f.step ?? 0}`)).toEqual(["name:text@0", "role:select@0", "certificate:file@1"]);
		expect(d.fields[2]).toMatchObject({ accept: ["pdf", "jpg"], maxMb: 5, maxFiles: 2, showIf: { field: "role", equals: ["Coach"] } });
		expect(d.steps).toEqual([{ title: "You" }, { title: "Documents" }]);
		expect(d.warnings.join()).toMatch(/payment field "Fee"/);
	});
	it("WPForms: file-upload, pagebreak titles, conditionals (hide), several OR groups reported", () => {
		const wp = [{ id: 3, settings: { form_title: "Quote", submit_text: "Send" }, fields: { "0": { id: 0, type: "pagebreak", position: "top", title: "Basics" }, "1": { id: 1, type: "select", label: "Service", choices: { "1": { label: "Yoga" }, "2": { label: "Pilates" } } }, "2": { id: 2, type: "text", label: "Mat size", conditional_logic: "1", conditional_type: "hide", conditionals: [[{ field: "1", operator: "==", value: "Pilates" }]] }, "3": { id: 3, type: "pagebreak", title: "Files" }, "4": { id: 4, type: "file-upload", label: "Plan", extensions: "pdf,docx", max_size: "3", max_file_number: "1", conditional_logic: "1", conditionals: [[{ field: "1", operator: "==", value: "Yoga" }, { field: "2", operator: "!=", value: "" }], [{ field: "1", operator: "==", value: "Pilates" }]] }, "5": { id: 5, type: "pagebreak", position: "bottom" }, "6": { id: 6, type: "payment-total", label: "Total" } } }];
		const d = (recognise("wpf.json", JSON.stringify(wp), hosts) as { forms: { definition: FormDefinitionOut }[] }).forms[0]?.definition as FormDefinitionOut;
		expect(d.fields.map((f) => `${f.name}:${f.type}@${f.step ?? 0}`)).toEqual(["service:select@0", "mat_size:text@0", "plan:file@1"]);
		expect(d.fields[1]?.showIf).toEqual({ field: "service", equals: ["Pilates"], not: true });
		expect(d.fields[2]).toMatchObject({ accept: ["pdf", "docx"], maxMb: 3 });
		expect(d.fields[2]?.showIf).toBeUndefined();
		expect(d.notes?.join()).toMatch(/Plan.*several groups/);
		expect(d.steps).toEqual([{ title: "Basics" }, { title: "Files" }]);
		expect(d.warnings.join()).toMatch(/payment-total/);
	});
	it("CF7 5.8+: the short hash becomes an alias id; [group] add-on reported", () => {
		const xml = `<rss><channel><item><title>Contact</title><wp:post_id>9</wp:post_id><wp:status>publish</wp:status><wp:post_type>wpcf7_contact_form</wp:post_type><wp:postmeta><wp:meta_key>_form</wp:meta_key><wp:meta_value><![CDATA[<label>Name [text* your-name]</label>[group extra]<label>Note [textarea note]</label>[/group][file cv limit:2mb filetypes:pdf|doc][submit "Go"]]]></wp:meta_value></wp:postmeta><wp:postmeta><wp:meta_key>_hash</wp:meta_key><wp:meta_value>3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39</wp:meta_value></wp:postmeta></item></channel></rss>`;
		const f = (recognise("cf7.xml", xml, hosts) as { forms: { aliases?: string[]; definition: FormDefinitionOut }[] }).forms[0];
		expect(f?.aliases).toEqual(["3f2a9c1"]);
		expect(f?.definition.fields.find((x) => x.type === "file")).toMatchObject({ name: "cv", accept: ["pdf", "doc"], maxMb: 2 });
		expect(f?.definition.notes?.join()).toMatch(/\[group\]/);
	});
	it("Fluent: input_file limits, conditional_logics, form_step steps, payment elements", () => {
		const raw = { id: "2", title: "Join", form: { form_fields: { stepsWrapper: { stepStart: { settings: { step_titles: ["Who", "Docs"] } } }, fields: [{ element: "input_radio", attributes: { name: "kind" }, settings: { label: "Kind", advanced_options: [{ label: "Adult" }, { label: "Child" }] } }, { element: "input_text", attributes: { name: "guardian" }, settings: { label: "Guardian", conditional_logics: { status: true, type: "any", conditions: [{ field: "kind", operator: "=", value: "Child" }] } } }, { element: "form_step" }, { element: "input_file", attributes: { name: "id_scan" }, settings: { label: "ID", validation_rules: { required: { value: true }, max_file_size: { value: 2 }, max_file_count: { value: 1 }, allowed_file_types: { value: ["pdf", "jpg"] } } } }, { element: "payment_method", settings: { label: "Pay" } }] } } };
		const d = fluentFormToDefinition(raw, false);
		expect(d.fields.map((f) => `${f.name}:${f.type}@${f.step ?? 0}`)).toEqual(["kind:radio@0", "guardian:text@0", "id_scan:file@1"]);
		expect(d.fields[1]?.showIf).toEqual({ field: "kind", equals: ["Child"] });
		expect(d.fields[2]).toMatchObject({ required: true, maxMb: 2, accept: ["pdf", "jpg"] });
		expect(d.steps).toEqual([{ title: "Who" }, { title: "Docs" }]);
		expect(d.warnings.join()).toMatch(/payment_method/);
	});
});

describe("shared logic", () => {
	it("showIf from rules: one field and is / is not only", () => {
		expect(showIfFrom("X", [{ field: "a", op: "is", value: "1" }, { field: "a", op: "==", value: "2" }], "any").showIf).toEqual({ field: "a", equals: ["1", "2"] });
		expect(showIfFrom("X", [{ field: "a", op: "is not", value: "1" }], "all", "hide").showIf).toEqual({ field: "a", equals: ["1"] });
		expect(showIfFrom("X", [{ field: "a", op: "is", value: "1" }, { field: "a", op: "is", value: "2" }], "all").note).toMatch(/cannot express/);
		expect(showIfFrom("X", [{ field: undefined, op: "is", value: "1" }], "all").note).toMatch(/not in the rebuilt form/);
	});
	it("steps only when there are two or more", () => {
		expect(withSteps([{ name: "a", label: "A", type: "text", step: 0 }], []).steps).toBeUndefined();
		expect(withSteps([{ name: "a", label: "A", type: "text" }, { name: "b", label: "B", type: "text", step: 1 }], ["", "Two"]).steps).toEqual([{ title: "Step 1" }, { title: "Two" }]);
	});
	it("upload policy: off, sensitive sites off unless allowed, the site's size limit", () => {
		const def: FormDefinitionOut = { id: "x", title: "X", submitLabel: "Send", successMessage: "ok", warnings: [], fields: [{ name: "email", label: "Email", type: "email" }, { name: "cv", label: "CV", type: "file" }] };
		expect(applyUploadPolicy(def, false, false).withheld).toEqual(["CV (file upload: forms.uploads is false)"]);
		expect(applyUploadPolicy(def, { maxMb: 10, sensitive: false }, true).fields.map((f) => f.name)).toEqual(["email"]);
		expect(applyUploadPolicy(def, { maxMb: 7, sensitive: false }, false).fields[1]?.maxMb).toBe(7);
		const allowed = applySensitivePolicy({ ...applyUploadPolicy(def, { maxMb: 10, sensitive: true }, true), sensitive: true }, "contact-only", "n");
		expect(allowed.fields.map((f) => f.name)).toEqual(["email", "cv"]);
	});
});
