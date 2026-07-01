import { describe, expect, it, vi } from "vitest";
import {
	firstGitHubRemote,
	parseGitHubRepo,
	resolveGitHubRepo,
} from "../extensions/gh-status/git.ts";

describe("parseGitHubRepo", () => {
	it("parses SSH GitHub remotes", () => {
		expect(parseGitHubRepo("git@github.com:owner/repo.git")).toEqual({
			owner: "owner",
			name: "repo",
			fullName: "owner/repo",
		});
	});

	it("parses HTTPS GitHub remotes", () => {
		expect(parseGitHubRepo("https://github.com/owner/repo.git")).toEqual({
			owner: "owner",
			name: "repo",
			fullName: "owner/repo",
		});
	});

	it("rejects non-GitHub remotes", () => {
		expect(parseGitHubRepo("git@example.com:owner/repo.git")).toBeUndefined();
	});
});

describe("firstGitHubRemote", () => {
	it("returns the first parseable GitHub remote from git remote output", () => {
		expect(
			firstGitHubRemote(
				"origin\thttps://example.com/a/b.git (fetch)\nupstream\tgit@github.com:owner/repo.git (fetch)",
			),
		).toEqual({
			owner: "owner",
			name: "repo",
			fullName: "owner/repo",
			remoteUrl: "git@github.com:owner/repo.git",
		});
	});
});

describe("resolveGitHubRepo", () => {
	it("returns not_git_repo when git remote fails", async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({
				stdout: "",
				stderr: "fatal",
				code: 128,
				killed: false,
			});

		await expect(resolveGitHubRepo(exec, "/repo")).resolves.toMatchObject({
			kind: "not_git_repo",
		});
	});

	it("returns not_github_repo when no GitHub remote is present", async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({
				stdout: "origin\thttps://example.com/a/b.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			});

		await expect(resolveGitHubRepo(exec, "/repo")).resolves.toMatchObject({
			kind: "not_github_repo",
		});
	});

	it("returns git_error when branch resolution fails", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:owner/repo.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "fatal branch",
				code: 128,
				killed: false,
			});

		await expect(resolveGitHubRepo(exec, "/repo")).resolves.toMatchObject({
			kind: "git_error",
			stderr: "fatal branch",
		});
	});

	it("returns detached_head when branch is empty", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:owner/repo.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "\n",
				stderr: "",
				code: 0,
				killed: false,
			});

		await expect(resolveGitHubRepo(exec, "/repo")).resolves.toMatchObject({
			kind: "detached_head",
		});
	});

	it("returns repo and branch when both resolve", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\thttps://github.com/owner/repo.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "feature/test\n",
				stderr: "",
				code: 0,
				killed: false,
			});

		await expect(resolveGitHubRepo(exec, "/repo")).resolves.toMatchObject({
			kind: "repo",
			branch: "feature/test",
			repo: { fullName: "owner/repo" },
		});
	});
});
