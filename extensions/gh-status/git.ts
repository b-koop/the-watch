import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitHubRepo, GitResolution } from "./types.ts";

type Exec = ExtensionAPI["exec"];

const GITHUB_REMOTE_PATTERNS = [
	/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
	/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
];

export function parseGitHubRepo(
	remoteUrl: string,
): Pick<GitHubRepo, "owner" | "name" | "fullName"> | undefined {
	for (const pattern of GITHUB_REMOTE_PATTERNS) {
		const match = remoteUrl.trim().match(pattern);
		if (!match?.[1] || !match[2]) continue;

		const owner = match[1];
		const name = match[2];
		return { owner, name, fullName: `${owner}/${name}` };
	}

	return undefined;
}

export function firstGitHubRemote(
	remoteOutput: string,
): GitHubRepo | undefined {
	for (const line of remoteOutput.split("\n")) {
		const columns = line.trim().split(/\s+/);
		const remoteUrl = columns[1];
		if (!remoteUrl) continue;

		const parsed = parseGitHubRepo(remoteUrl);
		if (parsed) return { ...parsed, remoteUrl };
	}

	return undefined;
}

export async function resolveGitHubRepo(
	exec: Exec,
	cwd: string,
): Promise<GitResolution> {
	const remoteResult = await exec("git", ["remote", "-v"], {
		cwd,
		timeout: 5_000,
	});
	if (remoteResult.code !== 0) {
		return {
			kind: "not_git_repo",
			message: "Current working directory is not a git repository.",
		};
	}

	const repo = firstGitHubRemote(remoteResult.stdout);
	if (!repo) {
		return {
			kind: "not_github_repo",
			message: "Git repository has no GitHub remote.",
		};
	}

	const branchResult = await exec("git", ["branch", "--show-current"], {
		cwd,
		timeout: 5_000,
	});
	if (branchResult.code !== 0) {
		const stderr = branchResult.stderr.trim();
		return {
			kind: "git_error",
			message: "Failed to determine current git branch.",
			...(stderr ? { stderr } : {}),
		};
	}

	const branch = branchResult.stdout.trim();
	if (!branch) {
		return {
			kind: "detached_head",
			repo,
			message: "Git repository is in detached HEAD state.",
		};
	}

	return { kind: "repo", repo, branch };
}
