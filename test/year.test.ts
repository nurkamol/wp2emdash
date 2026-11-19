import { describe, expect, it } from "vitest";
import { currentYear, currentYearText } from "../src/transform/year.js";

describe("copyright year → {year}", () => {
	it("replaces a single year after ©", () => {
		expect(currentYearText("© 2025 <a href=\"/\">Studio</a>")).toBe("© {year} <a href=\"/\">Studio</a>");
		expect(currentYearText("Studio © 2025")).toBe("Studio © {year}");
		expect(currentYearText("&copy;2024 Studio")).toBe("&copy;{year} Studio");
		expect(currentYearText("(c) 2023 Studio")).toBe("(c) {year} Studio");
	});
	it("keeps ranges, other years and text without ©", () => {
		expect(currentYearText("© 2019–2025 Studio")).toBe("© 2019–2025 Studio");
		expect(currentYearText("© 2019 - 25 Studio")).toBe("© 2019 - 25 Studio");
		expect(currentYearText("Est. 2025")).toBe("Est. 2025");
		expect(currentYearText("/uploads/2025/03/logo.svg")).toBe("/uploads/2025/03/logo.svg");
	});
	it("walks section fields deep", () => {
		const sections = [{ type: "rich_text", fields: { body: [{ children: [{ text: "© 2025 Studio" }] }], note: "2025" } }];
		expect(currentYear(sections)).toBe(1);
		expect(sections[0]?.fields.body[0]?.children[0]?.text).toBe("© {year} Studio");
		expect(sections[0]?.fields.note).toBe("2025");
	});
});
