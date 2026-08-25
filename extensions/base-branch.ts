/**
 * Base-branch discovery for review targets.
 *
 * `origin/HEAD` only records the repository's *default* branch. Plenty of repos
 * default to `main` while feature work is actually cut from — and merged back
 * into — `dev`/`develop`. Diffing such a branch against `main` drags in every
 * commit the integration branch is ahead by, so the review drowns in code the
 * author never touched.
 *
 * So instead of trusting the default, ask git where the head actually forked
 * from: for each candidate base, count the commits between its merge base and
 * the head. The candidate with the fewest is the branch this work was cut from.
 */

/** Runs `git <args>` in the review worktree; rejects on non-zero exit. */
export type GitRunner = (args: string[]) => Promise<string>;

/**
 * Candidates tried before the repository default. Order is the tie-break:
 * when a branch is equidistant from `dev` and `main` (nothing has landed on
 * either since the fork), the integration branch wins.
 */
export const PREFERRED_BASE_BRANCHES = ["dev", "develop", "development"];

/** Candidates tried after the repository default. */
export const FALLBACK_BASE_BRANCHES = ["main", "master", "trunk"];

/** Used only when git tells us nothing at all. */
export const DEFAULT_BASE_BRANCH = "main";

export type ResolvedBaseBranch = {
	/** Bare branch name, e.g. `develop` — for `gh pr create --base` and display. */
	branch: string;
	/** Resolvable ref, e.g. `origin/develop` — for `git diff`/`git merge-base`. */
	ref: string;
	/** Commits on the head that are not on this base, or `undefined` if guessed. */
	distance?: number;
	/** How the base was chosen, for logging and prompt context. */
	reason: "fork-point" | "origin-head" | "default";
};

async function tryGit(
	git: GitRunner,
	args: string[],
): Promise<string | undefined> {
	try {
		const output = (await git(args)).trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

function stripRemote(branch: string): string {
	return branch.replace(/^refs\/remotes\//, "").replace(/^origin\//, "");
}

/** The branch `origin/HEAD` points at, when the remote advertises one. */
export async function originDefaultBranch(
	git: GitRunner,
): Promise<string | undefined> {
	const head = await tryGit(git, [
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"--short",
	]);
	const branch = head ? stripRemote(head) : undefined;
	return branch || undefined;
}

/** Prefer the remote-tracking ref; fall back to a local branch of that name. */
async function resolveCandidateRef(
	git: GitRunner,
	branch: string,
): Promise<string | undefined> {
	for (const ref of [`origin/${branch}`, branch]) {
		const verified = await tryGit(git, [
			"rev-parse",
			"--verify",
			"--quiet",
			`${ref}^{commit}`,
		]);
		if (verified) return ref;
	}
	return undefined;
}

/**
 * Candidate bases in preference order: `dev`-style integration branches first,
 * then whatever `origin/HEAD` advertises, then the usual trunk names. The head
 * branch itself is excluded — a branch is never its own base.
 */
export function baseBranchCandidates(
	defaultBranch: string | undefined,
	headBranch: string | undefined,
): string[] {
	const ordered = [
		...PREFERRED_BASE_BRANCHES,
		...(defaultBranch ? [defaultBranch] : []),
		...FALLBACK_BASE_BRANCHES,
	];
	const head = headBranch ? stripRemote(headBranch) : undefined;
	const seen = new Set<string>();
	return ordered.filter((branch) => {
		if (!branch || branch === head || seen.has(branch)) return false;
		seen.add(branch);
		return true;
	});
}

/**
 * Pick the branch `headRef` was most likely branched off from.
 *
 * Never throws: a repo with no remote, no candidates, or a broken git falls
 * through to `origin/HEAD` and finally to `main`, matching the old behavior.
 */
export async function resolveBaseBranch(
	git: GitRunner,
	headRef = "HEAD",
): Promise<ResolvedBaseBranch> {
	const defaultBranch = await originDefaultBranch(git);
	const headBranch =
		(await tryGit(git, ["rev-parse", "--abbrev-ref", headRef])) ?? headRef;
	// Resolve the head to a sha once, so a detached HEAD or a name that only
	// exists on the remote still measures against the same commit every time.
	const head =
		(await tryGit(git, ["rev-parse", "--verify", "--quiet", `${headRef}^{commit}`])) ??
		(await tryGit(git, [
			"rev-parse",
			"--verify",
			"--quiet",
			`origin/${headRef}^{commit}`,
		])) ??
		headRef;

	let best: ResolvedBaseBranch | undefined;
	for (const branch of baseBranchCandidates(defaultBranch, headBranch)) {
		const ref = await resolveCandidateRef(git, branch);
		if (!ref) continue;
		const mergeBase = await tryGit(git, ["merge-base", ref, head]);
		if (!mergeBase) continue;
		const counted = await tryGit(git, [
			"rev-list",
			"--count",
			`${mergeBase}..${head}`,
		]);
		const distance = Number.parseInt(counted ?? "", 10);
		if (!Number.isInteger(distance)) continue;
		// Strictly-less keeps the first candidate on a tie, which is what makes
		// the preference order above meaningful.
		if (!best || distance < (best.distance ?? Number.POSITIVE_INFINITY)) {
			best = { branch, ref, distance, reason: "fork-point" };
		}
	}
	if (best) return best;
	if (defaultBranch) {
		return {
			branch: defaultBranch,
			ref: `origin/${defaultBranch}`,
			reason: "origin-head",
		};
	}
	return {
		branch: DEFAULT_BASE_BRANCH,
		ref: `origin/${DEFAULT_BASE_BRANCH}`,
		reason: "default",
	};
}

/** `resolveBaseBranch` reduced to the ref callers pass to `git diff`. */
export async function resolveBaseRef(
	git: GitRunner,
	headRef = "HEAD",
): Promise<string> {
	return (await resolveBaseBranch(git, headRef)).ref;
}
