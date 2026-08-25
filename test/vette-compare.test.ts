import { describe, expect, it } from "vitest";
import {
	compareVetteFindings,
	extractVetteCompareFindings,
	findingMatchKey,
	formatVetteCompareReport,
	formatVetteCompareSummary,
	parseVetteCompareArgs,
} from "../extensions/vette-compare.ts";
import type {
	VetteBetaRunResult,
	VetteBetaTopic,
} from "../extensions/vette-beta.ts";

const topic: VetteBetaTopic = {
	id: "correctness",
	label: "Correctness",
	prompt: "check correctness",
};

function makeRun(findings: Array<Record<string, unknown>>): VetteBetaRunResult {
	return {
		poolName: "test",
		resolvedPool: [],
		bundle: "diff",
		startedAt: "2026-07-02T10:00:00.000Z",
		finishedAt: "2026-07-02T10:00:03.000Z",
		durationMs: 3000,
		reviewMode: "doc",
		results: [
			{
				topic,
				attempts: [],
				ok: true,
				output: JSON.stringify({ findings }),
				parsed: { findings },
			},
		],
	};
}

describe("vette compare findings", () => {
	it("extracts findings from topic-agent JSON output", () => {
		const findings = extractVetteCompareFindings(
			makeRun([
				{
					title: "Missing guard",
					severity: "concern",
					file: "src/a.ts",
					line: 12,
					evidence: "diff shows null access",
					recommendation: "add guard",
				},
			]),
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			topicId: "correctness",
			title: "Missing guard",
			file: "src/a.ts",
			line: 12,
		});
	});

	it("matches overlap by topic, file, and normalized title", () => {
		const remote = {
			topicId: "correctness",
			topicLabel: "Correctness",
			title: "Missing Guard",
			severity: "concern",
			file: "./src/a.ts",
			evidence: "remote",
			recommendation: "fix",
		};
		const local = {
			...remote,
			title: "missing guard",
			file: "src/a.ts",
			evidence: "local",
		};
		const compared = compareVetteFindings({
			remote: [remote],
			local: [local],
		});

		expect(findingMatchKey(remote)).toBe(findingMatchKey(local));
		expect(compared.overlap).toHaveLength(1);
		expect(compared.remoteOnly).toHaveLength(0);
		expect(compared.localOnly).toHaveLength(0);
	});

	it("reports remote-only and local-only findings", () => {
		const compared = compareVetteFindings({
			remote: [
				{
					topicId: "correctness",
					topicLabel: "Correctness",
					title: "Remote issue",
					severity: "concern",
					file: "src/a.ts",
					evidence: "remote",
					recommendation: "fix",
				},
			],
			local: [
				{
					topicId: "security-data",
					topicLabel: "Security",
					title: "Local issue",
					severity: "blocker",
					file: "src/b.ts",
					evidence: "local",
					recommendation: "fix",
				},
			],
		});

		expect(compared.overlap).toHaveLength(0);
		expect(compared.remoteOnly).toHaveLength(1);
		expect(compared.localOnly).toHaveLength(1);
	});

	it("parses compare model and local overrides", () => {
		const parsed = parseVetteCompareArgs(
			"123 --model openai/gpt-4o-mini --local ollama/qwen2.5-coder:7b --topics correctness,security-data",
		);

		expect(parsed).toMatchObject({
			targetArg: "123",
			remoteModel: "openai/gpt-4o-mini",
			localModel: "ollama/qwen2.5-coder:7b",
		});
		expect(parsed.topics?.map((topic) => topic.id)).toEqual([
			"correctness",
			"security-data",
		]);
	});

	it("parses compare models listing mode", () => {
		expect(parseVetteCompareArgs("models")).toEqual({ listModels: true });
	});

	it("formats a comparison report with summary sections", () => {
		const report = formatVetteCompareReport({
			targetLabel: "current worktree",
			remote: {
				label: "remote",
				model: "openai/gpt-4o-mini",
				run: makeRun([]),
				findings: [],
			},
			local: {
				label: "local",
				model: "ollama/qwen2.5-coder:7b",
				run: makeRun([]),
				findings: [
					{
						topicId: "security-data",
						topicLabel: "Security",
						title: "Local issue",
						severity: "blocker",
						file: "src/b.ts",
						evidence: "local",
						recommendation: "fix",
					},
				],
			},
			overlap: [],
			remoteOnly: [],
			localOnly: [
				{
					topicId: "security-data",
					topicLabel: "Security",
					title: "Local issue",
					severity: "blocker",
					file: "src/b.ts",
					evidence: "local",
					recommendation: "fix",
				},
			],
		});

		expect(report).toContain("# Vette model comparison");
		expect(report).toContain("Remote model: openai/gpt-4o-mini");
		expect(report).toContain("Local model: ollama/qwen2.5-coder:7b");
		expect(report).toContain("## Local only");
		expect(report).toContain("Local issue");
	});

	it("formats a short notify summary", () => {
		const summary = formatVetteCompareSummary({
			targetLabel: "PR #42",
			remote: {
				label: "remote",
				model: "openai/gpt-4o-mini",
				run: makeRun([]),
				findings: [
					{
						topicId: "correctness",
						topicLabel: "Correctness",
						title: "A",
						severity: "concern",
						file: "a.ts",
						evidence: "",
						recommendation: "",
					},
				],
			},
			local: {
				label: "local",
				model: "ollama/qwen2.5-coder:7b",
				run: makeRun([]),
				findings: [],
			},
			overlap: [],
			remoteOnly: [],
			localOnly: [],
		});

		expect(summary).toContain("/vette compare complete for PR #42");
		expect(summary).toContain("remote-only");
	});
});
