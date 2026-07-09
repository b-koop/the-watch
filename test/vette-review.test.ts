import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	extractVetteReviewSections,
	formatVetteReviewPrompt,
	loadVetteReviewSections,
} from "../extensions/vette-review.ts";

let tempRoot: string | undefined;

afterEach(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

describe("vette review artifact extraction", () => {
	it("extracts recommendation-like sections with PR hints", () => {
		const sections = extractVetteReviewSections(
			"/tmp/pi-vette-findings/branch/pr-42-findings.md",
			`# Review findings\n\nhttps://github.com/o/r/pull/42\n\n## Accepted recommendation\n\nUse a narrower guard.\n\n## Background\n\nNot an action item.\n\n## Rejected finding\n\nNo behavior change needed.\n`,
			{ limit: 2 },
		);

		expect(sections).toHaveLength(2);
		expect(sections[0]).toMatchObject({
			artifactPath: "/tmp/pi-vette-findings/branch/pr-42-findings.md",
			title: "Review findings",
			prHint: "https://github.com/o/r/pull/42",
		});
		expect(sections.map((section) => section.title)).toEqual([
			"Review findings",
			"Accepted recommendation",
		]);
	});

	it("loads markdown artifacts from configured roots up to the requested limit", async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "vette-review-"));
		const artifactDir = join(tempRoot, "pi-vette-findings", "branch");
		await mkdir(artifactDir, { recursive: true });
		await writeFile(
			join(artifactDir, "pr-7-findings.md"),
			"## Recommendation\n\nTighten the validation.\n\n## Another recommendation\n\nAdd coverage.",
		);

		const sections = await loadVetteReviewSections({
			roots: [join(tempRoot, "pi-vette-findings")],
			limit: 1,
		});

		expect(sections).toHaveLength(1);
		expect(sections[0]).toMatchObject({
			title: "Recommendation",
			prHint: "PR #7",
		});
	});

	it("formats an orchestration prompt that asks for one subagent per section", () => {
		const prompt = formatVetteReviewPrompt([
			{
				artifactPath: "/tmp/pi-vette-findings/branch/pr-1-findings.md",
				title: "Recommendation",
				content: "Use a safer fallback.",
				prHint: "PR #1",
			},
		]);

		expect(prompt).toContain("Launch one focused subagent per section");
		expect(prompt).toContain("accepted, rejected, fixed differently");
		expect(prompt).toContain("/tmp/pi-vette-findings/branch/pr-1-findings.md");
		expect(prompt).toContain("PR #1");
	});
});
