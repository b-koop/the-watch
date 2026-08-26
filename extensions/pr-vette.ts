import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	VETTE_BETA_TOPICS,
	VetteBetaCooldown,
	VetteBetaDiffError,
	averageTopicDuration,
	buildVetteCompareConfig,
	formatResolvedModelPool,
	formatVetteCompareModels,
	forceLocalVetteBetaConfig,
	formatVetteBetaSynthesisPrompt,
	listVetteCompareLocalModels,
	listVetteCompareRemoteModels,
	loadTopicTimings,
	loadVetteBetaConfig,
	resolveModelPool,
	runVetteBetaReview,
	type VetteBetaReviewMode,
	type VetteBetaReviewTarget,
} from "./vette-beta.ts";
import {
	formatVetteCompareReport,
	formatVetteCompareSummary,
	parseVetteCompareArgs,
	runVetteBetaCompare,
	vetteCompareArtifactPath,
	writeVetteCompareArtifact,
} from "./vette-compare.ts";
import {
	formatVetteReviewPrompt,
	loadVetteReviewSections,
} from "./vette-review.ts";
import { discoverReviewers } from "./vette-reviewers.ts";
import { resolveBaseBranch, type ResolvedBaseBranch } from "./base-branch.ts";

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
	baseRef: string;
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
	baseRef: string;
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
	topicLabels?: string;
};

type CommandStatus = {
	command: "vette" | "pr";
	target: string;
	mode: string;
	phase: "working" | "queued" | "idle" | "blocked" | "merged";
	progress: string;
	topicLabels?: string;
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

export function shouldSuppressVetteBetaPosting(args: string): boolean {
	const flags = new Set(args.trim().split(/\s+/).filter(Boolean));
	return flags.has("--no-post") || flags.has("--dry-run");
}

export function resolveVetteReviewMode(input: {
	targetMode?: VetteBetaReviewMode;
	isSelfReview?: boolean;
	isDraftReview?: boolean;
	commentsOnly?: boolean;
}): VetteBetaReviewMode {
	if (input.commentsOnly && input.isSelfReview) {
		throw new Error("--comments-only cannot be combined with /vette self");
	}
	if (input.commentsOnly) return "comment";
	if (input.isSelfReview) return "repair";
	if (input.isDraftReview) return "comment";
	return input.targetMode ?? "comment";
}

function parseArgs(args: string): {
	selector: string;
	scopeTarget: string;
	wantsPosting: boolean;
	wantsScope: boolean;
	wantsWatch: boolean;
	noPost: boolean;
	forceLocal: boolean;
	commentsOnly: boolean;
	raw: string;
} {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const flags = new Set(tokens.filter((token) => token.startsWith("--")));
	const positional = tokens.filter((token) => !token.startsWith("--"));
	const selector = positional[0] ?? "";
	const wantsScope = flags.has("--scope") || flags.has("--service");
	const noPost = flags.has("--no-post") || flags.has("--dry-run");
	const forceLocal = flags.has("--local") || flags.has("--force-local");
	const commentsOnly = flags.has("--comments-only");
	return {
		selector,
		scopeTarget: positional.join(" ") || (wantsScope ? "." : ""),
		wantsPosting:
			!noPost &&
			(flags.has("--post-comments") ||
				flags.has("--post") ||
				flags.has("--submit-review")),
		wantsScope,
		wantsWatch: !flags.has("--no-watch"),
		noPost,
		forceLocal,
		commentsOnly,
		raw: args.trim(),
	};
}

export function parseVetteArgs(args: string): ReturnType<typeof parseArgs> {
	return parseArgs(args);
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

/**
 * Where this branch was actually cut from — `origin/dev`/`origin/develop`
 * before `origin/HEAD`, since a repo that defaults to `main` may still take
 * feature work onto an integration branch.
 */
async function resolveDefaultBase(
	cwd: string,
	headRef = "HEAD",
): Promise<ResolvedBaseBranch> {
	return resolveBaseBranch((args) => run("git", args, cwd), headRef);
}

async function getOriginRemoteUrl(cwd: string): Promise<string> {
	try {
		return await run("git", ["remote", "get-url", "origin"], cwd);
	} catch {
		return "<unavailable>";
	}
}

async function resolveDraftPrContext(cwd: string): Promise<DraftPrContext> {
	const [branch, base, identity, dirtyStatus, remoteUrl] = await Promise.all([
		getCurrentBranch(cwd),
		resolveDefaultBase(cwd),
		getLocalGitIdentity(cwd),
		getDirtyStatus(cwd),
		getOriginRemoteUrl(cwd),
	]);

	return {
		branch,
		baseBranch: base.branch,
		baseRef: base.ref,
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
	const [branch, base, dirtyStatus] = await Promise.all([
		getCurrentBranch(cwd),
		resolveDefaultBase(cwd),
		getDirtyStatus(cwd),
	]);
	const slug = slugifyBranch(target, "scope");
	const draftsDir = `/tmp/pi-vette-bug-drafts/${slug}`;
	return {
		target,
		branch,
		baseBranch: base.branch,
		baseRef: base.ref,
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
	// Name-only evidence is too weak to claim ownership (names collide easily);
	// without a configured local email, treat the branch as external.
	const isOwner = Boolean(
		localEmail &&
			input.commits.some((commit) => {
				if (
					(commit.parents?.length ?? 0) > 1 ||
					commit.message?.startsWith("Merge ")
				) {
					return false;
				}
				return commit.authorEmail?.trim().toLowerCase() === localEmail;
			}),
	);

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
	const slug = value
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[-.]+|[-.]+$/g, "");
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

function localModelContract(forceLocal: boolean): string {
	if (!forceLocal) return "";
	return `Local model mode (--local):
- Prefer local model execution for every spawned review, repair, investigation, or verification agent.
- When a command/tool supports smart-model-run local selection, pass its local-only option so it ranks local providers only.
- Use local providers such as ollama, lmstudio, or local, with fallback from stronger code/review models to smaller 7B/8B models when larger models are unavailable.
- Do not use remote/cloud model fallbacks unless the user explicitly authorizes leaving local mode.`;
}

/** The ref a PR actually merges into, or `origin/main` when GitHub is silent. */
function prBaseRef(pr: GhPullRequest): string {
	return pr.baseRefName ? `origin/${pr.baseRefName}` : "origin/main";
}

function fallowAuditContract(baseRef = "origin/main"): string {
	return `Required Fallow audit leg:
- Run \`pnpx fallow audit --base ${baseRef} --gate new-only\` after initial code/PR context is gathered and before final synthesis. If ${baseRef} is unavailable, use the PR/review base branch shown in the command context.
- Run the Fallow command once per vette pass. Fallow may exit with status 1 when it successfully found audit items. Treat exit 1 with usable findings/output as a completed audit result, not as a failed run; do not rerun it solely because the exit code is 1 or because advisory findings were reported. Only rerun or mark failed when the command produces no usable output or shows an execution/configuration error.
- Treat Fallow output as advisory candidates, not verified findings. Deduplicate it against other lanes and changed files.
- For every Fallow item considered useful, verify it with the same evidence gate as other findings before fixing, posting, or reporting it.
- For noisy, duplicate, pre-existing, or out-of-scope Fallow items, summarize why they were rejected so this run can evaluate whether the audit leg was useful.`;
}

function vetteBetaSectionsContract(): string {
	const sections = VETTE_BETA_TOPICS.map(
		(topic, index) => `${index + 1}. ${topic.label} (${topic.id})`,
	).join("\n");
	return `Current /vette command contract:
- Use the new /vette beta workflow, not /vette old or ad-hoc legacy lanes.
- Cover all ${VETTE_BETA_TOPICS.length} /vette sections before synthesis:
${sections}`;
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
- For every actionable finding, especially blockers, make a good-faith attempt to build the smallest temporary validating test or repro command that demonstrates the behavior.
- For each reproducible finding, build the smallest temporary test that demonstrates the behavior, run the focused test command, and verify it fails for the expected reason on the PR branch.
- If the focused test command fails after the exact-command retry, run one second dependency install attempt, then run the repository build/rebuild command, then rerun the focused test before preparing or posting any comments.
- Clean up temporary test files unless the user explicitly asked to commit tests; keep the exact test code and failing command output in the review evidence.
- If any focused, regression, or repro test is written, include its complete source in the associated JSON comment testCode field; include only the command and outcome in evidence. Never omit the test source or leave it only in a local file/evidence. The poster renders testCode as the Regression test section before posting.
- If a verified finding cannot be practically reproduced with a unit/regression test, classify it as untestable and preserve the best available evidence plus the reason no focused failing test is practical.`;
}

function reviewCommentPostingContract(): string {
	return `Review comment posting contract:
- Do not post comments while still gathering, testing, retry-installing, rebuilding, rerunning checks, or cleaning up evidence. After all verification and cleanup is complete, post the verified items in one posting pass.
- Every prepared or posted comment must start with exactly one scan label line before any details block or suggestion fence: \`🔴 **Blocker**\`, \`🟡 **Recommended**\`, or \`🔵 **Note**\`. Use Blocker for merge-blocking defects, Recommended for non-blocking fixes the author should strongly consider, and Note for contextual/low-risk observations.
- Every substantive verified issue comment must put the developer-facing finding in the \`<summary>\`: one plain sentence that says what breaks and why. Do not overload the summary with verification metadata, lane names, counts, model names, or command output.
- For each verified finding with a concrete file target, including verified-but-untestable findings, post the associated review comment at the most precise location available: prefer file + exact diff line; if no reliable line exists, use the file-level location when GitHub supports it; if the file is not a good/valid review-comment target, post it as a general PR comment with the file/line context in the body.
- For [name-check] test-name or identifier/variable naming suggestions and questions: post each substantive naming suggestion as a review comment anchored to the exact changed line in the diff. Use the minimal naming-suggestion comment style from the template contract: a GitHub \`\`\`suggest block with the full replacement line first, then brief reasoning. Do not attach or reference screenshots, clipboard paths, or local image paths for naming suggestions. These are not bundled into grouped untestable-items comments; they are per-line inline comments even when no repro test applies.
- Build a final grouped PR comment only for verified-but-untestable findings that cannot be anchored to a specific changed file or useful file-level target. Start it with a short non-scary sentence that states what kind of risk was found, then put each finding in its own \`<details>\` block with a one-sentence \`<summary>\` that names the broken behavior and why it matters.
- Post any grouped untestable-items comment at the end of the posting pass, after all line/file-specific verified comments have been posted.
- If GitHub rejects a line/file comment location, fall back to the next less-specific location and record that fallback in the final report.`;
}

export function reviewCommentTemplateContract(): string {
	return `Review comment templates (shared JSON contract):
- Synthesis must emit a JSON array; every item requires title, severity (blocker|recommended|note), codeSummary, what, and why. file and line are optional; line is a positive integer and requires file.
- evidence, testCode, and fixBoundary are optional. Whenever a focused or regression test is created, include its complete source in testCode; never leave test code only in evidence or the final report. Pass the complete array to \${CLAUDE_PLUGIN_ROOT}/scripts/post-vette-comments.ts; it validates before posting and renders the fixed section order: severity label, title details block, Code summary, What, Why, optional Evidence, optional Regression test, optional Fix boundary.
- Naming-only suggest comments remain the explicit exception.
- Use the templates below for posted comments. Keep headings and labels stable so the PR thread is scannable.
- Summary text must be one sentence, behavior-first, and plainly explain what was found and why it is a bug. Keep verification details inside the expanded panel.
- GitHub rendering rule: always leave one blank line after the closing \`</summary>\` tag before hidden Markdown content starts, especially before lists, headings, or fenced code blocks.
- Put long logs and repro/test code inside fenced code blocks within the expanded details body.
- For line/file-level test-reproduced findings, post one comment per finding with this body:

🔴 **Blocker** | 🟡 **Recommended** | 🔵 **Note**

<details>
  <summary>Verified issue: <one sentence stating what breaks and why></summary>

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
</details>

- For [name-check] test-name-only or identifier/variable naming comments, do not use the verified issue template above. Use this minimal body exactly:

🟡 **Recommended**

\`\`\`suggest
<full replacement changed line with the better test name, variable name, or identifier, preserving indentation and syntax>
\`\`\`

<brief reasoning for why the replacement better names the behavior>

- For general PR-comment fallbacks of test-reproduced findings, use the same \`<details>\` template and keep **Location** as the first expanded field with the best available file/line context.
- For file/line-level verified-but-untestable findings, post one comment per finding using the verified issue details template without the failing repro test section. Keep **Location** as the first expanded field and include **Why no focused test:** before **Fix boundary:**.
- For a final grouped verified-but-untestable PR comment covering only items that cannot be anchored to a specific changed file, use this body:

🔴 **Blocker** | 🟡 **Recommended** | 🔵 **Note**

Verified findings without focused repro tests: <one short sentence summarizing the shared risk without overstating severity>.

These PR-wide items were verified but were not practical to demonstrate with focused unit/regression tests or anchor to a useful changed file. They are grouped here to keep the PR thread focused.

<details>
  <summary><one sentence stating what breaks and why for this finding></summary>

- **Location:** <path:line, path, or PR-wide>
- **Source lanes:** <[vette] [name-check] [thermo-nuclear]>
- **Impact:** <what user/system behavior breaks and who is affected>
- **Evidence:** <how it was verified>
- **Why no focused test:** <reason>
- **Fix boundary:** <smallest safe change expected>
</details>

- Repeat one \`<details>\` block per verified-but-untestable finding.
- If every verified-but-untestable finding was posted as a file/line-level comment, do not post a grouped untestable-items comment; record "none" for grouped untestable items in the final report.
- The shared poster records exact-line, file-level, and general fallback results per comment.`;
}

function vettePrompt(
	ctx: PrContext,
	rawArgs: string,
	options: {
		wantsPosting: boolean;
		noPost?: boolean;
		forceLocal?: boolean;
	},
): string {
	const commentPolicy = options.noPost
		? "DRY RUN (--no-post): do not post any GitHub comments, reviews, or other externally visible output. Prepare comment-ready markdown for verified findings and present it in the final report only."
		: options.wantsPosting
			? "The user explicitly allowed posting comments, but posting is already automatic for verified external-review findings."
			: "Post externally visible GitHub review comments automatically for verified external-review findings. Do not ask for additional posting approval after verification passes.";
	const localModels = localModelContract(options.forceLocal === true);
	const fallowAudit = fallowAuditContract(prBaseRef(ctx.pr));
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
		return `Run /vette owner repair mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\n${visibleStatusContract}\n\n${localModels ? `${localModels}\n\n` : ""}Mandatory behavior:\n- Local non-merge commit evidence indicates this PR branch is owned here, so do NOT draft or post PR review comments for findings.\n- Use evidence-first vette/pr-review techniques to find confirmed, user-impacting defects, weak tests, merge conflicts, failed checks, and review/bot comments that require action.\n- For each confirmed related finding, repair it through strict TDD: red test, red verification, green implementation, reviewer/verifier, refactor gate.\n- Spawn focused subagents according to the contract below for every non-trivial failure/finding.\n- Verify locally with focused commands, then broader checks when appropriate.\n- Commit and push focused fixes when verification passes and the repository state is safe.\n- If a finding is real but out of scope, document it in the final report instead of bloating this PR.\n- If the worktree was dirty before this command, protect pre-existing changes and report how they were handled before any repair action.

${fallowAudit}

Use these existing skills/instructions by prompt routing as relevant: vette, pr-review, tdd, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.
\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${subagentContract()}\n\nFinish with PR URL, fixes made, commits pushed, findings artifact path, exact verification commands/results, and any blockers.\n\nComment policy: owner PR mode must not draft or post PR review comments.`;
	}

	return `Run /vette external PR review mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\n${visibleStatusContract}\n\n${localModels ? `${localModels}\n\n` : ""}Mandatory behavior:\n- Local non-merge commit evidence does not show this PR branch is owned here, so perform an evidence-backed PR review/comment workflow.\n- Review source branch against base branch using merge-base diff, PR title/body, linked requirements, changed files, contracts, and tests.\n- Run vette risk lanes only for changed behavior; do not expand into a whole-repo audit unless necessary for evidence.\n- Verify every actionable finding locally through static proof, focused command, or a temporary failing test. Clean up temporary artifacts.\n- Before finalizing comments, look for findings that can be reproduced with focused unit/regression tests; build those tests, run them, and verify they fail for the expected reason. If the test command still fails after the exact-command retry, run one second dependency install attempt, then run the repository build/rebuild command, then rerun the focused test before preparing or posting any comments.
- Prepare GitHub review comments that follow the repo comment contract: exact file/line when available, user impact, local evidence, fix boundary, and suggested tests when appropriate. For every substantive finding, put a one-sentence bug reason in the \`<summary>\` and keep evidence/verification inside the expanded \`<details>\` body. For test-reproducible findings, include the exact failing test code in the associated comment body.
- After all verification and cleanup is complete, post verified comments in one posting pass. Prefer file/line comments, fall back to file-level comments when line placement is not possible, and fall back to a general PR comment when the file is not a good comment target.
- Split verified-but-untestable findings into specific file/line review comments whenever possible, using file-level comments when exact line placement is not reliable, so each affected file can be resolved separately. Build a grouped final PR comment only for verified-but-untestable items that cannot be anchored to a useful changed file; each grouped finding must be its own \`<details>\` block with a concise summary.
- Post only findings that passed the verification gate; reject or report unverified suggestions without posting them.\n- ${commentPolicy}\n- Do not implement repairs on someone else's PR unless the user explicitly asks after seeing the review.\n\n${fallowAudit}\n\nUse these existing skills/instructions by prompt routing as relevant: pr-review, vette, naming, test-name, and thermo-nuclear-code-quality-review.
\n${parallelSuggestionContract()}
\n${findingsArtifactContract(ctx)}\n\n${reviewCommentTestContract()}\n\n${reviewCommentPostingContract()}\n\n${reviewCommentTemplateContract()}\n\nFinish with review disposition, commands/results, findings artifact path, comments prepared and posted, rejected findings, untestable-items comment URL/status, and cleanup status.`;
}

function scopeVettePrompt(
	ctx: ScopeVetteContext,
	rawArgs: string,
	options: { forceLocal?: boolean } = {},
): string {
	const localModels = localModelContract(options.forceLocal === true);
	return `Run /vette scope bug-discovery mode. This is not a PR review: audit the requested service/module/scope, validate likely bugs, build focused repro tests where practical, and draft local bug tickets only.\n\n${scopeVetteSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\n${localModels ? `${localModels}\n\n` : ""}Visible status requirements:\n- Maintain an explicit status/todo sequence and update it immediately as phases change:\n  1. Resolve and map target scope\n  2. Run parallel risk lanes\n  3. Synthesize candidate bugs\n  4. Verify candidates with evidence and repro tests where practical\n  5. Write local bug-ticket drafts\n  6. Complete\n- While active, state the current phase in plain text, e.g. "working on (2/6): running parallel risk lanes".\n- End with "status: idle — scope vette complete" and counts for candidates, verified bugs, bug drafts written, rejected items, blocked items, and test-backed drafts.\n\nMandatory behavior:\n- Treat ${ctx.target} as the audit boundary. It may be a full service, module, package, directory, route group, job, or subsystem. First identify its entry points, dependencies, data stores, side effects, tests, and owner-facing behavior.\n- Run read-only risk lanes in parallel before deciding what deserves verification: vette risk review, naming/test-name check, and thermo-nuclear-code-quality-review. For broad service scopes, add focused lanes for API/contract boundaries, data consistency, async/job behavior, error handling, and observability where relevant.\n- Promote only verified, user-impacting defects to bug-ticket drafts. Verification can be static proof, a focused command, a runtime observation, or a temporary focused failing test.\n- For each candidate where a focused unit/regression/integration test is practical, build the smallest repro test, run the focused command, and prove it fails for the expected reason. Clean up temporary test files unless the user explicitly asks to keep them, but preserve exact test code and failing output in the draft.\n- Do not edit production code or implement fixes in scope mode unless the user explicitly asks after reading the drafts.\n- Do not create GitHub issues, Linear tickets, PR comments, or commits. Write local Markdown drafts only.\n\nUse these existing skills/instructions by prompt routing as relevant: vette, tdd, pr-review, naming, test-name, and thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContractForPath(ctx.findingsPath)}\n\n${bugDraftContract(ctx)}\n\n${subagentContract()}\n\nFinish with target scope, drafts directory, findings artifact path, verification commands/results, repro test summary, draft filenames, rejected findings, blocked findings, and cleanup status.`;
}

function prPrompt(
	ctx: PrContext,
	rawArgs: string,
	options: {
		wantsPosting: boolean;
		wantsWatch: boolean;
		noPost?: boolean;
		forceLocal?: boolean;
	},
): string {
	const localModels = localModelContract(options.forceLocal === true);
	const fallowAudit = fallowAuditContract(prBaseRef(ctx.pr));
	const vetteSections = vetteBetaSectionsContract();
	return `Run /pr preparation, vette, repair, and monitoring mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /pr args: ${rawArgs || "<none>"}\n\n${localModels ? `${localModels}\n\n` : ""}Visible status and timing requirements:\n- Check immediately, then use a 15-minute cadence while watching.\n- Before every wait, state the current PR status, what was checked, whether you are working or idle, progress like "working on (1/1)", and the next check time.\n- On every watch check, inspect the PR lifecycle with \`gh pr view ${ctx.pr.number} --json state,mergedAt,mergeStateStatus\`. If \`state\` is \`MERGED\` or \`mergedAt\` is present, close down the watch item immediately: do not run more checks, post comments, repair code, or schedule another wait. End with exactly "status: merged — PR #${ctx.pr.number} is merged; watch closed".\n- When no actionable issue/comment/check failure is present, state "idle until <time>" instead of spawning agents.\n- When a new actionable issue appears, state "working on (n/total)" and only then spin up the focused code agent for that issue.\n\nObjectives:\n1. Resolve and validate the integration base/target branch. Prefer the PR base branch already shown above; verify it exists remotely before diffing or updating.\n2. Inspect repository PR rules and standards: .github/pull_request_template.md, contributing docs, branch policy, conventional title style, required body sections, and target-branch expectations.\n3. Analyze the current PR title/body against the template and rules. Plan exact updates needed; apply safe title/body fixes when appropriate.\n4. Run the current /vette beta workflow internally against this PR diff, covering all 11 sections before synthesis:
${vetteSections}
   - Owner PR: no comments; find and fix confirmed issues through TDD-focused subagents.
   - External PR: evidence-backed review comments are posted automatically after all verification is complete. At the end of synthesis, create focused unit/regression repro tests for comment-worthy findings where practical, verify those tests fail for the expected reason, include the exact test code in the templated associated comment body, then post verified items in one pass using file/line comments when possible, file-level comments when line placement is not possible, and general PR comments as the fallback. Split verified-but-untestable items into specific file/line review comments whenever possible; use a grouped final comment only for PR-wide or otherwise unanchorable items.
${fallowAudit}
5. Detect merge conflicts and resolve related conflicts through a focused merge-conflict resolver agent.
6. Inspect CI with \`gh pr checks\` as the source of truth. For failed checks, classify related/unrelated/uncertain. Treat uncertain as related until proven otherwise. For each failed pipeline/check command, retry the exact command up to 3 total attempts before declaring it still failing. Stop early on success and record every attempt/outcome.\n7. Fix related failures with focused code/TDD subagents. For unrelated flaky/infrastructure failures, retry the failed command/check up to 3 total attempts when safe, document evidence, and avoid bloating this PR.\n8. Inspect PR comments, reviews, BugBot/bot alerts, and new commits. Spin up code/fix agents only when a new actionable issue/comment/check failure appears.
9. ${options.wantsWatch ? "Keep watching until the PR is merged, checks are green and actionable comments are resolved, or until blocked by a product/architecture decision. A merged PR is terminal: close the babysit item, report the merged state, and do not schedule another check. The watch cadence is 15 minutes between checks unless a GitHub command returns a live pending state sooner." : "Do not enter a long watch loop because --no-watch was provided; perform one full pass and report next steps."}\n\nUse these existing skills/instructions by prompt routing as relevant: pull-request, vette, pr-review, tdd, babysitting-pull-requests, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${reviewCommentPostingContract()}\n\n${reviewCommentTemplateContract()}\n\n${subagentContract()}\n\nSafety rules:
- Report dirty worktree state before repair actions and protect pre-existing changes.\n- ${options.noPost ? "DRY RUN (--no-post): do not post any GitHub comments or reviews; prepare comment-ready markdown for verified findings and present it in the final report only." : `For external PR review findings, post only verified comments automatically; unverified suggestions must be rejected or reported without posting. Current posting flag: ${options.wantsPosting ? "explicitly allowed but not required" : "not required for verified findings"}.`}\n- Never force push.\n- Do not bypass hooks or required checks.\n- Do not create durable watch-loop helper scripts; keep monitoring as agent/process discipline.\n\nFinish with PR URL, title/body/base validation result, findings artifact path, vette findings or repairs, CI/comment status, commits pushed, exact commands/results, and remaining blockers.`;
}

export function draftPrPrompt(
	ctx: DraftPrContext,
	resolveError: string,
	rawArgs: string,
	options: {
		wantsPosting: boolean;
		wantsWatch: boolean;
		forceLocal?: boolean;
	},
): string {
	const localModels = localModelContract(options.forceLocal === true);
	const fallowAudit = fallowAuditContract(ctx.baseRef);
	const vetteSections = vetteBetaSectionsContract();
	return `Run /pr draft-first creation, vette, repair, and monitoring mode for this branch. No existing pull request was resolved, so push the branch and open a DRAFT pull request immediately, then vette while the human reviews the draft in parallel.\n\n${draftPrSummary(ctx, resolveError)}\n\nOriginal /pr args: ${rawArgs || "<none>"}\n\n${localModels ? `${localModels}\n\n` : ""}Visible status and timing requirements:\n- First state "working on (1/4): pushing branch and creating draft PR".\n- After the draft PR exists, state "working on (2/4): vetting branch while draft PR is under human review" and share the PR URL so the human can start reviewing right away.\n- After vette/repair and CI verification pass, state "working on (3/4): marking PR ready for review" and run \`gh pr ready <created-pr-number-or-url>\`.\n- Then state "working on (4/4): monitoring PR" and use the created PR URL/number for all PR-aware checks.\n- Check immediately, then use a 15-minute cadence while watching.
- Before every wait, state the current PR status, what was checked, whether you are working or idle, and the next check time.
- After the PR exists, every watch check must inspect the PR lifecycle with \`gh pr view <created-pr-number-or-url> --json state,mergedAt,mergeStateStatus\`. If \`state\` is \`MERGED\` or \`mergedAt\` is present, close down the watch item immediately: do not run more checks, post comments, repair code, or schedule another wait. End with exactly "status: merged — PR #<number> is merged; watch closed".\n\nObjectives:\n1. Validate the working branch and base. Use current branch ${ctx.branch} as the PR head. Prefer ${ctx.baseBranch} as the base, but verify the remote base exists and adjust only when repository policy clearly requires a different base.\n2. Protect pre-existing dirty worktree changes. Report them before any push or repair action and avoid overwriting unrelated user changes.\n3. Create the draft PR first so human review and agent checks run in parallel: inspect repository PR rules and standards (.github/pull_request_template.md, contributing docs, branch policy, conventional title style, required body sections, target-branch expectations), prepare a concise title and body that satisfy the template, push the branch, then create the pull request with \`gh pr create --draft\` targeting the validated base. Do not require the user to provide a branch, PR number, or URL. Report the PR URL immediately after creation.\n4. With the draft PR up, run the current /vette beta workflow internally against the branch diff from the base, covering all 11 sections before synthesis:
${vetteSections}
Verify every confirmed issue; repair confirmed defects through TDD-focused subagents; run focused verification; and push fixes to the PR branch as they pass so the human always reviews the latest state.
${fallowAudit}
5. While vetting, also validate title/body/base against the template, inspect merge conflicts, and inspect CI with \`gh pr checks\`; for each failed pipeline/check command, retry the exact command up to 3 total attempts before declaring it still failing, then fix related failures with focused TDD/code subagents.
6. When vette/repair is complete and CI is green (or only unrelated failures remain, documented with evidence), mark the PR ready for review with \`gh pr ready\`. If vette finds blocking defects that cannot be repaired safely, leave the PR in draft and report the blockers instead.\n7. After marking ready, continue with the normal /pr behavior: monitor comments/reviews/BugBot/bot alerts/new commits, and fix related failures with focused TDD/code subagents.\n8. ${options.wantsWatch ? "Keep watching until the PR is merged, checks are green and actionable comments are resolved, or until blocked by a product/architecture decision. A merged PR is terminal: close the babysit item, report the merged state, and do not schedule another check. The watch cadence is 15 minutes between checks unless a GitHub command returns a live pending state sooner." : "Do not enter a long watch loop because --no-watch was provided; perform one full pass through draft PR creation, vette, and initial validation, then report next steps."}\n\nUse these existing skills/instructions by prompt routing as relevant: vette, pr-review, tdd, babysitting-pull-requests, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${draftFindingsArtifactContract(ctx)}\n\n${subagentContract()}\n\nSafety rules:\n- Never force push.\n- Do not bypass hooks or required checks.\n- Do not create durable watch-loop helper scripts; keep monitoring as agent/process discipline.\n- Verified external-review posting rules only apply after a PR exists. Current posting flag: ${options.wantsPosting ? "explicitly allowed but not required" : "not required for verified findings"}.\n\nFinish with PR URL, draft-to-ready transition status, title/body/base validation result, findings artifact path, vette findings or repairs, CI/comment status, commits pushed, exact commands/results, and remaining blockers.`;
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
	if (parsed.commentsOnly) {
		throw new Error(
			"--comments-only is only supported for a pull-request review; do not combine it with /vette old, --scope, --service, or self mode",
		);
	}
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
					noPost: parsed.noPost,
					forceLocal: parsed.forceLocal,
				})
			: scopeVettePrompt(vetteCommandContext.scopeContext, parsed.raw, {
					forceLocal: parsed.forceLocal,
				});
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

	if (queued) {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify("/vette queued as follow-up", "info");
	} else {
		pi.sendUserMessage(prompt);
	}
}

export async function resolveVetteBetaTarget(
	targetArg: string | undefined,
	cwd: string,
): Promise<VetteBetaReviewTarget | undefined> {
	const selector = !targetArg || targetArg === "now" ? "" : targetArg;
	try {
		const prContext = await resolvePrContext(selector, cwd);
		return {
			label: `PR #${prContext.pr.number}`,
			...(prContext.pr.headRefName ? { headRef: prContext.pr.headRefName } : {}),
			...(prContext.pr.baseRefName
				? { baseRef: `origin/${prContext.pr.baseRefName}` }
				: {}),
			...(prContext.pr.title ? { title: prContext.pr.title } : {}),
			...(prContext.pr.body ? { body: prContext.pr.body } : {}),
			reviewMode: prContext.isOwner ? "repair" : "comment",
			prNumber: prContext.pr.number,
			prUrl: prContext.pr.url,
		};
	} catch (prError) {
		if (!selector) return undefined;
		// Only fall back to a branch review when the selector is actually a
		// resolvable ref; otherwise a failed PR lookup would silently review
		// the wrong thing (or nothing).
		const branchResolves = await Promise.any([
			run("git", ["rev-parse", "--verify", `${selector}^{commit}`], cwd),
			run("git", ["rev-parse", "--verify", `origin/${selector}^{commit}`], cwd),
		]).then(
			() => true,
			() => false,
		);
		if (!branchResolves) {
			const reason = prError instanceof Error ? prError.message : String(prError);
			throw new Error(
				`"${selector}" is neither a resolvable PR nor a known branch (PR lookup: ${reason.trim() || "failed"})`,
			);
		}
		const base = await resolveDefaultBase(cwd, selector);
		return {
			label: `branch ${selector}`,
			headRef: selector,
			baseRef: base.ref,
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
	const allTokens = args.trim().split(/\s+/).filter(Boolean);
	const commentsOnly = allTokens.includes("--comments-only");
	if (
		commentsOnly &&
		(allTokens.includes("--scope") || allTokens.includes("--service"))
	) {
		throw new Error(
			"--comments-only cannot be combined with --scope or --service",
		);
	}
	let noPost = shouldSuppressVetteBetaPosting(args);
	const forceLocal =
		allTokens.includes("--local") || allTokens.includes("--force-local");
	const regression = allTokens.includes("--regression");
	const tokens = allTokens.filter((token) => !token.startsWith("--"));
	const firstToken = tokens[0]?.toLowerCase();
	const actionOffset = firstToken === "beta" ? 1 : 0;
	const modeOrAction = tokens[actionOffset]?.toLowerCase() ?? "now";
	if (commentsOnly && modeOrAction === "scope") {
		throw new Error("--comments-only cannot be combined with scope mode");
	}
	const isSelfReview = modeOrAction === "self";
	const isDraftReview = modeOrAction === "doc";
	const isPostReview = modeOrAction === "post";
	if (commentsOnly && isSelfReview) {
		throw new Error("--comments-only cannot be combined with /vette self");
	}
	if (isDraftReview) noPost = true;
	if (
		isPostReview &&
		!allTokens.includes("--no-post") &&
		!allTokens.includes("--dry-run")
	) {
		noPost = false;
	}
	let action = tokens[actionOffset] ?? "now";
	if (isSelfReview || isDraftReview || isPostReview) {
		action = tokens[actionOffset + 1] ?? "now";
	}
	// SAFETY: Extension contexts expose modelRegistry at runtime, but the SDK type omits it.
	const modelRegistry = (ctx as unknown as { modelRegistry?: unknown })
		.modelRegistry as
		| undefined
		| Parameters<typeof formatResolvedModelPool>[0]["modelRegistry"];
	const baseConfig = await loadVetteBetaConfig();
	const config = forceLocal
		? forceLocalVetteBetaConfig(baseConfig, modelRegistry)
		: baseConfig;
	if (action === "models") {
		ctx.ui.notify(
			formatResolvedModelPool({
				config,
				modelRegistry,
			}),
			"info",
		);
		return;
	}
	let target: VetteBetaReviewTarget | undefined;
	try {
		target = isSelfReview
			? undefined
			: await resolveVetteBetaTarget(action, ctx.cwd);
		if (target && regression) target = { ...target, regression: true };
		if (!target && regression) {
			target = { label: "current worktree", regression: true };
		}
	} catch (error) {
		ctx.ui.notify(
			`/vette aborted: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	const reviewMode = resolveVetteReviewMode({
		targetMode: target?.reviewMode,
		isSelfReview,
		isDraftReview,
		commentsOnly,
	});
	const resolvedPool = resolveModelPool({
		config,
		modelRegistry,
	});
	const firstLaunchModel =
		resolvedPool.entries.find((entry) => entry.availability !== "missing") ??
		resolvedPool.entries[0];
	const usableEntries = resolvedPool.entries.filter(
		(entry) => entry.availability !== "missing",
	);
	const localModelEntries = usableEntries.filter((entry) =>
		/^(ollama|lmstudio|local)\//i.test(entry.model),
	);
	const isLocalVette =
		localModelEntries.length > 0 &&
		localModelEntries.length === usableEntries.length;
	const modelSummary = firstLaunchModel
		? `${formatModelConnection(firstLaunchModel.model)} from pool '${resolvedPool.poolName}'`
		: `pool '${resolvedPool.poolName}' has no usable models`;
	const targetLabel =
		target?.label ??
		(isSelfReview ? "current branch self-review" : "current worktree");
	const topicLabels = VETTE_BETA_TOPICS.map((topic) => topic.label).join(", ");
	const queued = !ctx.isIdle();
	options.onStatus?.({
		targetLabel,
		reviewMode,
		queued,
		topicLabels,
	});

	const localVetteNotice = isLocalVette
		? " [LOCAL VETTE — using local model(s) only, timeout extended to 30min/topic]"
		: localModelEntries.length > 0
			? " [mixed pool — includes local model(s)]"
			: "";
	ctx.ui.notify(
		`/vette: building diff bundle for ${targetLabel}; launching lightweight topic agents with ${modelSummary}; mode=${reviewMode}; topics=${topicLabels}${regression ? " [REGRESSION / no-regressions]" : ""}${localVetteNotice}`,
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

	function truncateEnd(value: string, width: number): string {
		if (value.length <= width) return value;
		return `${value.slice(0, Math.max(0, width - 1))}…`;
	}

	function orderedTopicStates(): TopicState[] {
		const statusRank: Record<TopicState["status"], number> = {
			running: 0,
			pending: 1,
			done: 2,
			failed: 2,
		};
		return [...topicStates.values()].sort(
			(a, b) => statusRank[a.status] - statusRank[b.status],
		);
	}

	function renderTopicLine(
		icon: string,
		state: TopicState,
		detail: string,
	): string {
		const left = `${icon} ${state.label}${detail}`;
		if (!state.model) return `  ${left}`;
		const leftWidth = 58;
		return `  ${truncateEnd(left, leftWidth).padEnd(leftWidth)}  ${state.model}`;
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
		for (const state of orderedTopicStates()) {
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
			lines.push(renderTopicLine(icon, state, detail));
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

	let result: Awaited<ReturnType<typeof runVetteBetaReview>> | undefined;
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
					topicLabels,
				});
			},
		});
	} catch (error) {
		if (error instanceof VetteBetaDiffError) {
			ctx.ui.notify(`/vette aborted: ${error.message}`, "error");
			return;
		}
		throw error;
	} finally {
		clearInterval(widgetTimer);
		ctx.ui.setWidget("vette-progress", undefined);
	}

	phase = "done";
	if (!result) return;
	options.onStatus?.({
		targetLabel,
		reviewMode,
		queued: false,
		progress: `${result.results.length}/${VETTE_BETA_TOPICS.length}`,
		topicLabels,
	});

	if (result.aborted || ctx.signal?.aborted) {
		ctx.ui.notify("/vette cancelled — no synthesis or posting", "info");
		return;
	}

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

	const synthesisPrompt = formatVetteBetaSynthesisPrompt(result, {
		noPost,
		localOnly: forceLocal,
		commentsOnly,
	});

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
			duration: state.durationMs === undefined ? "-" : fmtMs(state.durationMs),
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
	// Recompute idle state now: the agent may have gone idle (or busy) while topics ran.
	if (ctx.isIdle()) {
		pi.sendUserMessage(synthesisPrompt);
	} else {
		pi.sendUserMessage(synthesisPrompt, { deliverAs: "followUp" });
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
					noPost: parsed.noPost,
					forceLocal: parsed.forceLocal,
				})
			: draftPrPrompt(
					prCommandContext.draftContext,
					prCommandContext.resolveError,
					parsed.raw,
					{
						wantsPosting: parsed.wantsPosting,
						wantsWatch: parsed.wantsWatch,
						forceLocal: parsed.forceLocal,
					},
				);

	if (prCommandContext.kind === "existing") {
		ctx.ui.notify(
			`/pr: PR #${prCommandContext.prContext.pr.number} (prepare/watch)`,
			"info",
		);
	} else {
		ctx.ui.notify(
			`/pr: pushing ${prCommandContext.draftContext.branch} and opening a draft PR for parallel review`,
			"info",
		);
	}

	if (queued) {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify("/pr queued as follow-up", "info");
	} else {
		pi.sendUserMessage(prompt);
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
	const topics = status.topicLabels ? ` topics ${status.topicLabels}` : "";
	const next = status.nextCheckAt
		? ` next ${formatCountdown(status.nextCheckAt)}`
		: "";
	return `${base}${mode}${topics}${next}`;
}

export function buildVetteBetaCommandStatus(
	statusContext: VetteBetaStatusContext,
): CommandStatus {
	let mode = "external/comment review";
	if (statusContext.reviewMode === "repair") {
		mode = "owned/self repair";
	} else if (statusContext.reviewMode === "doc") {
		mode = "local doc findings";
	}
	return {
		command: "vette",
		target: statusContext.targetLabel,
		mode,
		phase: statusContext.queued ? "queued" : "working",
		progress: statusContext.progress ?? `0/${VETTE_BETA_TOPICS.length}`,
		topicLabels:
			statusContext.topicLabels ??
			VETTE_BETA_TOPICS.map((topic) => topic.label).join(", "),
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
			mode: "draft/watch",
			phase: options.queued ? "queued" : "working",
			progress: "1/4",
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

async function dispatchVetteReviewPrompt(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const limitFlagIndex = tokens.indexOf("--limit");
	const limit =
		limitFlagIndex >= 0 ? Number(tokens[limitFlagIndex + 1]) : undefined;
	const sections = await loadVetteReviewSections({ limit });
	if (sections.length === 0) {
		ctx.ui.notify(
			"No saved review artifacts found under /tmp/pi-vette-findings or /tmp/pi-vette-bug-drafts.",
			"warning",
		);
		return;
	}
	pi.sendUserMessage(formatVetteReviewPrompt(sections), {
		deliverAs: ctx.isIdle() ? undefined : "followUp",
	});
	ctx.ui.notify(
		`/vette review queued ${sections.length} artifact section${sections.length === 1 ? "" : "s"} for outcome analysis.`,
		"info",
	);
}

async function currentBranchSlug(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd },
		);
		return slugifyBranch(stdout.trim(), "worktree");
	} catch {
		return "worktree";
	}
}

async function dispatchVetteComparePrompt(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	options: { cooldown: VetteBetaCooldown },
): Promise<void> {
	let parsed: ReturnType<typeof parseVetteCompareArgs>;
	try {
		parsed = parseVetteCompareArgs(args);
	} catch (error) {
		ctx.ui.notify(
			`/vette compare: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	// SAFETY: Extension contexts expose modelRegistry at runtime, but the SDK type omits it.
	const modelRegistry = (ctx as unknown as { modelRegistry?: unknown })
		.modelRegistry as undefined | Parameters<typeof buildVetteCompareConfig>[1];
	const baseConfig = await loadVetteBetaConfig();

	if (parsed.listModels) {
		const defaults = buildVetteCompareConfig(baseConfig, modelRegistry);
		ctx.ui.notify(
			formatVetteCompareModels({
				remote: listVetteCompareRemoteModels(baseConfig),
				local: listVetteCompareLocalModels(modelRegistry),
				defaults: {
					remote: defaults.remoteModel,
					local: defaults.localModel,
				},
			}),
			"info",
		);
		return;
	}

	let comparePools: ReturnType<typeof buildVetteCompareConfig>;
	try {
		comparePools = buildVetteCompareConfig(baseConfig, modelRegistry, {
			...(parsed.remoteModel ? { remoteModel: parsed.remoteModel } : {}),
			...(parsed.localModel ? { localModel: parsed.localModel } : {}),
		});
	} catch (error) {
		ctx.ui.notify(
			`/vette compare: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	let target: VetteBetaReviewTarget | undefined;
	try {
		target = await resolveVetteBetaTarget(parsed.targetArg, ctx.cwd);
	} catch (error) {
		ctx.ui.notify(
			`/vette compare aborted: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	const targetLabel =
		target?.label ??
		(parsed.targetArg ? `branch ${parsed.targetArg}` : "current worktree");
	const topicCount = parsed.topics?.length ?? VETTE_BETA_TOPICS.length;
	ctx.ui.notify(
		`/vette compare: ${targetLabel}; remote=${comparePools.remoteModel}; local=${comparePools.localModel}; topics=${topicCount}`,
		"info",
	);

	let currentLeg: "remote" | "local" | undefined;
	let result: Awaited<ReturnType<typeof runVetteBetaCompare>> | undefined;
	try {
		result = await runVetteBetaCompare({
			ctx,
			pi,
			config: comparePools.config,
			cooldown: options.cooldown,
			remotePoolName: comparePools.remotePoolName,
			localPoolName: comparePools.localPoolName,
			remoteModel: comparePools.remoteModel,
			localModel: comparePools.localModel,
			targetLabel,
			...(target ? { target } : {}),
			...(parsed.topics ? { topics: parsed.topics } : {}),
			onLegStart: (leg) => {
				currentLeg = leg;
				ctx.ui.notify(
					`/vette compare: running ${leg} leg (${leg === "remote" ? comparePools.remoteModel : comparePools.localModel})`,
					"info",
				);
			},
		});
	} catch (error) {
		if (error instanceof VetteBetaDiffError) {
			ctx.ui.notify(`/vette compare aborted: ${error.message}`, "error");
			return;
		}
		if (currentLeg) {
			ctx.ui.notify(
				`/vette compare failed during ${currentLeg} leg: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		throw error;
	}

	const branchSlug = target?.headRef
		? slugifyBranch(target.headRef, "compare")
		: await currentBranchSlug(ctx.cwd);
	const artifactPath = vetteCompareArtifactPath(branchSlug);
	const report = formatVetteCompareReport(result);
	await writeVetteCompareArtifact(artifactPath, report);
	ctx.ui.notify(
		`${formatVetteCompareSummary(result)}\nArtifact: ${artifactPath}`,
		"info",
	);
}

function getExtensionMtimes(): Record<string, number> {
	const mtimes: Record<string, number> = {};
	try {
		const self = new URL(import.meta.url).pathname;
		const vetteModule = new URL("./vette-beta.ts", import.meta.url).pathname;
		for (const file of [self, vetteModule]) {
			try {
				mtimes[file] = statSync(file).mtimeMs;
			} catch {
				// File may not be stat-able in bundled/virtual environments.
			}
		}
	} catch {
		// import.meta.url may not resolve to a filesystem path.
	}
	return mtimes;
}

function checkExtensionUpdated(baseline: Record<string, number>): {
	updated: boolean;
	files: string[];
} {
	const changed: string[] = [];
	for (const [file, originalMtime] of Object.entries(baseline)) {
		try {
			const currentMtime = statSync(file).mtimeMs;
			if (currentMtime > originalMtime) changed.push(file);
		} catch {}
	}
	return { updated: changed.length > 0, files: changed };
}

// fallow-ignore-next-line unused-export -- Pi extension entrypoint loaded from package.json
export default function (pi: ExtensionAPI) {
	let currentStatus: CommandStatus | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	const vetteBetaCooldown = new VetteBetaCooldown();
	const extensionLoadMtimes = getExtensionMtimes();

	function stopStatusTimer(): void {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
	}

	function publishStatus(ctx: Pick<ExtensionCommandContext, "ui">): void {
		// Roll an expired countdown forward one watch cycle so the footer keeps
		// tracking the agent's 15-minute cadence instead of freezing at 0s.
		if (
			currentStatus?.nextCheckAt !== undefined &&
			currentStatus.phase === "working" &&
			currentStatus.nextCheckAt <= Date.now()
		) {
			currentStatus.nextCheckAt += 15 * 60_000;
		}
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
			"Review a diff and automatically post only verified file/line comments by default. Use --no-post for local comment-ready output, --regression for no-regression review of large changes (chunked by file/subsystem), /vette compare for model comparison, /vette old for the legacy workflow, or /vette review to analyze saved review artifacts.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const preCheck = checkExtensionUpdated(extensionLoadMtimes);
			if (preCheck.updated) {
				ctx.ui.notify(
					`/vette: plugin files updated on disk since load — consider reloading extensions for latest changes. Continuing with loaded version.`,
					"warning",
				);
			}

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
			if (subcommand === "reviewers") {
				const catalog = await discoverReviewers(ctx.cwd);
				const lines = [
					`Discovered reviewers: ${catalog.discovered.length}`,
					`Selected for current worktree: ${catalog.selected.length}`,
					...catalog.discovered.map((reviewer) => {
						const selected = catalog.selected.find(
							(item) => item.name === reviewer.name,
						);
						return `- ${reviewer.name} [${reviewer.source === "builtin" ? "builtin" : reviewer.source}] priority=${reviewer.priority} ${selected ? `MATCH (${selected.matchReason})` : "SKIP"}`;
					}),
					...catalog.diagnostics.map(
						(diagnostic) => `! ${diagnostic.sourcePath}: ${diagnostic.message}`,
					),
				];
				ctx.ui.notify(
					lines.join("\n"),
					catalog.diagnostics.some((item) => item.severity === "error")
						? "warning"
						: "info",
				);
				return;
			}
			if (subcommand === "review") {
				await dispatchVetteReviewPrompt(pi, tokens.slice(1).join(" "), ctx);
				return;
			}
			if (subcommand === "compare") {
				await dispatchVetteComparePrompt(pi, tokens.slice(1).join(" "), ctx, {
					cooldown: vetteBetaCooldown,
				});
				return;
			}
			await dispatchVetteBetaPrompt(pi, args, ctx, {
				cooldown: vetteBetaCooldown,
				onStatus: (statusContext) => setVetteBetaCommandStatus(ctx, statusContext),
			});

			const postCheck = checkExtensionUpdated(extensionLoadMtimes);
			if (postCheck.updated) {
				ctx.ui.notify(
					`/vette: plugin was updated during run — reload extensions to pick up changes for the next run.`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("pr", {
		description:
			"Vette the current branch, create a pull request when needed, then monitor it until merged, green, or blocked.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await dispatchPrPrompt(pi, args, ctx, (prCommandContext, parsed, options) =>
				setPrCommandStatus(ctx, prCommandContext, parsed, options),
			);
		},
	});
}
