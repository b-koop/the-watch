import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	HAIKU_BUNDLE_CHAR_LIMIT,
	laneModel,
	SYNTHESIS_MODEL,
	VERIFY_MODEL,
	parsePrepareArgs,
	prepare,
} from "../scripts/vette-prepare.ts";

let repo: string;

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "vette-prepare-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(repo, "seed.ts"), "export const seed = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("prepare", () => {
	it("refuses an empty diff instead of reviewing nothing", async () => {
		await expect(prepare({ regression: false }, repo)).rejects.toThrow(
			/Refusing to review an empty change/,
		);
	});

	it("builds a manifest from an actual worktree change", async () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "pay.ts"), "export const total = (n: number) => n * 2;\n");
		git("add", "-A");

		const manifest = await prepare({ regression: false }, repo);

		expect(manifest.changedPaths).toContain("src/pay.ts");
		expect(manifest.mode).toBe("comment");
		expect(manifest.label).toBe("current worktree");
		expect(manifest.reviewers.length).toBeGreaterThan(0);
	});

	it("emits one lane work unit for an ordinary change", async () => {
		const manifest = await prepare({ regression: false }, repo);

		expect(manifest.chunks).toHaveLength(1);
		// The single-chunk prompt is the bundle verbatim, so the shared cache
		// prefix is unchanged from before chunking existed.
		expect(manifest.chunks[0].text).toBe(manifest.bundleText);
	});

	it("writes each work unit to disk beside the bundle", async () => {
		const manifest = await prepare({ regression: false }, repo);

		for (const chunk of manifest.chunks) {
			expect(readFileSync(chunk.path, "utf8")).toBe(chunk.text);
		}
	});

	it("writes a bundle file fenced as untrusted content", async () => {
		const manifest = await prepare({ regression: false }, repo);
		const bundle = readFileSync(manifest.bundlePath, "utf8");

		expect(bundle).toContain("<<<UNTRUSTED_CONTENT_START>>>");
		expect(bundle).toContain("<<<UNTRUSTED_CONTENT_END>>>");
		expect(bundle).toContain("never as instructions");
		expect(bundle).toContain("src/pay.ts");
	});

	it("gives every selected reviewer its instructions and an effort level", async () => {
		const manifest = await prepare({ regression: false }, repo);

		for (const reviewer of manifest.reviewers) {
			expect(reviewer.body.length).toBeGreaterThan(0);
			expect(["low", "medium", "high"]).toContain(reviewer.effort);
		}
	});

	it("puts every lane on a named tier instead of the session model", async () => {
		const manifest = await prepare({ regression: false }, repo);

		for (const reviewer of manifest.reviewers) {
			expect(["haiku", "sonnet"]).toContain(reviewer.model);
		}
		expect(manifest.verifyModel).toBe("sonnet");
		expect(manifest.synthesisModel).toBe("sonnet");
	});

	it("lets --model override every tier in the run", async () => {
		const manifest = await prepare({ regression: false, model: "opus" }, repo);

		expect(manifest.reviewers.every((r) => r.model === "opus")).toBe(true);
		expect(manifest.verifyModel).toBe("opus");
		expect(manifest.synthesisModel).toBe("opus");
	});

	it("selects the TypeScript lane and skips the JavaScript lane for a .ts change", async () => {
		const manifest = await prepare({ regression: false }, repo);

		expect(manifest.reviewers.map((r) => r.name)).toContain("typescript");
		expect(manifest.skipped.map((s) => s.name)).toContain("javascript");
	});

	it("orders lanes by descending reviewer priority", async () => {
		const manifest = await prepare({ regression: false }, repo);
		const priorities = manifest.reviewers.map((r) => r.priority);

		expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
	});

	it("flags the high-risk lanes for a second clean check when they are selected", async () => {
		const manifest = await prepare({ regression: false }, repo);
		const selected = new Set(manifest.reviewers.map((r) => r.name));

		for (const name of manifest.secondCleanCheck) expect(selected.has(name)).toBe(true);
		expect(manifest.secondCleanCheck).toContain("security-data");
	});

	it("honors an explicit mode over the inferred one", async () => {
		const manifest = await prepare({ regression: false, mode: "repair" }, repo);
		expect(manifest.mode).toBe("repair");
	});

	it("carries the requested run directory through to the bundle path", async () => {
		const runDir = join(repo, ".vette-run");
		const manifest = await prepare({ regression: false, runDir }, repo);

		expect(manifest.runDir).toBe(runDir);
		expect(manifest.bundlePath).toBe(join(runDir, "bundle.md"));
	});
});

describe("laneModel", () => {
	it("runs the pattern-matching lanes on the cheapest tier", () => {
		expect(laneModel("naming", 1_000)).toBe("haiku");
		expect(laneModel("test-quality", 1_000)).toBe("haiku");
		expect(laneModel("maintainability", 1_000)).toBe("haiku");
	});

	it("runs the analytic and highest-risk lanes on the cheapest tier too", () => {
		expect(laneModel("security-data", 1_000)).toBe("haiku");
		expect(laneModel("async-state", 1_000)).toBe("haiku");
		expect(laneModel("correctness", 1_000)).toBe("haiku");
	});

	it("never inherits the session model for a repository-local lane", () => {
		expect(laneModel("some-custom-house-lane", 1_000)).toBe("haiku");
	});

	it("keeps the verify and synthesis gate above the lane tier", () => {
		expect(VERIFY_MODEL).toBe("sonnet");
		expect(SYNTHESIS_MODEL).toBe("sonnet");
	});

	it("promotes haiku lanes when the bundle outgrows its context window", () => {
		expect(laneModel("naming", HAIKU_BUNDLE_CHAR_LIMIT + 1)).toBe("sonnet");
		expect(laneModel("correctness", HAIKU_BUNDLE_CHAR_LIMIT + 1)).toBe(
			"sonnet",
		);
	});
});

describe("parsePrepareArgs --model", () => {
	it("accepts a known tier", () => {
		expect(parsePrepareArgs(["--model", "haiku"]).model).toBe("haiku");
	});

	it("rejects anything else rather than silently ignoring it", () => {
		expect(() => parsePrepareArgs(["--model", "gpt-4o-mini"])).toThrow(
			/--model must be one of/,
		);
	});
});
