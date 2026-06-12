import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

type GhAuthor = {
	login?: string;
	name?: string;
	is_bot?: boolean;
};

type GhPullRequest = {
	number: number;
	url: string;
	title?: string;
	body?: string;
	author?: GhAuthor;
	headRefName?: string;
	baseRefName?: string;
	isDraft?: boolean;
	mergeStateStatus?: string;
	reviewDecision?: string;
};

type PrContext = {
	selector: string;
	pr: GhPullRequest;
	viewer: string;
	isOwner: boolean;
	dirtyStatus: string;
};

type CommandStatus = {
	command: "vette" | "pr";
	prNumber: number;
	mode: string;
	phase: "working" | "queued" | "idle" | "blocked";
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
	"baseRefName",
	"isDraft",
	"mergeStateStatus",
	"reviewDecision",
].join(",");

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseArgs(args: string): {
	selector: string;
	wantsPosting: boolean;
	wantsWatch: boolean;
	raw: string;
} {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const flags = new Set(tokens.filter((token) => token.startsWith("--")));
	const selector = tokens.find((token) => !token.startsWith("--")) ?? "";
	return {
		selector,
		wantsPosting:
			flags.has("--post-comments") ||
			flags.has("--post") ||
			flags.has("--submit-review"),
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

	let viewer = "";
	try {
		viewer = await run("gh", ["api", "user", "--jq", ".login"], cwd);
	} catch (error) {
		throw new Error(
			`GitHub authentication is required to compare PR ownership. Run \`gh auth login\` and retry.\n\n${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return {
		selector,
		pr,
		viewer,
		isOwner: Boolean(
			pr.author?.login &&
				viewer &&
				pr.author.login.toLowerCase() === viewer.toLowerCase(),
		),
		dirtyStatus: await getDirtyStatus(cwd),
	};
}

function branchSlug(ctx: PrContext): string {
	const raw = ctx.pr.headRefName || ctx.selector || `pr-${ctx.pr.number}`;
	const slug = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || `pr-${ctx.pr.number}`;
}

function findingsArtifactPath(ctx: PrContext): string {
	return `/tmp/pi-vette-findings/${branchSlug(ctx)}/pr-${ctx.pr.number}-findings.md`;
}

function prSummary(ctx: PrContext): string {
	return [
		`PR: ${ctx.pr.url} (#${ctx.pr.number})`,
		`Title: ${ctx.pr.title ?? "<missing>"}`,
		`Author: ${ctx.pr.author?.login ?? "<unknown>"}`,
		`Authenticated GitHub user: ${ctx.viewer}`,
		`Ownership mode: ${ctx.isOwner ? "owner repair" : "external review"}`,
		`Head branch: ${ctx.pr.headRefName ?? "<unknown>"}`,
		`Base branch: ${ctx.pr.baseRefName ?? "<unknown>"}`,
		`Findings artifact: ${findingsArtifactPath(ctx)}`,
		`Draft: ${String(ctx.pr.isDraft ?? false)}`,
		`Merge state: ${ctx.pr.mergeStateStatus ?? "<unknown>"}`,
		`Review decision: ${ctx.pr.reviewDecision ?? "<unknown>"}`,
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
- Suggestions become repairs/comments only after parent verification confirms scope, impact, and evidence.`;
}

function findingsArtifactContract(ctx: PrContext): string {
	return `Findings artifact contract:
- Maintain a local Markdown findings artifact at ${findingsArtifactPath(ctx)} for this branch/PR.
- Create or update the artifact before posting or repairing anything, and keep it current as verification progresses.
- The artifact must include every candidate finding from every lane, whether verified, rejected, duplicate, out-of-scope, test-reproduced, verified-but-untestable, or still blocked.
- For each item, record: stable finding id, title, source lanes, status, severity/disposition, file/line when known, evidence, verification command/result, repro test path/code when applicable, posted comment URL/status when applicable, and rejection/blocker reason when applicable.
- Use the artifact as the source of truth for final counts and for resuming the review if the session is interrupted.
- Do not commit the artifact unless the user explicitly asks; it is a local temporary reference file.`;
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
		return `Run /vette owner repair mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\n${visibleStatusContract}\n\nMandatory behavior:\n- This PR is authored by the authenticated GitHub user, so do NOT draft or post PR review comments for findings.\n- Use evidence-first vette/pr-review techniques to find confirmed, user-impacting defects, weak tests, merge conflicts, failed checks, and review/bot comments that require action.\n- For each confirmed related finding, repair it through strict TDD: red test, red verification, green implementation, reviewer/verifier, refactor gate.\n- Spawn focused subagents according to the contract below for every non-trivial failure/finding.\n- Verify locally with focused commands, then broader checks when appropriate.\n- Commit and push focused fixes when verification passes and the repository state is safe.\n- If a finding is real but out of scope, document it in the final report instead of bloating this PR.\n- If the worktree was dirty before this command, protect pre-existing changes and report how they were handled before any repair action.\n\nUse these existing skills/instructions by prompt routing as relevant: vette, pr-review, tdd, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${subagentContract()}\n\nFinish with PR URL, fixes made, commits pushed, findings artifact path, exact verification commands/results, and any blockers.\n\nComment policy: owner PR mode must not draft or post PR review comments.`;
	}

	return `Run /vette external PR review mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /vette args: ${rawArgs || "<none>"}\n\n${visibleStatusContract}\n\nMandatory behavior:\n- This PR is NOT authored by the authenticated GitHub user, so perform an evidence-backed PR review/comment workflow.\n- Review source branch against base branch using merge-base diff, PR title/body, linked requirements, changed files, contracts, and tests.\n- Run vette risk lanes only for changed behavior; do not expand into a whole-repo audit unless necessary for evidence.\n- Verify every actionable finding locally through static proof, focused command, or a temporary failing test. Clean up temporary artifacts.\n- Before finalizing comments, look for findings that can be reproduced with focused unit/regression tests; build those tests, run them, and verify they fail for the expected reason.
- Prepare GitHub review comments that follow the repo comment contract: exact file/line when available, user impact, local evidence, fix boundary, and suggested tests when appropriate. For test-reproducible findings, include the exact failing test code in the associated comment body.
- After all verification and cleanup is complete, post verified comments in one posting pass. Prefer file/line comments, fall back to file-level comments when line placement is not possible, and fall back to a general PR comment when the file is not a good comment target.
- Build and post one singular final PR comment for verified-but-untestable findings, including file/line information for every item where possible.
- Post only findings that passed the verification gate; reject or report unverified suggestions without posting them.\n- ${commentPolicy}\n- Do not implement repairs on someone else's PR unless the user explicitly asks after seeing the review.\n\nUse these existing skills/instructions by prompt routing as relevant: pr-review, vette, naming, test-name, and thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${reviewCommentTestContract()}\n\n${reviewCommentPostingContract()}\n\n${reviewCommentTemplateContract()}\n\nFinish with review disposition, commands/results, findings artifact path, comments prepared and posted, rejected findings, untestable-items comment URL/status, and cleanup status.`;
}

function prPrompt(
	ctx: PrContext,
	rawArgs: string,
	options: { wantsPosting: boolean; wantsWatch: boolean },
): string {
	return `Run /pr preparation, vette, repair, and monitoring mode for this pull request.\n\n${prSummary(ctx)}\n\nOriginal /pr args: ${rawArgs || "<none>"}\n\nVisible status and timing requirements:\n- Check immediately, then use a 15-minute cadence while watching.\n- Before every wait, state the current PR status, what was checked, whether you are working or idle, progress like "working on (1/1)", and the next check time.\n- When no actionable issue/comment/check failure is present, state "idle until <time>" instead of spawning agents.\n- When a new actionable issue appears, state "working on (n/total)" and only then spin up the focused code agent for that issue.\n\nObjectives:\n1. Resolve and validate the integration base/target branch. Prefer the PR base branch already shown above; verify it exists remotely before diffing or updating.\n2. Inspect repository PR rules and standards: .github/pull_request_template.md, contributing docs, branch policy, conventional title style, required body sections, and target-branch expectations.\n3. Analyze the current PR title/body against the template and rules. Plan exact updates needed; apply safe title/body fixes when appropriate.\n4. Run the same PR-aware /vette behavior internally:\n   - Owner PR: no comments; find and fix confirmed issues through TDD-focused subagents.\n   - External PR: evidence-backed review comments are posted automatically after all verification is complete. At the end of synthesis, create focused unit/regression repro tests for comment-worthy findings where practical, verify those tests fail for the expected reason, include the exact test code in the templated associated comment body, then post verified items in one pass using file/line comments when possible, file-level comments when line placement is not possible, and general PR comments as the fallback. Build one singular templated final comment for verified-but-untestable items with file/line context whenever possible.\n5. Detect merge conflicts and resolve related conflicts through a focused merge-conflict resolver agent.\n6. Inspect CI with \`gh pr checks\` as the source of truth. For failed checks, classify related/unrelated/uncertain. Treat uncertain as related until proven otherwise.\n7. Fix related failures with focused code/TDD subagents. For unrelated flaky/infrastructure failures, retry once when safe, document evidence, and avoid bloating this PR.\n8. Inspect PR comments, reviews, BugBot/bot alerts, and new commits. Spin up code/fix agents only when a new actionable issue/comment/check failure appears.\n9. ${options.wantsWatch ? "Keep watching until checks are green and actionable comments are resolved, or until blocked by a product/architecture decision. The watch cadence is 15 minutes between checks unless a GitHub command returns a live pending state sooner." : "Do not enter a long watch loop because --no-watch was provided; perform one full pass and report next steps."}\n\nUse these existing skills/instructions by prompt routing as relevant: pull-request, vette, pr-review, tdd, babysitting-pull-requests, loop-on-ci, fix-merge-conflicts, naming, test-name, thermo-nuclear-code-quality-review.\n\n${parallelSuggestionContract()}\n\n${findingsArtifactContract(ctx)}\n\n${subagentContract()}\n\nSafety rules:
- Report dirty worktree state before repair actions and protect pre-existing changes.\n- For external PR review findings, post only verified comments automatically; unverified suggestions must be rejected or reported without posting. Current posting flag: ${options.wantsPosting ? "explicitly allowed but not required" : "not required for verified findings"}.\n- Never force push.\n- Do not bypass hooks or required checks.\n- Do not create durable watch-loop helper scripts; keep monitoring as agent/process discipline.\n\nFinish with PR URL, title/body/base validation result, findings artifact path, vette findings or repairs, CI/comment status, commits pushed, exact commands/results, and remaining blockers.`;
}

async function dispatchPrompt(
	pi: ExtensionAPI,
	commandName: "vette" | "pr",
	args: string,
	ctx: ExtensionCommandContext,
	buildPrompt: (
		prContext: PrContext,
		parsed: ReturnType<typeof parseArgs>,
	) => string,
	onResolved?: (
		prContext: PrContext,
		parsed: ReturnType<typeof parseArgs>,
		options: { queued: boolean },
	) => void,
): Promise<void> {
	const parsed = parseArgs(args);
	let prContext: PrContext;
	try {
		prContext = await resolvePrContext(parsed.selector, ctx.cwd);
	} catch (error) {
		ctx.ui.notify(`/${commandName} failed to resolve PR`, "error");
		throw error;
	}

	const mode =
		commandName === "vette"
			? prContext.isOwner
				? "owner repair"
				: "external review"
			: "prepare/watch";
	ctx.ui.notify(
		`/${commandName}: PR #${prContext.pr.number} (${mode})`,
		"info",
	);

	const prompt = buildPrompt(prContext, parsed);
	const queued = !ctx.isIdle();
	onResolved?.(prContext, parsed, { queued });
	if (!queued) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify(`/${commandName} queued as follow-up`, "info");
	}
}

function formatCountdown(nextCheckAt: number, now = Date.now()): string {
	const remainingMs = Math.max(0, nextCheckAt - now);
	const minutes = Math.floor(remainingMs / 60_000);
	const seconds = Math.floor((remainingMs % 60_000) / 1000);
	return minutes > 0 ? `${minutes}m` : `${seconds}s`;
}

function renderStatus(status: CommandStatus): string {
	const base = `/${status.command} PR #${status.prNumber} ${status.phase} (${status.progress})`;
	const mode = ` ${status.mode}`;
	const next = status.nextCheckAt
		? ` next ${formatCountdown(status.nextCheckAt)}`
		: "";
	return `${base}${mode}${next}`;
}

export default function (pi: ExtensionAPI) {
	let currentStatus: CommandStatus | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;

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

	function setCommandStatus(
		ctx: ExtensionCommandContext,
		command: "vette" | "pr",
		prContext: PrContext,
		parsed: ReturnType<typeof parseArgs>,
		options: { queued: boolean },
	): void {
		currentStatus = {
			command,
			prNumber: prContext.pr.number,
			mode:
				command === "vette"
					? prContext.isOwner
						? "owner repair"
						: "external review"
					: "prepare/watch",
			phase: options.queued ? "queued" : "working",
			progress: "1/1",
			nextCheckAt:
				command === "pr" && parsed.wantsWatch
					? Date.now() + 15 * 60_000
					: undefined,
		};
		safePublishStatus(ctx);
	}

	pi.on("agent_start", (_event, ctx) => {
		if (currentStatus && currentStatus.phase === "queued")
			currentStatus.phase = "working";
		if (currentStatus) safePublishStatus(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (currentStatus) {
			currentStatus.phase = "idle";
			currentStatus.progress = "0/0";
			currentStatus.nextCheckAt = undefined;
		}
		safePublishStatus(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		safePublishStatus(ctx);
		if (!statusTimer) {
			statusTimer = setInterval(() => safePublishStatus(ctx), 30_000);
		}
	});

	pi.on("session_shutdown", () => {
		stopStatusTimer();
	});

	pi.registerCommand("vette", {
		description:
			"PR-aware vette: owner PRs are repaired with TDD subagents; external PRs get evidence-backed review comments.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await dispatchPrompt(
				pi,
				"vette",
				args,
				ctx,
				(prContext, parsed) =>
					vettePrompt(prContext, parsed.raw, {
						wantsPosting: parsed.wantsPosting,
					}),
				(prContext, parsed, options) =>
					setCommandStatus(ctx, "vette", prContext, parsed, options),
			);
		},
	});

	pi.registerCommand("pr", {
		description:
			"Prepare, validate, vette, repair, and monitor a pull request until green or blocked.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await dispatchPrompt(
				pi,
				"pr",
				args,
				ctx,
				(prContext, parsed) =>
					prPrompt(prContext, parsed.raw, {
						wantsPosting: parsed.wantsPosting,
						wantsWatch: parsed.wantsWatch,
					}),
				(prContext, parsed, options) =>
					setCommandStatus(ctx, "pr", prContext, parsed, options),
			);
		},
	});
}
