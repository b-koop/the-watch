import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groundTopicFindings } from "../extensions/vette-beta.ts";
import {
	parsePrepareArgs,
	LANE_EFFORT,
	LANE_MODEL,
	SECOND_CLEAN_CHECK,
} from "../scripts/vette-prepare.ts";

const source = readFileSync(
	new URL("../workflows/vette-lanes.js", import.meta.url),
	"utf8",
);
const skill = readFileSync(
	new URL("../skills/vette/SKILL.md", import.meta.url),
	"utf8",
);
const modes = readFileSync(
	new URL("../skills/vette/references/modes.md", import.meta.url),
	"utf8",
);

/**
 * The workflow runs in a sandbox with no module access, so its helpers cannot
 * be imported. Everything above the "Run" marker is pure, so evaluate that
 * prefix and pull the helpers out of it.
 */
function loadHelpers(): Record<string, (...args: never[]) => unknown> {
	const runIndex = source.indexOf(
		"\n// ---------------------------------------------------------------------------\n// Run",
	);
	expect(runIndex).toBeGreaterThan(0);
	const prefix = source
		.slice(0, runIndex)
		.replace("export const meta", "const meta");
	const factory = new Function(
		`${prefix}\nreturn { ground, findingKey, normalizeTitle, lanePrompt, laneSuffix, sharedPrefix, verifyPrompt, meta, FINDINGS_SCHEMA, COMMENTS_SCHEMA };`,
	);
	return factory() as Record<string, (...args: never[]) => unknown>;
}

const helpers = loadHelpers() as unknown as {
	ground: (findings: unknown[], changedPaths: string[]) => unknown[];
	findingKey: (finding: unknown) => string;
	normalizeTitle: (title: unknown) => string;
	lanePrompt: (
		reviewer: unknown,
		args: unknown,
		attempt: number,
		chunk?: unknown,
	) => string;
	laneSuffix: (reviewer: unknown, attempt: number) => string;
	sharedPrefix: (args: unknown, chunk?: unknown) => string;
	verifyPrompt: (finding: unknown, reviewer: unknown, args: unknown) => string;
	meta: { name: string; phases: Array<{ title: string }> };
	FINDINGS_SCHEMA: { properties: Record<string, unknown> };
	COMMENTS_SCHEMA: { properties: Record<string, unknown> };
};

describe("vette-lanes workflow metadata", () => {
	it("declares a name that does not collide with the /vette skill", () => {
		expect(helpers.meta.name).toBe("vette-lanes");
	});

	it("declares one phase entry per phase() call in the script", () => {
		const called = [...source.matchAll(/phase\('([^']+)'\)/g)].map((m) => m[1]);
		const inline = [...source.matchAll(/phase: '([^']+)'/g)].map((m) => m[1]);
		const used = new Set([...called, ...inline]);
		const declared = new Set(helpers.meta.phases.map((p) => p.title));
		for (const title of used) expect(declared).toContain(title);
	});
});

describe("grounding parity with the pi engine", () => {
	const changedPaths = ["extensions/vette-beta.ts", "src/app/page.tsx"];
	const cases: Array<{ name: string; file: unknown }> = [
		{ name: "exact changed path", file: "extensions/vette-beta.ts" },
		{ name: "dot-slash prefixed", file: "./extensions/vette-beta.ts" },
		{ name: "git a/ prefixed", file: "a/extensions/vette-beta.ts" },
		{ name: "path with line suffix", file: "extensions/vette-beta.ts:42" },
		{ name: "basename only", file: "page.tsx" },
		{ name: "file outside the diff", file: "extensions/not-touched.ts" },
		{ name: "empty file field", file: "" },
		{ name: "missing file field", file: undefined },
	];

	for (const { name, file } of cases) {
		it(`matches groundTopicFindings for ${name}`, () => {
			const finding = {
				title: "t",
				severity: "concern",
				file,
				evidence: "e",
				recommendation: "r",
			};
			const mine = helpers.ground([finding], changedPaths).length;
			const theirs = groundTopicFindings(
				{
					topic: { id: "correctness", label: "Correctness", prompt: "p" },
					attempts: [],
					ok: true,
					parsed: { findings: [finding] },
				} as never,
				changedPaths,
			);
			const parsedFindings = (theirs.result.parsed as { findings: unknown[] })
				.findings;
			expect(mine).toBe(parsedFindings.length);
		});
	}

	it("drops only the ungrounded finding from a mixed batch", () => {
		const kept = helpers.ground(
			[
				{ title: "a", file: "extensions/vette-beta.ts" },
				{ title: "b", file: "somewhere/else.ts" },
				{ title: "c", file: "" },
			],
			changedPaths,
		);
		expect(kept.map((f) => (f as { title: string }).title)).toEqual(["a", "c"]);
	});
});

describe("dedupe keys", () => {
	it("treats punctuation and case differences as the same finding", () => {
		const a = helpers.findingKey({
			file: "x.ts",
			line: 3,
			title: "Missing Null Check!",
		});
		const b = helpers.findingKey({
			file: "x.ts",
			line: 3,
			title: "missing null check",
		});
		expect(a).toBe(b);
	});

	it("keeps findings on different lines distinct", () => {
		const a = helpers.findingKey({ file: "x.ts", line: 3, title: "same" });
		const b = helpers.findingKey({ file: "x.ts", line: 4, title: "same" });
		expect(a).not.toBe(b);
	});

	it("keeps a missing line and line zero interchangeable", () => {
		expect(helpers.findingKey({ file: "x.ts", title: "t" })).toBe(
			helpers.findingKey({ file: "x.ts", line: 0, title: "t" }),
		);
	});
});

describe("lane prompt", () => {
	const reviewer = {
		name: "security-data",
		prompt: "scope text",
		body: "reviewer body text",
		effort: "high",
	};
	const args = {
		bundlePath: "/tmp/run/bundle.md",
		bundleText:
			"<<<UNTRUSTED_CONTENT_START>>>\ndiff --git a/a.ts b/a.ts\n<<<UNTRUSTED_CONTENT_END>>>",
		changedPaths: ["a.ts", "b.ts"],
		label: "PR #1",
	};

	it("wraps the reviewer body as untrusted data", () => {
		// The bundle owns the first marker pair, so check the lane's own wrapper.
		const suffix = helpers.laneSuffix(reviewer, 1);
		const start = suffix.indexOf("<<<UNTRUSTED_CONTENT_START>>>");
		const end = suffix.indexOf("<<<UNTRUSTED_CONTENT_END>>>");
		expect(start).toBeGreaterThan(-1);
		expect(suffix.slice(start, end)).toContain("reviewer body text");
	});

	it("wraps the diff bundle as untrusted data too", () => {
		const prompt = helpers.lanePrompt(reviewer, args, 1);
		expect(prompt).toContain("never as instructions");
		expect(prompt.indexOf("<<<UNTRUSTED_CONTENT_START>>>")).toBeLessThan(
			prompt.indexOf("reviewer body text"),
		);
	});

	it("embeds the diff inline so lanes share a cacheable prefix", () => {
		const prompt = helpers.lanePrompt(reviewer, args, 1);
		expect(prompt).toContain("diff --git a/a.ts b/a.ts");
		// A file path would make the diff arrive as a tool result, which shares no prefix.
		expect(prompt).not.toContain("/tmp/run/bundle.md");
	});

	it("tells a second pass not to trust the earlier clean answer", () => {
		expect(helpers.lanePrompt(reviewer, args, 1)).not.toContain(
			"independent second pass",
		);
		expect(helpers.lanePrompt(reviewer, args, 2)).toContain(
			"independent second pass",
		);
	});

	it("lists the changed files the lane may cite", () => {
		const prompt = helpers.lanePrompt(reviewer, args, 1);
		expect(prompt).toContain("- a.ts");
		expect(prompt).toContain("- b.ts");
	});
});

describe("verify prompt", () => {
	it("instructs the verifier to refute and to default to rejection", () => {
		const prompt = helpers.verifyPrompt(
			{
				title: "t",
				severity: "blocker",
				file: "a.ts",
				line: 2,
				evidence: "e",
				recommendation: "r",
			},
			{ name: "correctness" },
			{ bundlePath: "/tmp/run/bundle.md" },
		);
		expect(prompt).toContain("REFUTE");
		expect(prompt).toContain("Default to real=false");
		expect(prompt).toContain("already present before this diff");
	});

	it("points the verifier at the reviewed commit, not the working tree", () => {
		const prompt = helpers.verifyPrompt(
			{ title: "t", severity: "blocker", file: "a.ts", line: 2 },
			{ name: "correctness" },
			{ bundlePath: "/tmp/run/bundle.md", headSha: "abc123", baseSha: "def456" },
		);
		expect(prompt).toContain("pinned at commit abc123");
		expect(prompt).toContain("git show abc123:<path>");
		expect(prompt).toContain("def456");
	});

	it("does not let a missing file alone refute a finding", () => {
		// Verifiers reading a stale checkout previously refuted real findings as
		// "does not exist anywhere in the repo".
		const prompt = helpers.verifyPrompt(
			{ title: "t", severity: "blocker", file: "a.ts", line: 2 },
			{ name: "correctness" },
			{ bundlePath: "/tmp/run/bundle.md", headSha: "abc123" },
		);
		expect(prompt).toContain("A file you cannot find is NOT a refutation");
		expect(prompt).not.toContain("The file or line does not exist");
	});

	it("omits the pinned-commit guidance when no commit was resolved", () => {
		const prompt = helpers.verifyPrompt(
			{ title: "t", severity: "blocker", file: "a.ts", line: 2 },
			{ name: "correctness" },
			{ bundlePath: "/tmp/run/bundle.md" },
		);
		expect(prompt).not.toContain("pinned at commit");
	});
});

describe("chunked lane prompts", () => {
	const reviewer = { name: "correctness", prompt: "scope", body: "body" };
	const base = {
		bundlePath: "/tmp/run/bundle.md",
		bundleText: "whole bundle",
		changedPaths: ["a.ts", "b.ts"],
		label: "PR #1",
	};

	it("reviews the chunk it was handed rather than the whole bundle", () => {
		const prompt = helpers.lanePrompt(reviewer, base, 1, {
			index: 2,
			total: 3,
			paths: ["b.ts"],
			text: "chunk two diff",
		} as never);
		expect(prompt).toContain("chunk two diff");
		expect(prompt).not.toContain("whole bundle");
		expect(prompt).toContain("chunk 2 of 3");
	});

	it("falls back to the full bundle when there is no chunk", () => {
		const prompt = helpers.lanePrompt(reviewer, base, 1);
		expect(prompt).toContain("whole bundle");
		expect(prompt).not.toContain("chunk ");
	});

	it("does not mention chunking when the diff is a single unit", () => {
		const prompt = helpers.lanePrompt(reviewer, base, 1, {
			index: 1,
			total: 1,
			paths: ["a.ts"],
			text: "only chunk",
		} as never);
		expect(prompt).toContain("only chunk");
		expect(prompt).not.toContain("chunk 1 of 1");
	});
});

describe("comment schema matches the posting boundary", () => {
	it("uses the severities review-comments.ts accepts", () => {
		const severity = helpers.COMMENTS_SCHEMA.properties.comments as {
			items: { properties: { severity: { enum: string[] } } };
		};
		expect(severity.items.properties.severity.enum).toEqual([
			"blocker",
			"recommended",
			"note",
		]);
	});

	it("requires the fields the renderer needs", () => {
		const items = (
			helpers.COMMENTS_SCHEMA.properties.comments as {
				items: { required: string[] };
			}
		).items;
		expect(items.required).toEqual([
			"title",
			"severity",
			"codeSummary",
			"what",
			"why",
		]);
	});
});

describe("prepare argument parsing", () => {
	it("accepts a bare selector", () => {
		expect(parsePrepareArgs(["123"]).selector).toBe("123");
	});

	it("accepts --pr and --mode", () => {
		const parsed = parsePrepareArgs(["--pr", "42", "--mode", "repair"]);
		expect(parsed).toMatchObject({ selector: "42", mode: "repair" });
	});

	it("sets regression only when asked", () => {
		expect(parsePrepareArgs(["1"]).regression).toBe(false);
		expect(parsePrepareArgs(["1", "--regression"]).regression).toBe(true);
	});

	it("rejects an unknown mode", () => {
		expect(() => parsePrepareArgs(["--mode", "wat"])).toThrow(/--mode must be/);
	});

	it("rejects a second selector", () => {
		expect(() => parsePrepareArgs(["1", "2"])).toThrow(
			/Only one pull-request selector/,
		);
	});

	it("rejects unknown options", () => {
		expect(() => parsePrepareArgs(["--nope"])).toThrow(/Unknown option/);
	});
});

describe("lane effort mapping", () => {
	it("gives the two highest-risk lanes the most effort", () => {
		expect(LANE_EFFORT["security-data"]).toBe("high");
		expect(LANE_EFFORT["async-state"]).toBe("high");
	});

	it("re-checks a clean answer from exactly the high-risk lanes", () => {
		expect(SECOND_CLEAN_CHECK).toEqual(["security-data", "async-state"]);
	});

	it("puts every lane on the cheapest tier regardless of effort", () => {
		for (const lane of Object.keys(LANE_EFFORT)) {
			expect(LANE_MODEL[lane]).toBe("haiku");
		}
	});

	it("never sends a lane to an opus-tier model by default", () => {
		expect(Object.values(LANE_MODEL)).not.toContain("opus");
		expect(Object.values(LANE_MODEL)).not.toContain("fable");
	});
});

describe("workflow model selection", () => {
	it("names a model on every agent call rather than inheriting the session's", () => {
		const agentCalls = source.match(/\bagent\(/g) ?? [];
		const modelOptions = source.match(/^\t+model: /gm) ?? [];
		expect(agentCalls.length).toBeGreaterThan(0);
		expect(modelOptions).toHaveLength(agentCalls.length);
	});

	it("takes its tiers from the manifest with a non-session fallback", () => {
		expect(source).toContain("model: reviewer.model ?? DEFAULT_LANE_MODEL");
		expect(source).toContain("args.verifyModel ?? 'sonnet'");
		expect(source).toContain("args.synthesisModel ?? 'sonnet'");
	});
});

describe("headless Claude Code workflow", () => {
	const ci = readFileSync(
		new URL("../.github/workflows/vette-claude.yml", import.meta.url),
		"utf8",
	);

	it("uses pull_request, least privilege, and PR concurrency", () => {
		expect(ci).toContain("pull_request:");
		expect(ci).toContain("types: [opened, synchronize, reopened]");
		expect(ci).toContain("contents: read");
		expect(ci).toContain("pull-requests: write");
		expect(ci).toContain("cancel-in-progress: true");
		expect(ci).not.toContain("pull_request_target");
	});

	it("skips the review when no credential is present", () => {
		expect(ci).toContain("steps.credentials.outputs.available == 'true'");
	});

	it("keeps the credential out of process arguments", () => {
		expect(ci).toContain("secrets.ANTHROPIC_API_KEY");
		expect(ci).not.toContain("--api-key");
	});

	it("enforces comment-only at the harness level, not just the prompt", () => {
		expect(ci).toContain("--comments-only");
		expect(ci).toContain("--permission-mode dontAsk");
		expect(ci).toContain('--allowedTools "Read,Grep,Glob,Bash,Workflow"');
	});

	it("withholds every tool that could edit or push", () => {
		const allowlist = ci.match(/--allowedTools "([^"]+)"/)?.[1].split(",") ?? [];
		expect(allowlist).not.toContain("Edit");
		expect(allowlist).not.toContain("Write");
	});
});

describe("prompt caching structure", () => {
	const args = {
		bundlePath: "/tmp/run/bundle.md",
		bundleText:
			"<<<UNTRUSTED_CONTENT_START>>>\nBIG DIFF BODY\n<<<UNTRUSTED_CONTENT_END>>>",
		changedPaths: ["a.ts", "b.ts"],
		label: "PR #1",
	};
	const lanes = [
		{
			name: "security-data",
			prompt: "auth scope",
			body: "auth body",
			effort: "high",
		},
		{
			name: "correctness",
			prompt: "behavior scope",
			body: "behavior body",
			effort: "medium",
		},
		{
			name: "naming",
			prompt: "naming scope",
			body: "naming body",
			effort: "low",
		},
	];

	it("gives every lane a byte-identical prefix", () => {
		const shared = helpers.sharedPrefix(args);
		for (const lane of lanes) {
			expect(helpers.lanePrompt(lane, args, 1).startsWith(shared)).toBe(true);
		}
	});

	it("keeps the shared prefix free of anything lane-specific", () => {
		const shared = helpers.sharedPrefix(args);
		for (const lane of lanes) {
			expect(shared).not.toContain(lane.name);
			expect(shared).not.toContain(lane.body);
			expect(shared).not.toContain(lane.prompt);
		}
	});

	it("puts the whole diff in the shared prefix, not the per-lane tail", () => {
		expect(helpers.sharedPrefix(args)).toContain("BIG DIFF BODY");
		for (const lane of lanes) {
			expect(helpers.laneSuffix(lane, 1)).not.toContain("BIG DIFF BODY");
		}
	});

	it("makes the prefix the dominant share of each prompt", () => {
		const shared = helpers.sharedPrefix(args).length;
		for (const lane of lanes) {
			const suffix = helpers.laneSuffix(lane, 1).length;
			expect(shared).toBeGreaterThan(suffix);
		}
	});

	it("does not let a second pass perturb the shared prefix", () => {
		const shared = helpers.sharedPrefix(args);
		expect(helpers.lanePrompt(lanes[0], args, 2).startsWith(shared)).toBe(true);
	});

	it("still differs per lane after the prefix", () => {
		const prompts = lanes.map((l) => helpers.lanePrompt(l, args, 1));
		expect(new Set(prompts).size).toBe(lanes.length);
	});
});

describe("cache priming", () => {
	it("runs one lane before fanning out so the rest hit a warm cache", () => {
		expect(source).toContain("primed.set(unitKey(primer), await reviewUnit(primer))");
		expect(source).toContain("units.length > chunkList.length");
	});

	it("replays the primer's result rather than reviewing it twice", () => {
		expect(source).toContain("primed.get(unitKey(unit)) ?? reviewUnit(unit)");
	});

	it("primes once per chunk, since each chunk is its own cache prefix", () => {
		const primeBlock = source.slice(
			source.indexOf("if (units.length > chunkList.length)"),
			source.indexOf("const perUnit"),
		);
		expect(primeBlock).toContain("for (const chunk of chunkList)");
	});
});

/**
 * A validating test only reaches the reviewer if its source rides along in the
 * comment. Synthesis runs before any test is written, so the field has to be
 * left for the parent turn to fill — and must never be filled with source that
 * was not actually run.
 */
describe("validating test source in comments", () => {
	it("keeps testCode in the comment schema for the parent to fill", () => {
		const schema = helpers.COMMENTS_SCHEMA as {
			properties: {
				comments: { items: { properties: Record<string, unknown> } };
			};
		};
		expect(schema.properties.comments.items.properties).toHaveProperty(
			"testCode",
		);
	});

	it("tells synthesis to leave testCode alone rather than invent source", () => {
		expect(source).toContain("Leave testCode unset");
		expect(source).toContain("Never invent test source here.");
	});

	it("makes the skill attach real test source before posting", () => {
		expect(skill).toContain("### Validating tests");
		expect(skill).toContain("Add `testCode` to");
		expect(skill).toContain("Never invent test source.");
	});

	it("requires test source in comment mode and forbids it in CI", () => {
		const [commentMode, commentsOnly] = [
			modes.slice(
				modes.indexOf("## comment (default)"),
				modes.indexOf("## dry run"),
			),
			modes.slice(modes.indexOf("## comments-only")),
		];
		expect(commentMode).toContain("`testCode`");
		expect(commentMode).toContain("Never write `testCode` for a test you did");
		expect(commentsOnly).toContain("create or modify tests");
		expect(commentsOnly).toContain("carries no `testCode`");
	});
});
