import { describe, expect, it, vi } from "vitest";
import {
	parseReviewComments,
	postReviewComments,
	renderReviewComment,
} from "../extensions/review-comments.ts";
import {
	parsePostCommentArgs,
	parsePullRequestMetadata,
	runPostVetteComments,
} from "../scripts/post-vette-comments.ts";

const valid = {
	title: "Cache misses lose updates",
	severity: "blocker",
	file: "src/cache.ts",
	line: 42,
	codeSummary: "The write path skips the version check.",
	what: "Concurrent writes can overwrite newer data.",
	why: "Users may lose a confirmed update.",
	evidence: "Focused test fails on the stale version.",
	testCode: 'it("rejects stale writes", () => expect(write()).toThrow())',
	fixBoundary: "Keep the version check in the write transaction.",
};

describe("review comment JSON contract", () => {
	it("parses and normalizes a valid array", () => {
		expect(parseReviewComments(JSON.stringify([valid]))).toEqual([valid]);
	});
	it.each([
		["missing title", { ...valid, title: "" }],
		["invalid severity", { ...valid, severity: "concern" }],
		["invalid line", { ...valid, line: 0 }],
		["line without file", { ...valid, file: undefined }],
		["missing required field", { ...valid, why: undefined }],
	])("rejects %s", (_name, value) => {
		expect(() => parseReviewComments(JSON.stringify([value]))).toThrow();
	});
	it("rejects malformed, object, and empty input", () => {
		expect(() => parseReviewComments("")).toThrow();
		expect(() => parseReviewComments("{")).toThrow(/invalid comment JSON/);
		expect(() => parseReviewComments(JSON.stringify(valid))).toThrow(/array/);
	});
	it("renders stable headings and includes supplied regression test code", () => {
		const body = renderReviewComment(
			parseReviewComments(
				JSON.stringify([{ ...valid, evidence: "", fixBoundary: "" }]),
			)[0],
		);
		expect(body).toContain("🔴 **Blocker**");
		expect(body).toContain("</summary>\n\n## Code summary");
		expect(body).toContain("## What");
		expect(body).toContain("## Why");
		expect(body).toContain("## Regression test");
		// The source must land inside a fence, not as loose prose.
		expect(body).toMatch(
			/## Regression test\n```\nit\("rejects stale writes".*\n```/,
		);
		expect(body).not.toContain("## Evidence");
		expect(body).not.toContain("## Fix boundary");
	});
	it("escapes title HTML characters", () => {
		const body = renderReviewComment(
			parseReviewComments(
				JSON.stringify([{ ...valid, title: "<unsafe> & issue" }]),
			)[0],
		);
		expect(body).toContain("&lt;unsafe&gt; &amp; issue");
	});
});

describe("review comment posting", () => {
	it("posts exact-line comments without fallback", async () => {
		const executor = vi.fn(async (_command: string, _args: string[]) => ({
			stdout: '{"html_url":"https://example.test/comment"}',
		}));
		const result = await postReviewComments(
			parseReviewComments(JSON.stringify([valid])),
			{ repository: "owner/repo", pullRequest: 7, commitId: "abc" },
			executor,
		);
		expect(result[0]).toMatchObject({
			ok: true,
			location: "line",
			fallbackReasons: [],
		});
		expect(executor).toHaveBeenCalledTimes(1);
	});
	it("falls back from line to file to general and records reasons", async () => {
		const executor = vi.fn(async (_command: string, args: string[]) => {
			if (args[0] === "api" && args.some((arg) => arg.startsWith("line=")))
				throw new Error("line rejected");
			if (args[0] === "api") throw new Error("file rejected");
			return { stdout: "https://example.test/general" };
		});
		const result = await postReviewComments(
			parseReviewComments(JSON.stringify([valid])),
			{ repository: "owner/repo", pullRequest: 7, commitId: "abc" },
			executor,
		);
		expect(result[0]).toMatchObject({ ok: true, location: "general" });
		expect(result[0].fallbackReasons).toHaveLength(2);
	});
	it("validates the complete payload before any post", async () => {
		const executor = vi.fn();
		expect(() =>
			parseReviewComments(JSON.stringify([valid, { ...valid, what: "" }])),
		).toThrow();
		expect(executor).not.toHaveBeenCalled();
	});
});

describe("post-vette-comments PR metadata", () => {
	it("parses the supported headRepository field", () => {
		expect(
			parsePullRequestMetadata(
				JSON.stringify({ number: 7, headRefOid: "abc" }),
				"owner/repo",
			),
		).toEqual({
			pullRequest: 7,
			commitId: "abc",
			repository: "owner/repo",
		});
	});

	it("anchors comments to the reviewed commit, not the current head", () => {
		// A push between prepare and post would otherwise attach findings to
		// code no lane ever read.
		expect(
			parsePullRequestMetadata(
				JSON.stringify({ number: 7, headRefOid: "pushed-since" }),
				"owner/repo",
				"reviewed",
			),
		).toMatchObject({ commitId: "reviewed" });
	});

	it("falls back to the current head when the run pinned no commit", () => {
		expect(
			parsePullRequestMetadata(
				JSON.stringify({ number: 7, headRefOid: "abc" }),
				"owner/repo",
			),
		).toMatchObject({ commitId: "abc" });
	});
});

describe("force-pushed reviewed commit", () => {
	const comment = {
		severity: "blocker",
		title: "t",
		file: "a.ts",
		line: 3,
		codeSummary: "c",
		what: "w",
		why: "y",
	};

	it("keeps the inline anchor by retrying on the current head", async () => {
		// A force-push between review and post orphans the reviewed commit and
		// rejects every inline placement. Degrading straight to a general
		// comment would lose the anchor for the whole run.
		const executor = vi.fn(async (_cmd: string, args: string[]) => {
			if (args.join(" ").includes("commit_id=reviewed"))
				throw new Error("422 commit_id is not part of the pull request");
			return { stdout: JSON.stringify({ html_url: "u" }), stderr: "" };
		});
		const [result] = await postReviewComments(
			parseReviewComments(JSON.stringify([comment])),
			{
				pullRequest: 1,
				commitId: "reviewed",
				fallbackCommitId: "current",
				repository: "o/r",
			},
			executor as never,
		);

		expect(result).toMatchObject({ ok: true, location: "line" });
		expect(result.fallbackReasons.join(" ")).toContain("retried on current");
	});

	it("does not retry when there is no newer head to fall back to", async () => {
		const executor = vi.fn(async () => {
			throw new Error("422 rejected");
		});
		const [result] = await postReviewComments(
			parseReviewComments(JSON.stringify([comment])),
			{ pullRequest: 1, commitId: "reviewed", repository: "o/r" },
			executor as never,
		);

		expect(result.ok).toBe(false);
		expect(result.fallbackReasons.join(" ")).not.toContain("retried");
	});
});

describe("post-vette-comments CLI", () => {
	it("accepts direct JSON and dry-runs without network", async () => {
		expect(
			parsePostCommentArgs(["--dry-run", "--json", JSON.stringify([valid])]),
		).toMatchObject({ dryRun: true, json: expect.any(String) });
		const write = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		await expect(
			runPostVetteComments(["--dry-run", "--json", JSON.stringify([valid])]),
		).resolves.toBe(0);
		write.mockRestore();
	});
});
