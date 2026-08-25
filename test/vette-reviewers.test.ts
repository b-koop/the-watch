import { describe, expect, it } from "vitest";
import {
	deterministicReviewerPlan,
	discoverReviewers,
	parseReviewerMarkdown,
	selectReviewers,
	summarizeChangedFiles,
	validateReviewerPlan,
} from "../extensions/vette-reviewers.ts";

const markdown = `---
name: TypeScript
version: 1
description: Type boundary review.
priority: 50
paths: ["**/*.ts"]
languages: [typescript]
exclude: ["**/*.d.ts"]
changeTypes: [modified]
unknown: ignored
selector: "public boundaries"
---
# Instructions
Review types.`;

describe("reviewer definitions", () => {
	it("parses metadata, body, defaults, and unknown-field diagnostics", () => {
		const result = parseReviewerMarkdown(markdown, "fixture/REVIEW.md");
		expect(result.definition?.name).toBe("typescript");
		expect(result.definition?.body).toContain("Review types.");
		expect(result.definition?.enabled).toBe(true);
		expect(result.diagnostics).toEqual([
			{
				sourcePath: "fixture/REVIEW.md",
				severity: "warning",
				message: "unknown frontmatter field 'unknown' ignored",
			},
		]);
	});

	it("selects by language, change type, glob, and exclusion", () => {
		const definition = parseReviewerMarkdown(markdown).definition!;
		const selected = selectReviewers(
			[definition],
			summarizeChangedFiles(["src/a.ts", "src/types.d.ts"], {
				"src/a.ts": "modified",
				"src/types.d.ts": "modified",
			}),
		);
		expect(selected.selected.map((item) => item.name)).toEqual(["typescript"]);
		expect(selected.selected[0]?.matchReason).toContain("src/a.ts");
		expect(
			selectReviewers(
				[definition],
				summarizeChangedFiles(["src/a.ts"], { "src/a.ts": "added" }),
			).selected,
		).toHaveLength(0);
	});

	it("discovers shipped reviewers and supports deterministic router fallback validation", async () => {
		const catalog = await discoverReviewers(process.cwd(), [
			"extensions/example.ts",
		]);
		expect(catalog.discovered.length).toBeGreaterThanOrEqual(13);
		const fallback = deterministicReviewerPlan(catalog);
		expect(
			validateReviewerPlan(
				{ selected: ["invented"], order: ["invented"] },
				catalog,
			),
		).toEqual(fallback);
		expect(
			validateReviewerPlan(
				{ selected: fallback.selected, order: fallback.order },
				catalog,
			).fallback,
		).toBe(false);
	});
});
