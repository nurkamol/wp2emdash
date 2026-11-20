import { describe, expect, it } from "vitest";
import { flattenTerms } from "../src/targets/emdash/api.js";

describe("EmDash term list", () => {
	it("flattens the tree a hierarchical taxonomy returns, so reruns find child terms", () => {
		const tree = [{ id: "1", slug: "news", label: "News", parentId: null, children: [{ id: "2", slug: "studio-news", label: "Studio news", parentId: "1", children: [{ id: "3", slug: "events", label: "Events", parentId: "2", children: [] }] }] }];
		expect(flattenTerms(tree).map((t) => t.slug)).toEqual(["news", "studio-news", "events"]);
		expect(flattenTerms(tree)[1]).not.toHaveProperty("children");
	});
});
