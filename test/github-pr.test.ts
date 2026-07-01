import { describe, expect, it, vi } from "vitest";
import {
	bucketFromCheck,
	fetchCurrentBranchPr,
	normalizeChecks,
	normalizePullRequestView,
} from "../extensions/gh-status/github-pr.ts";
import type { GitHubRepo } from "../extensions/gh-status/types.ts";

const repo: GitHubRepo = {
	owner: "owner",
	name: "repo",
	fullName: "owner/repo",
	remoteUrl: "git@github.com:owner/repo.git",
};

describe("bucketFromCheck", () => {
	it("maps failed conclusions to fail", () => {
		expect(bucketFromCheck({ conclusion: "FAILURE" })).toBe("fail");
	});

	it("maps pending states to pending", () => {
		expect(bucketFromCheck({ state: "IN_PROGRESS" })).toBe("pending");
	});

	it("maps skipped and cancelled states", () => {
		expect(bucketFromCheck({ state: "SKIPPED" })).toBe("skipping");
		expect(bucketFromCheck({ state: "CANCELLED" })).toBe("cancel");
	});
});

describe("normalizeChecks", () => {
	it("keeps failures only for the current head sha when check sha is present", () => {
		expect(
			normalizeChecks(
				[
					{ name: "current", conclusion: "FAILURE", commit: { oid: "abc" } },
					{ name: "old", conclusion: "FAILURE", commit: { oid: "def" } },
					{ name: "unattached", conclusion: "SUCCESS" },
				],
				"abc",
			),
		).toEqual([
			{ name: "current", bucket: "fail", conclusion: "FAILURE", sha: "abc" },
			{ name: "unattached", bucket: "pass", conclusion: "SUCCESS" },
		]);
	});
});

describe("normalizePullRequestView", () => {
	it("normalizes PR metadata, checks, and bot activities", () => {
		const pr = normalizePullRequestView(repo, "feature/x", {
			number: 10,
			url: "https://github.com/owner/repo/pull/10",
			headRefOid: "abc",
			statusCheckRollup: [
				{ name: "ci", conclusion: "FAILURE", commit: { oid: "abc" } },
			],
			comments: [
				{ id: "c1", author: { login: "octocat", type: "User" }, body: "hello" },
			],
			reviews: [
				{
					id: "r1",
					author: { login: "github-copilot[bot]", type: "Bot" },
					body: "bug",
				},
			],
		});

		expect(pr).toMatchObject({
			kind: "pr",
			number: 10,
			checks: [{ name: "ci", bucket: "fail" }],
		});
		expect(
			pr.kind === "pr" ? pr.activities.map((activity) => activity.isBot) : [],
		).toEqual([false, true]);
		expect(pr.kind === "pr" ? pr.activities[0]?.key : "").toContain(
			"owner/repo:10:comment:node:c1",
		);
	});
});

describe("fetchCurrentBranchPr", () => {
	it("returns no_pr for gh not-found output", async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({
				stdout: "",
				stderr: "no pull requests found",
				code: 1,
				killed: false,
			});

		await expect(
			fetchCurrentBranchPr(exec, "/repo", repo, "feature/x"),
		).resolves.toMatchObject({
			ok: true,
			value: { kind: "no_pr" },
		});
	});

	it("returns exec_failed for missing or unauthenticated gh errors", async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({
				stdout: "",
				stderr: "gh: command not found",
				code: 127,
				killed: false,
			});

		await expect(
			fetchCurrentBranchPr(exec, "/repo", repo, "feature/x"),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "exec_failed", message: "gh: command not found" },
		});
	});

	it("returns json_parse_failed for malformed gh JSON", async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({
				stdout: "not json",
				stderr: "",
				code: 0,
				killed: false,
			});

		await expect(
			fetchCurrentBranchPr(exec, "/repo", repo, "feature/x"),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "json_parse_failed" },
		});
	});
});
