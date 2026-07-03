import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	VETTE_BETA_TOPICS,
	VetteBetaCooldown,
	averageTopicDuration,
	formatResolvedModelPool,
	formatVetteBetaSynthesisPrompt,
	loadTopicTimings,
	loadVetteBetaConfig,
	resolveModelPool,
	runVetteBetaReview,
	type VetteBetaReviewMode,
	type VetteBetaReviewTarget,
} from "./vette-beta.ts";

const execFileAsync = promisify(execFile);

type GhAuthor = {
	login?: string;
	name?: string;
	is_bot?: boolean;
};

type GhActivity = {
	author?: { login?: string; type?: string; __typename?: string };
	body?: string;
	url?: string;
	createdAt?: string;
	updatedAt?: string;
	submittedAt?: string;
};

type GhCheckRollup = {
	name?: string;
	workflowName?: string;
	workflow?: string;
	state?: string;
	status?: string;
	conclusion?: string;
	bucket?: string;
};

type GhPullRequest = {
	number: number;
	url: string;
	title?: string;
	body?: string;
	author?: GhAuthor;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
	isDraft?: boolean;
	state?: string;
	mergedAt?: string | null;
	mergeStateStatus?: string;
	reviewDecision?: string;
	updatedAt?: string;
	comments?: GhActivity[];
	reviews?: GhActivity[];
	latestReviews?: GhActivity[];
	statusCheckRollup?: GhCheckRollup[];
};

type PrContext = {
	selector: string;
	pr: GhPullRequest;
	localIdentity: string;
	ownership: "local" | "external";
	isOwner: boolean;
	dirtyStatus: string;
};

type DraftPrContext = {
	branch: string;
	baseBranch: string;
	localIdentity: string;
	dirtyStatus: string;
	remoteUrl: string;
};

type PrCommandContext =
	| { kind: "existing"; prContext: PrContext }
	| { kind: "draft"; draftContext: DraftPrContext; resolveError: string };

type ScopeVetteContext = {
	target: string;
	branch: string;
	baseBranch: string;
	dirtyStatus: string;
	draftsDir: string;
	findingsPath: string;
	resolveError: string;
};

type VetteCommandContext =
	| { kind: "pr"; prContext: PrContext }
	| { kind: "scope"; scopeContext: ScopeVetteContext };

type VetteBetaStatusContext = {
	targetLabel: string;
	reviewMode: VetteBetaReviewMode;
	queued: boolean;
	progress?: string;
};

type CommandStatus = {
	command: "vette" | "pr";
	target: string;
	mode: string;
	phase: "working" | "queued" | "idle" | "blocked" | "merged";
	progress: string;
	nextCheckAt?: number;
};

const GH_PR_FIELDS = [
	"number",
	"url",
	"title",
	"body",
	"author",
	"headRefName",
	"headRefOid",
	"baseRefName",
	"isDraft",
	"state",
	"mergedAt",
	"mergeStateStatus",
	"reviewDecision",
	"updatedAt",
	"comments",
	"reviews",
	"latestReviews",
	"statusCheckRollup",
].join(",");

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatModelConnection(selector: string): string {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) {
		return `connection=${selector} model=${selector}`;
	}
	return `connection=${selector.slice(0, slash)} model=${selector.slice(slash + 1)}`;
}

function parseArgs(args: string): {
	selector: string;
	scopeTarget: string;
	wantsPosting: boolean;
	wantsScope: boolean;
	wantsWatch: boolean;
	raw: string;
} {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const flags = new Set(tokens.filter((token) => token.startsWith("--")));
	const positional = tokens.filter((token) => !token.startsWith("--"));
	const selector = positional[0] ?? "";
	const wantsScope = flags.has("--scope") || flags.has("--service");
	return {
		selector,
		scopeTarget: positional.join(" ") || (wantsScope ? "." : ""),
		wantsPosting:
			flags.has("--post-comments") ||
			flags.has("--post") ||
			flags.has("--submit-review"),
		wantsScope,
		wantsWatch: !flags.has("--no-watch"),
		raw: args.trim(),
	};
}

async function run(
	command: string,
	args: string[],
	cwd: string,
): Promise<string> {
	try {
		const { stdout } = await execFileAsync(command, args, {
			cwd,
			maxBuffer: 10 * 1024 * 1024,
		});
		return String(stdout).trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stderr =
			typeof (error as { stderr?: unknown }).stderr === "string"
				? String((error as { stderr: string }).stderr).trim()
				: "";
		throw new Error(stderr ? `${message}\n${stderr}` : message);
	}
}

async function getDirtyStatus(cwd: string): Promise<string> {
	try {
		return await run("git", ["status", "--short"], cwd);
	} catch {
		return "";
	}
}

async function getLocalGitIdentity(cwd: string): Promise<{
	name?: string;
	email?: string;
	label: string;
}> {
	const [name, email] = await Promise.all([
		run("git", ["config", "user.name"], cwd).catch(() => ""),
		run("git", ["config", "user.email"], cwd).catch(() => ""),
	]);
	const trimmedName = name.trim();
	const trimmedEmail = email.trim();
	const label =
		trimmedName && trimmedEmail
			? `${trimmedName} <${trimmedEmail}>`
			: trimmedEmail || trimmedName || "<local git identity unavailable>";
	return {
		...(trimmedName ? { name: trimmedName } : {}),
		...(trimmedEmail ? { email: trimmedEmail } : {}),
		label,
	};
}

async function getCurrentBranch(cwd: string): Promise<string> {
	const branch = await run("git", ["branch", "--show-current"], cwd);
	if (!branch) {
		throw new Error(
			"This workflow must run from a named git branch, not detached HEAD.",
		);
	}
	return branch;
}

async function getDefaultBaseBranch(cwd: string): Promise<string> {
	try {
		const originHead = await run(
			"git",
			["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
			cwd,
		);
		return originHead.replace(/^origin\//, "") || "main";
	} catch {
		return "main";
	}
}

async function getOriginRemoteUrl(cwd: string): Promise<string> {
	try {
		return await run("git", ["remote", "get-url", "origin"], cwd);
	} catch {
		return "<unavailable>";
	}
}

async function resolveDraftPrContext(cwd: string): Promise<DraftPrContext> {
	const [branch, baseBranch, identity, dirtyStatus, remoteUrl] =
		await Promise.all([
			getCurrentBranch(cwd),
			getDefaultBaseBranch(cwd),
			getLocalGitIdentity(cwd),
			getDirtyStatus(cwd),
			getOriginRemoteUrl(cwd),
		]);

	return {
		branch,
		baseBranch,
		localIdentity: identity.label,
		dirtyStatus,
		remoteUrl,
	};
}

async function resolvePrCommandContext(
	selector: string,
	cwd: string,
): Promise<PrCommandContext> {
	try {
		return {
			kind: "existing",
			prContext: await resolvePrContext(selector, cwd),
		};
	} catch (error) {
		if (selector) throw error;
		return {
			kind: "draft",
			draftContext: await resolveDraftPrContext(cwd),
			resolveError: error instanceof Error ? error.message : String(error),
		};
	}
}

function isLikelyPrSelector(selector: string): boolean {
	return /^#?\d+$/.test(selector) || /^https?:\/\//i.test(selector);
}

async function resolveScopeVetteContext(
	target: string,
	resolveError: string,
	cwd: string,
): Promise<ScopeVetteContext> {
	const [branch, baseBranch, dirtyStatus] = await Promise.all([
		getCurrentBranch(cwd),
		getDefaultBaseBranch(cwd),
		getDirtyStatus(cwd),
	]);
	const slug = slugifyBranch(target, "scope");
	const draftsDir = `/tmp/pi-vette-bug-drafts/${slug}`;
	return {
		target,
		branch,
		baseBranch,
		dirtyStatus,
		draftsDir,
		findingsPath: `${draftsDir}/findings.md`,
		resolveError,
	};
}

async function resolveVetteCommandContext(
	parsed: ReturnType<typeof parseArgs>,
	cwd: string,
): Promise<VetteCommandContext> {
	if (parsed.wantsScope) {
		return {
			kind: "scope",
			scopeContext: await resolveScopeVetteContext(
				parsed.scopeTarget,
				"Scope mode explicitly requested.",
				cwd,
			),
		};
	}

	try {
		return {
			kind: "pr",
			prContext: await resolvePrContext(parsed.selector, cwd),
		};
	} catch (error) {
		if (!parsed.scopeTarget || isLikelyPrSelector(parsed.selector)) {
			throw error;
		}
		return {
			kind: "scope",
			scopeContext: await resolveScopeVetteContext(
				parsed.scopeTarget,
				error instanceof Error ? error.message : String(error),
				cwd,
			),
		};
	}
}

type LocalCommitEvidence = {
	authorEmail?: string;
	authorName?: string;
	message?: string;
	parents?: string[];
};

export function inferLocalOwnership(input: {
	localUserEmail?: string;
	localUserName?: string;
	commits: LocalCommitEvidence[];
}): { isOwner: boolean; ownership: "local" | "external" } {
	const localEmail = input.localUserEmail?.trim().toLowerCase();
	const localName = input.localUserName?.trim().toLowerCase();
	const isOwner = input.commits.some((commit) => {
		if (
			(commit.parents?.length ?? 0) > 1 ||
			commit.message?.startsWith("Merge ")
		) {
			return false;
		}
		return localEmail
			? commit.authorEmail?.trim().toLowerCase() === localEmail
			: Boolean(
					localName && commit.authorName?.trim().toLowerCase() === localName,
				);
	});

	return isOwner
		? { isOwner: true, ownership: "local" }
		: { isOwner: false, ownership: "external" };
}

async function localBranchExists(
	cwd: string,
	branch: string,
): Promise<boolean> {
	try {
		await run("git", ["rev-parse", "--verify", `${branch}^{commit}`], cwd);
		return true;
	} catch {
		return false;
	}
}

async function mergeBaseForBranch(
	cwd: string,
	branch: string,
	baseBranch: string | undefined,
): Promise<string | undefined> {
	const candidates = baseBranch ? [`origin/${baseBranch}`, baseBranch] : [];
	for (const candidate of candidates) {
		try {
			return await run("git", ["merge-base", candidate, branch], cwd);
		} catch {
			// Try the next local base candidate.
		}
	}
	return undefined;
}

function parseCommitEvidence(output: string): LocalCommitEvidence[] {
	return output.split("\x1e").flatMap((rawEntry) => {
		const entry = rawEntry.trim();
		if (!entry) return [];
		const [, authorName, authorEmail, message, parents] = entry.split("\x00");
		return [
			{
				...(authorName ? { authorName } : {}),
				...(authorEmail ? { authorEmail } : {}),
				...(message ? { message } : {}),
				...(parents ? { parents: parents.split(" ").filter(Boolean) } : {}),
			},
		];
	});
}

async function getLocalCommitEvidence(
	cwd: string,
	branch: string | undefined,
	baseBranch: string | undefined,
): Promise<LocalCommitEvidence[]> {
	if (!branch || !(await localBranchExists(cwd, branch))) return [];
	const mergeBase = await mergeBaseForBranch(cwd, branch, baseBranch);
	if (!mergeBase) return [];
	const output = await run(
		"git",
		[
			"log",
			"--format=%H%x00%an%x00%ae%x00%s%x00%P%x1e",
			`${mergeBase}..${branch}`,
		],
		cwd,
	);
	return parseCommitEvidence(output);
}

async function resolveLocalOwnership(
	cwd: string,
	pr: GhPullRequest,
): Promise<{
	localIdentity: string;
	isOwner: boolean;
	ownership: "local" | "external";
}> {
	const identity = await getLocalGitIdentity(cwd);
	const commits = await getLocalCommitEvidence(
		cwd,
		pr.headRefName,
		pr.baseRefName,
	);
	const ownership = inferLocalOwnership({
		localUserEmail: identity.email,
		localUserName: identity.name,
		commits,
	});
	return { localIdentity: identity.label, ...ownership };
}

async function resolvePrContext(
	selector: string,
	cwd: string,
): Promise<PrContext> {
	const prArgs = ["pr", "view"];
	if (selector) prArgs.push(selector);
	prArgs.push("--json", GH_PR_FIELDS);

	let pr: GhPullRequest;
	try {
		pr = JSON.parse(await run("gh", prArgs, cwd)) as GhPullRequest;
	} catch (error) {
		const hint = selector
			? `Could not resolve PR selector ${shellQuote(selector)}. Use a PR number, branch, or URL.`
			: "Could not resolve a PR for the current branch. Pass a PR number, branch, or URL.";
		throw new Error(
			`${hint}\n\n${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const [ownership, dirtyStatus] = await Promise.all([
		resolveLocalOwnership(cwd, pr),
		getDirtyStatus(cwd),
	]);

	return {
		selector,
		pr,
		localIdentity: ownership.localIdentity,
		ownership: ownership.ownership,
		isOwner: ownership.isOwner,
		dirtyStatus,
	};
}

function slugifyBranch(value: string, fallback: string): string {
	const slug = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || fallback;
}

function branchSlug(ctx: PrContext): string {
	const raw = ctx.pr.headRefName || ctx.selector || `pr-${ctx.pr.number}`;
	return slugifyBranch(raw, `pr-${ctx.pr.number}`);
}

function findingsArtifactPath(ctx: PrContext): string {
	return `/tmp/pi-vette-findings/${branchSlug(ctx)}/pr-${ctx.pr.number}-findings.md`;
}

function isMergedPullRequest(pr: GhPullRequest): boolean {
	return pr.state?.toUpperCase() === "MERGED" || Boolean(pr.mergedAt);
}

function draftFindingsArtifactPath(ctx: DraftPrContext): string {
	return `/tmp/pi-vette-findings/${slugifyBranch(ctx.branch, "draft-pr")}/draft-pr-findings.md`;
}

function prSnapshotSummary(pr: GhPullRequest): string {
	const checks = pr.statusCheckRollup ?? [];
	const failedChecks = checks.filter((check) =>
		/failure|timed_out|action_required|fail|error/i.test(
			`${check.conclusion ?? check.bucket ?? check.state ?? check.status ?? ""}`,
		),
	).length;
	const pendingChecks = checks.filter((check) =>
		/pending|queued|in_progress|waiting/i.test(
			`${check.state ?? check.status ?? check.bucket ?? ""}`,
		),
	).length;
	const activityCount =
		(pr.comments?.length ?? 0) +
		(pr.reviews?.length ?? 0) +
		(pr.latestReviews?.length ?? 0);
	return `${checks.length} checks (${failedChecks} failing, ${pendingChecks} pending); ${activityCount} comments/reviews`;
}

function prSummary(ctx: PrContext): string {
	return [
		`PR: ${ctx.pr.url} (#${ctx.pr.number})`,
		`Title: ${ctx.pr.title ?? "<missing>"}`,
		`Author: ${ctx.pr.author?.login ?? "<unknown>"}`,
		`Local git identity: ${ctx.localIdentity}`,
		`Ownership mode: ${ctx.isOwner ? "owner repair" : "external review"}`,
		`Ownership evidence: ${ctx.ownership === "local" ? "matching local non-merge commit" : "no matching local non-merge commit"}`,
		`Head branch: ${ctx.pr.headRefName ?? "<unknown>"}`,
		`Head SHA: ${ctx.pr.headRefOid ?? "<unknown>"}`,
		`Base branch: ${ctx.pr.baseRefName ?? "<unknown>"}`,
		`PR snapshot: ${prSnapshotSummary(ctx.pr)}`,
		`Findings artifact: ${findingsArtifactPath(ctx)}`,
		`Draft: ${String(ctx.pr.isDraft ?? false)}`,
		`PR state: ${ctx.pr.state ?? "<unknown>"}`,
		`Merged at: ${ctx.pr.mergedAt ?? "<not merged>"}`,
		`Merge state: ${ctx.pr.mergeStateStatus ?? "<unknown>"}`,
		`Review decision: ${ctx.pr.reviewDecision ?? "<unknown>"}`,
		ctx.dirtyStatus
			? `Dirty worktree before command:\n${ctx.dirtyStatus}`
			: "Dirty worktree before command: clean or unavailable",
	].join("\n");
}

function draftPrSummary(ctx: DraftPrContext, resolveError: string): string {
	return [
		"PR: <not created yet>",
		`Current branch: ${ctx.branch}`,
		`Proposed base branch: ${ctx.baseBranch}`,
		`Origin remote: ${ctx.remoteUrl}`,
		`Local git identity: ${ctx.localIdentity}`,
		`Findings artifact: ${draftFindingsArtifactPath(ctx)}`,
		`Existing PR lookup: ${resolveError}`,
		ctx.dirtyStatus
			? `Dirty worktree before command:\n${ctx.dirtyStatus}`
			: "Dirty worktree before command: clean or unavailable",
	].join("\n");
}

function scopeVetteSummary(ctx: ScopeVetteContext): string {
	return [
		`Target scope: ${ctx.target}`,
		`Current branch: ${ctx.branch}`,
		`Reference base branch: ${ctx.baseBranch}`,
		`Bug ticket drafts directory: ${ctx.draftsDir}`,
		`Findings artifact: ${ctx.findingsPath}`,
		`PR lookup fallback reason: ${ctx.resolveError}`,
		ctx.dirtyStatus
			? `Dirty worktree before command:\n${ctx.dirtyStatus}`
			: "Dirty worktree before command: clean or unavailable",
	].join("\n");
}

function subagentContract(): string {
	return `Required focused-agent contract:
- Use isolated focused agents for non-trivial work. Do not let two agents write overlapping paths or share mutable ports, databases, caches, fixtures, or browser profiles.
- Red test agent: may edit only tests/fixtures needed for one behavior; must prove the new test fails for the intended reason.
- Green implementation agent: may edit only production code required to pass the staged red test; must not edit tests.
- Reviewer/verifier agent: read-only by default; verifies behavior, minimality, test honesty, and no unrelated edits.
- CI failure investigator: classifies failures as related, unrelated, or uncertain; uncertain is treated as related until proven otherwise.
- Merge conflict resolver: resolves conflicts minimally, preserves both sides when safe, removes all conflict markers, and runs focused verification.
- Commit/push only after parent review of agent output and passing verification. Never force push.`;
}

function parallelSuggestionContract(): string {
	return `Required parallel suggestion lanes:
- Run these read-only lanes in parallel before choosing fixes or comments: vette risk review, naming/test-name check, and thermo-nuclear-code-quality-review.
- The vette lane looks for correctness, security, reliability, data, UX, and test gaps in changed behavior.
- The naming/test-name lane checks PR title/body wording, identifiers, branch/ticket wording when relevant, and especially behavior-first test names.
- The thermo-nuclear lane runs an extremely strict maintainability review for abstraction quality, code judo opportunities, giant files, spaghetti conditionals, type/boundary cleanliness, and simpler structural alternatives.
- Merge the three lane outputs into one deduplicated suggestion set before deciding what to repair or comment on.
- Preserve lane provenance on every suggestion: [vette], [name-check], [thermo-nuclear], or a combined tag when multiple lanes agree.
- Do not serialize these lanes unless a repo constraint prevents parallelism; if serialization is forced, explain why.
- Suggestions become repairs/comments only after parent verification confirms scope, impact, and evidence.
- Name-check suggestions and questions: when the [name-check] lane produces a substantive test-name or identifier/variable naming suggestion (a proposed alternative name, a question about intent, or a recommendation beyond a trivial wording tweak), that suggestion must be posted as a review comment anchored to the exact changed line in the diff. Use a GitHub \`\`\`suggest block with the full replacement line first so the author can apply it directly in the PR UI. Minor mechanical tweaks (typos, casing, punctuation) that the agent can silently fix in owner mode do not require a comment, but any suggestion that questions intent, proposes a meaningfully different name, or asks the author a question must be an inline comment, not bundled into a general PR comment.`;
}

function findingsArtifactContractForPath(path: string): string {
	return `Findings artifact contract:
- Maintain a local Markdown findings artifact at ${path} for this branch/PR.
- Create or update the artifact before posting or repairing anything, and keep it current as verification progresses.
- The artifact must include every candidate finding from every lane, whether verified, rejected, duplicate, out-of-scope, test-reproduced, verified-but-untestable, or still blocked.
- For each item, record: stable finding id, title, source lanes, status, severity/disposition, file/line when known, evidence, verification command/result, repro test path/code when applicable, posted comment URL/status when applicable, and rejection/blocker reason when applicable.
- Use the artifact as the source of truth for final counts and for resuming the review if the session is interrupted.
- Do not commit the artifact unless the user explicitly asks; it is a local temporary reference file.`;
}

function findingsArtifactContract(ctx: PrContext): string {
	return findingsArtifactContractForPath(findingsArtifactPath(ctx));
}

function draftFindingsArtifactContract(ctx: DraftPrContext): string {
	return findingsArtifactContractForPath(draftFindingsArtifactPath(ctx));
}

function bugDraftContract(ctx: ScopeVetteContext): string {
	return `Bug ticket draft contract:
- Create the local directory ${ctx.draftsDir} if it does not exist.
- Write ${ctx.draftsDir}/index.md summarizing every verified, rejected, duplicate, blocked, and unverified candidate.
- Write one Markdown draft per verified bug as ${ctx.draftsDir}/bug-<stable-id>.md.
- Do not create tracker tickets, GitHub issues, or PR comments in scope mode.
- Each bug draft must include: behavior-first title, target scope, severity, user/system impact, affected files/symbols, evidence, focused verification command and result, exact repro test code when practical, why no focused test was practical when omitted, suggested acceptance criteria, and smallest safe fix boundary.
- Unverified suspicions stay only in the findings artifact and index; do not promote them to standalone bug drafts.`;
}

function reviewCommentTestContract(): string {
	return `Review comment reproducibility contract:
- At the end of external-review synthesis, inspect every actionable finding for whether it can be reproduced with a focused unit or regression test.
- For each reproducible finding, build the smallest temporary test that demonstrates the behavior, run the focused test command, and verify it fails for the expected reason on the PR branch.
- Clean up temporary test files unless the user explicitly asked to commit tests; keep the exact test code and failing command output in the review evidence.
- Put the relevant test code directly in the associated GitHub review comment body, along with the command that proved it failed as expected, before posting the verified comment.
- If a verified finding cannot be practically reproduced with a unit/regression test, classify it as untestable and preserve the best available evidence plus the reason no focused failing test is practical.`;
}

function reviewCommentPostingContract(): string {
	return `Review comment posting contract:
- Do not post comments while still gathering, testing, or cleaning up evidence. After all verification and cleanup is complete, post the verified items in one posting pass.
- For each test-reproduced verified finding, post the associated review comment at the most precise location available: prefer file + exact diff line; if no reliable line exists, use the file-level location when GitHub supports it; if the file is not a good/valid review-comment target, post it as a general PR comment with the file/line context in the body.
- For [name-check] test-name or identifier/variable naming suggestions and questions: post each substantive naming suggestion as a review comment anchored to the exact changed line in the diff. Use the minimal naming-suggestion comment style from the template contract: a GitHub \`\`\`suggest block with the full replacement line first, then brief reasoning. Do not attach or reference screenshots, clipboard paths, or local image paths for naming suggestions. These are not bundled into the singular untestable-items comment; they are per-line inline comments even when no repro test applies.
- Build one singular final PR comment for all verified-but-untestable findings. Include each item with lane provenance, severity/disposition, user impact, evidence, why a focused failing test was not practical, and file/line information whenever possible.
- Post the singular untestable-items comment at the end of the posting pass, after all line/file-specific verified comments have been posted.
- If GitHub rejects a line/file comment location, fall back to the next less-specific location and record that fallback in the final report.`;
}

function reviewCommentTemplateContract(): string {
	return `Review comment templates:
- Use the templates below for posted comments. Keep headings and labels stable so the PR thread is scannable.
- For line/file-level test-reproduced findings, post one comment per finding with this body:

### Verified issue: <short behavior-first title>

**Location:** <path:line or path>
**Source lanes:** <[vette] [name-check] [thermo-nuclear]>
**Impact:** <what user/system behavior breaks and who is affected>

**Evidence:**
- <static proof, runtime observation, or failing assertion>
- Verification command: <command>
- Result: fails as expected because <specific failure reason>

**Failing repro test:**
~~~~<language>
<exact temporary test code>
~~~~

**Fix boundary:** <smallest safe change expected>

- For [name-check] test-name-only or identifier/variable naming comments, do not use the verified issue template above. Use this minimal body exactly:

\`\`\`suggest
<full replacement changed line with the better test name, variable name, or identifier, preserving indentation and syntax>
\`\`\`

<brief reasoning for why the replacement better names the behavior>

- For general PR-comment fallbacks of test-reproduced findings, use the same template and keep **Location** as the first field with the best available file/line context.
- For the singular final verified-but-untestable PR comment, use this body:

### Verified findings without focused repro tests

These items were verified but were not practical to demonstrate with focused unit/regression tests. They are grouped here to avoid scattering non-line-specific comments.

1. **<short behavior-first title>**
   - **Location:** <path:line, path, or PR-wide>
   - **Source lanes:** <[vette] [name-check] [thermo-nuclear]>
   - **Impact:** <what user/system behavior breaks and who is affected>
   - **Evidence:** <how it was verified>
   - **Why no focused test:** <reason>
   - **Fix boundary:** <smallest safe change expected>

- If there are no verified-but-untestable findings, do not post the singular untestable-items comment; record "none" in the final report.`;
}

function vettePrompt(
	ctx: PrContext,
	rawArgs: string,
	options: { wantsPosting: boolean },
): string {
	const commentPolicy = options.wantsPosting
		? "The user explicitly allowed posting comments, but posting is already automatic for verified external-review findings."
		: "Post externally visible GitHub review comments automatically for verified external-review findings. Do not ask for additional posting approval after verification passes.";
	const visibleStatusContract = `Visible status requirements:
- Maintain an explicit status/todo sequence and update it immediately as phases change:
  1. Resolve PR context
  2. Run parallel review lanes
  3. Synthesize findings
  4. Verify/repair or prepare verified comments when applicable
  5. Post verified comments when applicable
  6. Complete
- While active, state the current phase in plain text, e.g. "working on (2/6): running parallel review lanes".
- When review lanes finish, immediately move to "working on (3/6): synthesizing findings".
- When synthesis is done, move to the posting phase before completion when external-review comments are applicable.
- When posting is done, explicitly state "Vette complete" with counts: suggestions, repairs, comments prepared, comments posted, and untestable items grouped.
- Do not leave the final phase in progress after returning the final report. End with "status: idle — vette complete".`;

	if (ctx.isOwner) {
		return `Run /vette owner repair mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\n${visibleStatusContract}\n\nMandatory behavior:\n- Local non-merge commit evidence indicates this PR branch is owned here, so do NOT draft or post PR review comments for findings.\n- Use evidence-first vette/pr-review techniques to find confirmed, user-impacting defects, weak tests, merge conflicts, failed checks, and review/bot comments that require action.\n- For each confirmed related finding, repair it through strict TDD: red test, red verification, green implementation, reviewer/verifier, refactor gate.\n- Spawn focused subagents according to the contract below for every non-trivial failure/finding.\n- Verify locally with focused commands, then broader checks when appropriate.\n- Commit and push focused fixes when verification passes and the repository state is safe.\n- If a finding is real but out of scope, document it in the final report instead of bloating this PR.\n- If the worktree was dirty before this command, protect pre-existing changes and report how they were handled before any repair action.\n\nUse these existing skills/instructions by prompt routing as relevant: vette, pr-review, tdd, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${subagentContract()}\n\nFinish with PR URL, fixes made, commits pushed, findings artifact path, exact verification commands/results, and any blockers.\n\nComment policy: owner PR mode must not draft or post PR review comments.`;
	}

	return `Run /vette external PR review mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\n${visibleStatusContract}\n\nMandatory behavior:\n- Local non-merge commit evidence does not show this PR branch is owned here, so perform an evidence-backed PR review/comment workflow.\n- Review source branch against base branch using merge-base diff, PR title/body, linked requirements, changed files, contracts, and tests.\n- Run vette risk lanes only for changed behavior; do not expand into a whole-repo audit unless necessary for evidence.\n- Verify every actionable finding locally through static proof, focused command, or a temporary failing test. Clean up temporary artifacts.\n- Before finalizing comments, look for findings that can be reproduced with focused unit/regression tests; build those tests, run them, and verify they fail for the expected reason.
- Prepare GitHub review comments that follow the repo comment contract: exact file/line when available, user impact, local evidence, fix boundary, and suggested tests when appropriate. For test-reproducible findings, include the exact failing test code in the associated comment body.
- After all verification and cleanup is complete, post verified comments in one posting pass. Prefer file/line comments, fall back to file-level comments when line placement is not possible, and fall back to a general PR comment when the file is not a good comment target.
- Build and post one singular final PR comment for verified-but-untestable findings, including file/line information for every item where possible.
- Post only findings that passed the verification gate; reject or report unverified suggestions without posting them.\n- ${commentPolicy}\n- Do not implement repairs on someone else's PR unless the user explicitly asks after seeing the review.\n\nUse these existing skills/instructions by prompt routing as relevant: pr-review, vette, naming, test-name, and thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${reviewCommentTestContract()}\n\n${reviewCommentPostingContract()}\n\n${reviewCommentTemplateContract()}\n\nFinish with review disposition, commands/results, findings artifact path, comments prepared and posted, rejected findings, untestable-items comment URL/status, and cleanup status.`;
}

function scopeVettePrompt(ctx: ScopeVetteContext, rawArgs: string): string {
	return `Run /vette scope bug-discovery mode. This is not a PR review: audit the requested service/module/scope, validate likely bugs, build focused repro tests where practical, and draft local bug tickets only.\n\n${scopeVetteSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\nVisible status requirements:\n- Maintain an explicit status/todo sequence and update it immediately as phases change:\n  1. Resolve and map target scope\n  2. Run parallel risk lanes\n  3. Synthesize candidate bugs\n  4. Verify candidates with evidence and repro tests where practical\n  5. Write local bug-ticket drafts\n  6. Complete\n- While active, state the current phase in plain text, e.g. "working on (2/6): running parallel risk lanes".\n- End with "status: idle — scope vette complete" and counts for candidates, verified bugs, bug drafts written, rejected items, blocked items, and test-backed drafts.\n\nMandatory behavior:\n- Treat ${ctx.target} as the audit boundary. It may be a full service, module, package, directory, route group, job, or subsystem. First identify its entry points, dependencies, data stores, side effects, tests, and owner-facing behavior.\n- Run read-only risk lanes in parallel before deciding what deserves verification: vette risk review, naming/test-name check, and thermo-nuclear-code-quality-review. For broad service scopes, add focused lanes for API/contract boundaries, data consistency, async/job behavior, error handling, and observability where relevant.\n- Promote only verified, user-impacting defects to bug-ticket drafts. Verification can be static proof, a focused command, a runtime observation, or a temporary focused failing test.\n- For each candidate where a focused unit/regression/integration test is practical, build the smallest repro test, run the focused command, and prove it fails for the expected reason. Clean up temporary test files unless the user explicitly asks to keep them, but preserve exact test code and failing output in the draft.\n- Do not edit production code or implement fixes in scope mode unless the user explicitly asks after reading the drafts.\n- Do not create GitHub issues, Linear tickets, PR comments, or commits. Write local Markdown drafts only.\n\nUse these existing skills/instructions by prompt routing as relevant: vette, tdd, pr-review, naming, test-name, and thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContractForPath(ctx.findingsPath)}\n\n${bugDraftContract(ctx)}\n\n${subagentContract()}\n\nFinish with target scope, drafts directory, findings artifact path, verification commands/results, repro test summary, draft filenames, rejected findings, blocked findings, and cleanup status.`;
}

function prPrompt(
	ctx: PrContext,
	rawArgs: string,
	options: { wantsPosting: boolean; wantsWatch: boolean },
): string {
	return `Run /pr preparation, vette, repair, and monitoring mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /pr args: ${rawArgs || "<none>"}\n\nVisible status and timing requirements:\n- Check immediately, then use a 15-minute cadence while watching.\n- Before every wait, state the current PR status, what was checked, whether you are working or idle, progress like "working on (1/1)", and the next check time.\n- On every watch check, inspect the PR lifecycle with \`gh pr view ${ctx.pr.number} --json state,mergedAt,mergeStateStatus\`. If \`state\` is \`MERGED\` or \`mergedAt\` is present, close down the watch item immediately: do not run more checks, post comments, repair code, or schedule another wait. End with exactly "status: merged — PR #${ctx.pr.number} is merged; watch closed".\n- When no actionable issue/comment/check failure is present, state "idle until <time>" instead of spawning agents.\n- When a new actionable issue appears, state "working on (n/total)" and only then spin up the focused code agent for that issue.\n\nObjectives:\n1. Resolve and validate the integration base/target branch. Prefer the PR base branch already shown above; verify it exists remotely before diffing or updating.\n2. Inspect repository PR rules and standards: .github/pull_request_template.md, contributing docs, branch policy, conventional title style, required body sections, and target-branch expectations.\n3. Analyze the current PR title/body against the template and rules. Plan exact updates needed; apply safe title/body fixes when appropriate.\n4. Run the same PR-aware /vette behavior internally:\n   - Owner PR: no comments; find and fix confirmed issues through TDD-focused subagents.\n   - External PR: evidence-backed review comments are posted automatically after all verification is complete. At the end of synthesis, create focused unit/regression repro tests for comment-worthy findings where practical, verify those tests fail for the expected reason, include the exact test code in the templated associated comment body, then post verified items in one pass using file/line comments when possible, file-level comments when line placement is not possible, and general PR comments as the fallback. Build one singular templated final comment for verified-but-untestable items with file/line context whenever possible.\n5. Detect merge conflicts and resolve related conflicts through a focused merge-conflict resolver agent.\n6. Inspect CI with \`gh pr checks\` as the source of truth. For failed checks, classify related/unrelated/uncertain. Treat uncertain as related until proven otherwise.\n7. Fix related failures with focused code/TDD subagents. For unrelated flaky/infrastructure failures, retry once when safe, document evidence, and avoid bloating this PR.\n8. Inspect PR comments, reviews, BugBot/bot alerts, and new commits. Spin up code/fix agents only when a new actionable issue/comment/check failure appears.\n9. ${options.wantsWatch ? "Keep watching until the PR is merged, checks are green and actionable comments are resolved, or until blocked by a product/architecture decision. A merged PR is terminal: close the babysit item, report the merged state, and do not schedule another check. The watch cadence is 15 minutes between checks unless a GitHub command returns a live pending state sooner." : "Do not enter a long watch loop because --no-watch was provided; perform one full pass and report next steps."}\n\nUse these existing skills/instructions by prompt routing as relevant: pull-request, vette, pr-review, tdd, babysitting-pull-requests, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${reviewCommentPostingContract()}\n\n${reviewCommentTemplateContract()}\n\n${subagentContract()}\n\nSafety rules:
- Report dirty worktree state before repair actions and protect pre-existing changes.\n- For external PR review findings, post only verified comments automatically; unverified suggestions must be rejected or reported without posting. Current posting flag: ${options.wantsPosting ? "explicitly allowed but not required" : "not required for verified findings"}.\n- Never force push.\n- Do not bypass hooks or required checks.\n- Do not create durable watch-loop helper scripts; keep monitoring as agent/process discipline.\n\nFinish with PR URL, title/body/base validation result, findings artifact path, vette findings or repairs, CI/comment status, commits pushed, exact commands/results, and remaining blockers.`;
}

function draftPrPrompt(
	ctx: DraftPrContext,
	resolveError: string,
	rawArgs: string,
	options: { wantsPosting: boolean; wantsWatch: boolean },
): string {
	return `Run /pr creation, vette, repair, and monitoring mode for this branch. No existing pull request was resolved, so the first workflow is to vette this branch, create the pull request, then watch it.\n\n${draftPrSummary(ctx, resolveError)}\n\nOriginal /pr args: ${rawArgs || "<none>"}\n\nVisible status and timing requirements:\n- First state "working on (1/3): vetting branch before PR creation".\n- After pre-PR verification passes, state "working on (2/3): creating pull request" and create the PR.\n- After the PR exists, state "working on (3/3): monitoring PR" and use the created PR URL/number for all PR-aware checks.\n- Check immediately, then use a 15-minute cadence while watching.
- Before every wait, state the current PR status, what was checked, whether you are working or idle, and the next check time.
- After the PR exists, every watch check must inspect the PR lifecycle with \`gh pr view <created-pr-number-or-url> --json state,mergedAt,mergeStateStatus\`. If \`state\` is \`MERGED\` or \`mergedAt\` is present, close down the watch item immediately: do not run more checks, post comments, repair code, or schedule another wait. End with exactly "status: merged — PR #<number> is merged; watch closed".\n\nObjectives:\n1. Validate the working branch and base. Use current branch ${ctx.branch} as the PR head. Prefer ${ctx.baseBranch} as the base, but verify the remote base exists and adjust only when repository policy clearly requires a different base.\n2. Protect pre-existing dirty worktree changes. Report them before repair actions and avoid overwriting unrelated user changes.\n3. Before creating the PR, run the same owner-side /vette behavior internally against the branch diff from the base: run parallel vette, name-check, and thermo-nuclear lanes; verify every confirmed issue; repair confirmed defects through TDD-focused subagents; and run focused verification.\n4. Inspect repository PR rules and standards: .github/pull_request_template.md, contributing docs, branch policy, conventional title style, required body sections, and target-branch expectations.\n5. Prepare a concise PR title and body that satisfy the template and accurately summarize the vetted changes.\n6. Push the branch when needed, then create the pull request with \`gh pr create\` targeting the validated base. Do not require the user to provide a branch, PR number, or URL.\n7. After PR creation, capture the PR URL/number and continue with the normal /pr behavior: validate title/body/base, inspect merge conflicts, inspect CI with \`gh pr checks\`, monitor comments/reviews/BugBot/bot alerts/new commits, and fix related failures with focused TDD/code subagents.\n8. ${options.wantsWatch ? "Keep watching until the PR is merged, checks are green and actionable comments are resolved, or until blocked by a product/architecture decision. A merged PR is terminal: close the babysit item, report the merged state, and do not schedule another check. The watch cadence is 15 minutes between checks unless a GitHub command returns a live pending state sooner." : "Do not enter a long watch loop because --no-watch was provided; perform one full pass through PR creation and initial validation, then report next steps."}\n\nUse these existing skills/instructions by prompt routing as relevant: vette, pr-review, tdd, babysitting-pull-requests, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${draftFindingsArtifactContract(ctx)}\n\n${subagentContract()}\n\nSafety rules:\n- Never force push.\n- Do not bypass hooks or required checks.\n- Do not create durable watch-loop helper scripts; keep monitoring as agent/process discipline.\n- Verified external-review posting rules only apply after a PR exists. Current posting flag: ${options.wantsPosting ? "explicitly allowed but not required" : "not required for verified findings"}.\n\nFinish with PR URL, title/body/base validation result, findings artifact path, vette findings or repairs, CI/comment status, commits pushed, exact commands/results, and remaining blockers.`;
}

async function dispatchVettePrompt(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	onResolved?: (
		vetteCommandContext: VetteCommandContext,
		parsed: ReturnType<typeof parseArgs>,
		options: { queued: boolean },
	) => void,
): Promise<void> {
	const parsed = parseArgs(args);
	let vetteCommandContext: VetteCommandContext;
	try {
		vetteCommandContext = await resolveVetteCommandContext(parsed, ctx.cwd);
	} catch (error) {
		ctx.ui.notify("/vette failed to prepare context", "error");
		throw error;
	}

	const prompt =
		vetteCommandContext.kind === "pr"
			? vettePrompt(vetteCommandContext.prContext, parsed.raw, {
					wantsPosting: parsed.wantsPosting,
				})
			: scopeVettePrompt(vetteCommandContext.scopeContext, parsed.raw);
	const queued = !ctx.isIdle();
	onResolved?.(vetteCommandContext, parsed, { queued });

	if (vetteCommandContext.kind === "pr") {
		const prContext = vetteCommandContext.prContext;
		ctx.ui.notify(
			`/vette: PR #${prContext.pr.number} (${prContext.isOwner ? "owner repair" : "external review"})`,
			"info",
		);
	} else {
		ctx.ui.notify(
			`/vette: scope ${vetteCommandContext.scopeContext.target}`,
			"info",
		);
	}

	if (!queued) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify("/vette queued as follow-up", "info");
	}
}

async function resolveVetteBetaTarget(
	targetArg: string | undefined,
	cwd: string,
): Promise<VetteBetaReviewTarget | undefined> {
	const selector = !targetArg || targetArg === "now" ? "" : targetArg;
	try {
		const prContext = await resolvePrContext(selector, cwd);
		return {
			label: `PR #${prContext.pr.number}`,
			...(prContext.pr.headRefName
				? { headRef: prContext.pr.headRefName }
				: {}),
			...(prContext.pr.baseRefName
				? { baseRef: `origin/${prContext.pr.baseRefName}` }
				: {}),
			...(prContext.pr.title ? { title: prContext.pr.title } : {}),
			...(prContext.pr.body ? { body: prContext.pr.body } : {}),
			reviewMode: prContext.isOwner ? "repair" : "comment",
			prNumber: prContext.pr.number,
			prUrl: prContext.pr.url,
		};
	} catch {
		if (!selector) return undefined;
		const baseBranch = await getDefaultBaseBranch(cwd);
		return {
			label: `branch ${selector}`,
			headRef: selector,
			baseRef: `origin/${baseBranch}`,
		};
	}
}

async function dispatchVetteBetaPrompt(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	options: {
		cooldown: VetteBetaCooldown;
		onStatus?: (status: VetteBetaStatusContext) => void;
	},
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const firstToken = tokens[0]?.toLowerCase();
	const action =
		firstToken === "beta" ? (tokens[1] ?? "now") : (tokens[0] ?? "now");
	const isSelfReview = action === "self";
	const config = await loadVetteBetaConfig();
	if (action === "models") {
		ctx.ui.notify(
			formatResolvedModelPool({
				config,
				modelRegistry: (ctx as unknown as { modelRegistry?: unknown })
					.modelRegistry as
					| undefined
					| Parameters<typeof formatResolvedModelPool>[0]["modelRegistry"],
			}),
			"info",
		);
		return;
	}
	const target = isSelfReview
		? undefined
		: await resolveVetteBetaTarget(action, ctx.cwd);
	const reviewMode: VetteBetaReviewMode = isSelfReview
		? "repair"
		: (target?.reviewMode ?? "comment");
	const resolvedPool = resolveModelPool({
		config,
		modelRegistry: (ctx as unknown as { modelRegistry?: unknown })
			.modelRegistry as
			| undefined
			| Parameters<typeof resolveModelPool>[0]["modelRegistry"],
	});
	const firstLaunchModel =
		resolvedPool.entries.find((entry) => entry.availability !== "missing") ??
		resolvedPool.entries[0];
	const modelSummary = firstLaunchModel
		? `${formatModelConnection(firstLaunchModel.model)} from pool '${resolvedPool.poolName}'`
		: `pool '${resolvedPool.poolName}' has no usable models`;
	const targetLabel =
		target?.label ??
		(isSelfReview ? "current branch self-review" : "current worktree");
	const queued = !ctx.isIdle();
	options.onStatus?.({
		targetLabel,
		reviewMode,
		queued,
	});

	ctx.ui.notify(
		`/vette: building diff bundle for ${targetLabel}; launching lightweight topic agents with ${modelSummary}; mode=${reviewMode}`,
		"info",
	);

	type TopicState = {
		label: string;
		status: "pending" | "running" | "done" | "failed";
		findings: number;
		startedAt?: number;
		durationMs?: number;
		inputTokens?: number;
		outputTokens?: number;
		model?: string;
		avgMs?: number;
	};
	let phase: "bundle" | "topics" | "done" = "bundle";
	const phaseStartedAt = Date.now();
	const topicStates = new Map<string, TopicState>();
	const timings = await loadTopicTimings();
	for (const topic of VETTE_BETA_TOPICS) {
		const avgMs = averageTopicDuration(timings, topic.id);
		topicStates.set(topic.id, {
			label: topic.label,
			status: "pending",
			findings: 0,
			...(avgMs > 0 ? { avgMs } : {}),
		});
	}

	function fmtMs(ms: number): string {
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function fmtTokens(input?: number, output?: number): string {
		if (input === undefined && output === undefined) return "";
		return `${input?.toLocaleString() ?? "?"}in/${output?.toLocaleString() ?? "?"}out`;
	}

	function renderProgressWidget(): string[] {
		const now = Date.now();
		const elapsed = fmtMs(now - phaseStartedAt);
		const lines: string[] = [];

		if (phase === "bundle") {
			lines.push(`  ○ Building diff bundle... ${elapsed}`);
			return lines;
		}

		let doneCount = 0;
		let runningCount = 0;
		let totalFindings = 0;
		for (const state of topicStates.values()) {
			if (state.status === "done" || state.status === "failed") doneCount++;
			if (state.status === "running") runningCount++;
			totalFindings += state.findings;
		}
		const bar = progressBar(doneCount, topicStates.size);
		lines.push(
			`  ${bar}  ${doneCount}/${topicStates.size} topics  ${totalFindings} finding${totalFindings === 1 ? "" : "s"}  ${elapsed}`,
		);
		if (runningCount > 0) {
			lines.push(`  ${runningCount} running`);
		}
		lines.push("");
		for (const state of topicStates.values()) {
			let icon: string;
			let detail = "";
			switch (state.status) {
				case "done":
					icon = "\u2713";
					break;
				case "failed":
					icon = "\u2717";
					break;
				case "running":
					icon = "\u25B8";
					break;
				default:
					icon = "\u2219";
					break;
			}
			if (state.status === "done" || state.status === "failed") {
				const parts: string[] = [];
				if (state.findings > 0) parts.push(`${state.findings} found`);
				if (state.durationMs !== undefined) parts.push(fmtMs(state.durationMs));
				const tok = fmtTokens(state.inputTokens, state.outputTokens);
				if (tok) parts.push(tok);
				if (parts.length > 0) detail = ` (${parts.join(", ")})`;
			} else if (state.status === "running" && state.startedAt) {
				detail = ` ${fmtMs(now - state.startedAt)}`;
			} else if (state.avgMs) {
				detail = ` ~${fmtMs(state.avgMs)}`;
			}
			lines.push(`  ${icon} ${state.label}${detail}`);
		}
		return lines;
	}

	function refreshWidget(): void {
		ctx.ui.setWidget("vette-progress", renderProgressWidget(), {
			placement: "aboveEditor",
		});
	}

	refreshWidget();
	const widgetTimer = setInterval(refreshWidget, 2_000);

	let result: Awaited<ReturnType<typeof runVetteBetaReview>>;
	try {
		result = await runVetteBetaReview({
			ctx,
			pi,
			config,
			cooldown: options.cooldown,
			reviewMode,
			...(target ? { target } : {}),
			onBundleReady: () => {
				phase = "topics";
				refreshWidget();
			},
			onTopicStart: (info) => {
				const existing = topicStates.get(info.topic.id);
				if (existing && existing.status === "pending") {
					existing.status = "running";
					existing.startedAt = Date.now();
				}
				refreshWidget();
			},
			onTopicComplete: (info) => {
				topicStates.set(info.topic.id, {
					label: info.topic.label,
					status: info.ok ? "done" : "failed",
					findings: info.findingsCount,
					durationMs: info.durationMs,
					inputTokens: info.inputTokens,
					outputTokens: info.outputTokens,
					model: info.model,
				});
				refreshWidget();
				options.onStatus?.({
					targetLabel,
					reviewMode,
					queued: false,
					progress: `${info.completed}/${info.total}`,
				});
			},
		});
	} finally {
		clearInterval(widgetTimer);
	}

	phase = "done";
	options.onStatus?.({
		targetLabel,
		reviewMode,
		queued: false,
		progress: `${result.results.length}/${VETTE_BETA_TOPICS.length}`,
	});
	ctx.ui.setWidget("vette-progress", undefined);

	const allFailed = result.results.every((r) => !r.ok);
	if (allFailed) {
		const attemptSummary = result.results
			.slice(0, 3)
			.map((r) => {
				const lastAttempt = r.attempts[r.attempts.length - 1];
				return `${r.topic.label}: ${r.errorMessage ?? lastAttempt?.errorMessage ?? "unknown"}`;
			})
			.join("; ");
		ctx.ui.notify(
			`/vette failed: no working model found. ${attemptSummary}`,
			"error",
		);
		return;
	}

	const synthesisPrompt = formatVetteBetaSynthesisPrompt(result);

	let totalIn = 0;
	let totalOut = 0;
	let totalFindings = 0;
	const rows: Array<{
		icon: string;
		label: string;
		findings: string;
		duration: string;
		tokens: string;
		model: string;
	}> = [];
	for (const state of topicStates.values()) {
		totalIn += state.inputTokens ?? 0;
		totalOut += state.outputTokens ?? 0;
		totalFindings += state.findings;
		rows.push({
			icon: state.status === "done" ? "\u2713" : "\u2717",
			label: state.label,
			findings: state.findings > 0 ? String(state.findings) : "-",
			duration: state.durationMs !== undefined ? fmtMs(state.durationMs) : "-",
			tokens: fmtTokens(state.inputTokens, state.outputTokens) || "-",
			model: state.model ?? "-",
		});
	}
	const colW = {
		label: Math.max("Topic".length, ...rows.map((r) => r.label.length)),
		findings: Math.max("Finds".length, ...rows.map((r) => r.findings.length)),
		duration: Math.max("Time".length, ...rows.map((r) => r.duration.length)),
		tokens: Math.max("Tokens".length, ...rows.map((r) => r.tokens.length)),
		model: Math.max("Model".length, ...rows.map((r) => r.model.length)),
	};
	const pad = (s: string, w: number) => s.padEnd(w);
	const rpad = (s: string, w: number) => s.padStart(w);
	const summaryLines: string[] = [
		`/vette complete in ${fmtMs(result.durationMs)}`,
		"",
		`    ${pad("Topic", colW.label)}  ${rpad("Finds", colW.findings)}  ${rpad("Time", colW.duration)}  ${pad("Tokens", colW.tokens)}  Model`,
		`    ${"\u2500".repeat(colW.label)}  ${"\u2500".repeat(colW.findings)}  ${"\u2500".repeat(colW.duration)}  ${"\u2500".repeat(colW.tokens)}  ${"\u2500".repeat(colW.model)}`,
	];
	for (const row of rows) {
		summaryLines.push(
			`  ${row.icon} ${pad(row.label, colW.label)}  ${rpad(row.findings, colW.findings)}  ${rpad(row.duration, colW.duration)}  ${pad(row.tokens, colW.tokens)}  ${row.model}`,
		);
	}
	summaryLines.push(
		`    ${"\u2500".repeat(colW.label)}  ${"\u2500".repeat(colW.findings)}  ${"\u2500".repeat(colW.duration)}  ${"\u2500".repeat(colW.tokens)}  ${"\u2500".repeat(colW.model)}`,
	);
	summaryLines.push(
		`    ${pad("Total", colW.label)}  ${rpad(String(totalFindings), colW.findings)}  ${rpad(fmtMs(result.durationMs), colW.duration)}  ${pad(fmtTokens(totalIn, totalOut), colW.tokens)}`,
	);
	ctx.ui.notify(summaryLines.join("\n"), "info");
	if (queued) {
		pi.sendUserMessage(synthesisPrompt, { deliverAs: "followUp" });
	} else {
		pi.sendUserMessage(synthesisPrompt);
	}
}

async function dispatchPrPrompt(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	onResolved?: (
		prCommandContext: PrCommandContext,
		parsed: ReturnType<typeof parseArgs>,
		options: { queued: boolean },
	) => void,
): Promise<void> {
	const parsed = parseArgs(args);
	let prCommandContext: PrCommandContext;
	try {
		prCommandContext = await resolvePrCommandContext(parsed.selector, ctx.cwd);
	} catch (error) {
		ctx.ui.notify("/pr failed to prepare PR context", "error");
		throw error;
	}

	const queued = !ctx.isIdle();
	onResolved?.(prCommandContext, parsed, { queued });

	if (
		prCommandContext.kind === "existing" &&
		isMergedPullRequest(prCommandContext.prContext.pr)
	) {
		ctx.ui.notify(
			`/pr: PR #${prCommandContext.prContext.pr.number} is already merged; watch closed`,
			"info",
		);
		return;
	}

	const prompt =
		prCommandContext.kind === "existing"
			? prPrompt(prCommandContext.prContext, parsed.raw, {
					wantsPosting: parsed.wantsPosting,
					wantsWatch: parsed.wantsWatch,
				})
			: draftPrPrompt(
					prCommandContext.draftContext,
					prCommandContext.resolveError,
					parsed.raw,
					{
						wantsPosting: parsed.wantsPosting,
						wantsWatch: parsed.wantsWatch,
					},
				);

	if (prCommandContext.kind === "existing") {
		ctx.ui.notify(
			`/pr: PR #${prCommandContext.prContext.pr.number} (prepare/watch)`,
			"info",
		);
	} else {
		ctx.ui.notify(
			`/pr: creating PR from ${prCommandContext.draftContext.branch}`,
			"info",
		);
	}

	if (!queued) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify("/pr queued as follow-up", "info");
	}
}

function textFromMessage(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const maybeText = (block as { text?: unknown }).text;
			return typeof maybeText === "string" ? maybeText : "";
		})
		.join("\n");
}

function agentReportedMerged(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const messages = (event as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return false;
	let lastAssistant: unknown;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			message &&
			typeof message === "object" &&
			(message as { role?: unknown }).role === "assistant"
		) {
			lastAssistant = message;
			break;
		}
	}
	return /status:\s*merged\b/i.test(textFromMessage(lastAssistant));
}

function progressBar(completed: number, total: number, width = 20): string {
	const filled = total > 0 ? Math.round((completed / total) * width) : 0;
	const empty = width - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function formatCountdown(nextCheckAt: number, now = Date.now()): string {
	const remainingMs = Math.max(0, nextCheckAt - now);
	const minutes = Math.floor(remainingMs / 60_000);
	const seconds = Math.floor((remainingMs % 60_000) / 1000);
	return minutes > 0 ? `${minutes}m` : `${seconds}s`;
}

function renderStatus(status: CommandStatus): string {
	if (status.phase === "merged")
		return `/${status.command} ${status.target} merged`;
	const base = `/${status.command} ${status.target} ${status.phase} (${status.progress})`;
	const mode = ` ${status.mode}`;
	const next = status.nextCheckAt
		? ` next ${formatCountdown(status.nextCheckAt)}`
		: "";
	return `${base}${mode}${next}`;
}

export function buildVetteBetaCommandStatus(
	statusContext: VetteBetaStatusContext,
): CommandStatus {
	return {
		command: "vette",
		target: statusContext.targetLabel,
		mode:
			statusContext.reviewMode === "repair"
				? "owned/self repair"
				: "external/comment review",
		phase: statusContext.queued ? "queued" : "working",
		progress: statusContext.progress ?? `0/${VETTE_BETA_TOPICS.length}`,
	};
}

function buildVetteCommandStatus(
	vetteCommandContext: VetteCommandContext,
	options: { queued: boolean },
): CommandStatus {
	if (vetteCommandContext.kind === "pr") {
		return {
			command: "vette",
			target: `PR #${vetteCommandContext.prContext.pr.number}`,
			mode: vetteCommandContext.prContext.isOwner
				? "owner repair"
				: "external review",
			phase: options.queued ? "queued" : "working",
			progress: "1/1",
		};
	}
	return {
		command: "vette",
		target: `scope ${vetteCommandContext.scopeContext.target}`,
		mode: "bug drafts",
		phase: options.queued ? "queued" : "working",
		progress: "1/6",
	};
}

function buildPrCommandStatus(
	prCommandContext: PrCommandContext,
	parsed: ReturnType<typeof parseArgs>,
	options: { queued: boolean },
): CommandStatus {
	if (prCommandContext.kind === "draft") {
		return {
			command: "pr",
			target: `branch ${prCommandContext.draftContext.branch}`,
			mode: "create/watch",
			phase: options.queued ? "queued" : "working",
			progress: "1/3",
			nextCheckAt: parsed.wantsWatch ? Date.now() + 15 * 60_000 : undefined,
		};
	}

	const isMerged = isMergedPullRequest(prCommandContext.prContext.pr);
	let phase: CommandStatus["phase"] = "working";
	if (isMerged) {
		phase = "merged";
	} else if (options.queued) {
		phase = "queued";
	}
	return {
		command: "pr",
		target: `PR #${prCommandContext.prContext.pr.number}`,
		mode: isMerged ? "merged" : "prepare/watch",
		phase,
		progress: isMerged ? "0/0" : "1/1",
		nextCheckAt:
			parsed.wantsWatch && !isMerged ? Date.now() + 15 * 60_000 : undefined,
	};
}

// fallow-ignore-next-line unused-export -- Pi extension entrypoint loaded from package.json
export default function (pi: ExtensionAPI) {
	let currentStatus: CommandStatus | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	const vetteBetaCooldown = new VetteBetaCooldown();

	function stopStatusTimer(): void {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
	}

	function publishStatus(ctx: Pick<ExtensionCommandContext, "ui">): void {
		ctx.ui.setStatus(
			"pr-vette",
			currentStatus ? renderStatus(currentStatus) : "pr/vette idle",
		);
	}

	function safePublishStatus(ctx: Pick<ExtensionCommandContext, "ui">): void {
		try {
			publishStatus(ctx);
		} catch {
			stopStatusTimer();
		}
	}

	function setVetteCommandStatus(
		ctx: ExtensionCommandContext,
		vetteCommandContext: VetteCommandContext,
		options: { queued: boolean },
	): void {
		currentStatus = buildVetteCommandStatus(vetteCommandContext, options);
		safePublishStatus(ctx);
	}

	function setVetteBetaCommandStatus(
		ctx: ExtensionCommandContext,
		statusContext: VetteBetaStatusContext,
	): void {
		currentStatus = buildVetteBetaCommandStatus(statusContext);
		safePublishStatus(ctx);
	}

	function setPrCommandStatus(
		ctx: ExtensionCommandContext,
		prCommandContext: PrCommandContext,
		parsed: ReturnType<typeof parseArgs>,
		options: { queued: boolean },
	): void {
		currentStatus = buildPrCommandStatus(prCommandContext, parsed, options);
		safePublishStatus(ctx);
	}

	pi.on("agent_start", (_event, ctx) => {
		if (currentStatus && currentStatus.phase === "queued")
			currentStatus.phase = "working";
		if (currentStatus) safePublishStatus(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		if (currentStatus) {
			if (
				currentStatus.command === "pr" &&
				currentStatus.phase !== "idle" &&
				agentReportedMerged(event)
			) {
				currentStatus.phase = "merged";
				currentStatus.mode = "merged";
			} else if (currentStatus.phase !== "merged") {
				currentStatus.phase = "idle";
			}
			currentStatus.progress = "0/0";
			currentStatus.nextCheckAt = undefined;
		}
		safePublishStatus(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		stopStatusTimer();
		safePublishStatus(ctx);
		statusTimer = setInterval(() => safePublishStatus(ctx), 30_000);
	});

	pi.on("session_shutdown", () => {
		stopStatusTimer();
	});

	pi.registerCommand("vette", {
		description:
			"Run lightweight beta diff agents by default. Use /vette old for the legacy PR/scope workflow.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = tokens[0]?.toLowerCase();
			if (subcommand === "old") {
				await dispatchVettePrompt(
					pi,
					tokens.slice(1).join(" "),
					ctx,
					(vetteCommandContext, _parsed, options) =>
						setVetteCommandStatus(ctx, vetteCommandContext, options),
				);
				return;
			}
			await dispatchVetteBetaPrompt(pi, args, ctx, {
				cooldown: vetteBetaCooldown,
				onStatus: (statusContext) =>
					setVetteBetaCommandStatus(ctx, statusContext),
			});
		},
	});

	pi.registerCommand("pr", {
		description:
			"Vette the current branch, create a pull request when needed, then monitor it until merged, green, or blocked.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await dispatchPrPrompt(
				pi,
				args,
				ctx,
				(prCommandContext, parsed, options) =>
					setPrCommandStatus(ctx, prCommandContext, parsed, options),
			);
		},
	});
}
