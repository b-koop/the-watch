import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { GhSnapshot, PullRequestActivity } from "./types.ts";
import type { RefreshController } from "./refresh.ts";

export const WATCH_STATUS_KEY = "the-watch.watch";
export const WATCH_CHECK_CUSTOM_TYPE = "the-watch-watch-check";
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;
const MAX_INTERVAL_MS = 15 * 60_000;

export type WatchOptions = {
	intervalMs?: number;
};

export type WatchFinding =
	| { kind: "merge-conflict"; id: string; title: string; detail?: string }
	| {
			kind: "comment";
			id: string;
			title: string;
			author?: string;
			detail?: string;
	  }
	| {
			kind: "review";
			id: string;
			title: string;
			author?: string;
			detail?: string;
	  }
	| { kind: "check"; id: string; title: string; detail?: string }
	| { kind: "bugbot"; id: string; title: string; detail?: string };

export type WatchBlockingCategory = "comment" | "pipeline" | "bugbot";

export type WatchStatusSummary = {
	footerText:
		| typeof WATCH_ACTIVE_STATUS
		| `blocking - ${WatchBlockingCategory}`;
	blockingCategory?: WatchBlockingCategory;
};

export const WATCH_ACTIVE_STATUS = "watch on";

function blockingCategoryForFinding(
	finding: WatchFinding,
): WatchBlockingCategory {
	if (finding.kind === "comment" || finding.kind === "review") return "comment";
	if (finding.kind === "bugbot") return "bugbot";
	return "pipeline";
}

export function deriveWatchStatus(
	findings: readonly WatchFinding[],
): WatchStatusSummary {
	const categories = new Set<WatchBlockingCategory>(
		findings.map(blockingCategoryForFinding),
	);
	let blockingCategory: WatchBlockingCategory | undefined;
	if (categories.has("pipeline")) {
		blockingCategory = "pipeline";
	} else if (categories.has("comment")) {
		blockingCategory = "comment";
	} else if (categories.has("bugbot")) {
		blockingCategory = "bugbot";
	} else {
		blockingCategory = undefined;
	}

	return blockingCategory
		? { footerText: `blocking - ${blockingCategory}`, blockingCategory }
		: { footerText: WATCH_ACTIVE_STATUS };
}

function formatWatchNotification(
	findings: readonly WatchFinding[],
	status: WatchStatusSummary,
): string {
	const itemText = `${findings.length} new item${findings.length === 1 ? "" : "s"}`;
	const statusText = status.blockingCategory
		? status.footerText
		: WATCH_ACTIVE_STATUS;
	return `Watch detected ${itemText}: ${statusText}; investigation queued.`;
}

type WatchCheckTrigger = "timer" | "manual";

type WatchCheckLog = {
	version: 1;
	checkedAt: string;
	trigger: WatchCheckTrigger;
	prNumber?: number;
	prState?: string;
	totalFindings: number;
	newFindings: number;
	blockingCategory?: WatchBlockingCategory;
	agentsQueued: number;
	investigationTurnsQueued: number;
	checks: {
		passed: number;
		failed: number;
		pending: number;
		skipped: number;
		cancelled: number;
		unknown: number;
	};
	activities: {
		total: number;
		human: number;
		bot: number;
		bugbot: number;
	};
	findingsByKind: Record<WatchFinding["kind"], number>;
};

type OpenPullRequest = Extract<GhSnapshot["pr"], { kind: "pr" }>;
type CheckCounts = WatchCheckLog["checks"];
type ActivityCounts = WatchCheckLog["activities"];

type BuildCheckLogInput = {
	snapshot: GhSnapshot;
	trigger: WatchCheckTrigger;
	currentFindings: readonly WatchFinding[];
	newFindings: readonly WatchFinding[];
	status: WatchStatusSummary;
};

type QueueWatchInvestigationInput = {
	pi: ExtensionAPI;
	ctx: WatchTickContext;
	snapshot: GhSnapshot;
	findings: readonly WatchFinding[];
	status: WatchStatusSummary;
};

type WatchState = {
	running: boolean;
	timer: ReturnType<typeof setInterval> | undefined;
	intervalMs: number;
	seen: Set<string>;
	inFlight: boolean;
	runId: number;
	lastSnapshot?: GhSnapshot;
};

type WatchTickContext = ExtensionContext & {
	signal: AbortSignal | undefined;
};

type WatchUiContext = Pick<ExtensionContext, "ui">;

function clampInterval(value: number | undefined): number {
	if (!Number.isFinite(value ?? Number.NaN)) return DEFAULT_INTERVAL_MS;
	return Math.max(
		MIN_INTERVAL_MS,
		Math.min(MAX_INTERVAL_MS, Math.round(value ?? DEFAULT_INTERVAL_MS)),
	);
}

function describeInterval(ms: number): string {
	return `${Math.round(ms / 60_000)}m`;
}

function isOpen(snapshot: GhSnapshot): boolean {
	return (
		snapshot.pr.kind === "pr" &&
		(snapshot.pr.state ?? "OPEN").toUpperCase() === "OPEN"
	);
}

function mergeConflictFinding(snapshot: GhSnapshot): WatchFinding | undefined {
	if (snapshot.pr.kind !== "pr") return undefined;
	const status = `${snapshot.pr.mergeStateStatus ?? ""}`.toUpperCase();
	if (!status) return undefined;
	if (!/DIRTY|UNMERGEABLE|BEHIND/.test(status)) return undefined;
	return {
		kind: "merge-conflict",
		id: `merge:${snapshot.pr.url}:${status}`,
		title: `merge state ${status.toLowerCase()}`,
		detail: `GitHub reports mergeStateStatus=${snapshot.pr.mergeStateStatus ?? "unknown"}.`,
	};
}

function classifyActivity(
	activity: PullRequestActivity,
): "comment" | "review" | "bugbot" {
	if (activity.botKind === "cursor-bugbot") return "bugbot";
	if (activity.source === "review") return "review";
	return "comment";
}

function checkFinding(
	pr: OpenPullRequest,
	check: OpenPullRequest["checks"][number],
): WatchFinding | undefined {
	if (check.bucket !== "fail") return undefined;
	return {
		kind: "check",
		id: `check:${pr.url}:${check.name}:${check.sha ?? pr.headSha ?? "unknown"}`,
		title: `${check.name}${check.workflow ? ` (${check.workflow})` : ""}`,
		detail: `${check.bucket}${check.conclusion ? `/${check.conclusion}` : ""}`,
	};
}

function activityFinding(activity: PullRequestActivity): WatchFinding {
	const kind = classifyActivity(activity);
	const body = activity.body ?? "";
	const firstLine = body.split("\n")[0] ?? "";
	return {
		kind,
		id: activity.key,
		title: firstLine.slice(0, 120) || "new activity",
		...(activity.authorLogin ? { author: activity.authorLogin } : {}),
		...(body ? { detail: body } : {}),
	};
}

function collectCheckFindings(
	pr: OpenPullRequest,
	seen: ReadonlySet<string>,
): WatchFinding[] {
	return pr.checks.flatMap((check) => {
		const finding = checkFinding(pr, check);
		return finding && !seen.has(finding.id) ? [finding] : [];
	});
}

function collectActivityFindings(
	pr: OpenPullRequest,
	seen: ReadonlySet<string>,
): WatchFinding[] {
	return pr.activities.flatMap((activity) =>
		seen.has(activity.key) ? [] : [activityFinding(activity)],
	);
}

function collectFindings(
	snapshot: GhSnapshot,
	seen: ReadonlySet<string>,
): WatchFinding[] {
	const mergeConflict = mergeConflictFinding(snapshot);
	const mergeFindings =
		mergeConflict && !seen.has(mergeConflict.id) ? [mergeConflict] : [];
	if (snapshot.pr.kind !== "pr") return mergeFindings;
	return [
		...mergeFindings,
		...collectCheckFindings(snapshot.pr, seen),
		...collectActivityFindings(snapshot.pr, seen),
	];
}

function formatPrompt(snapshot: GhSnapshot, findings: WatchFinding[]): string {
	const lines = [
		`Watch detected new PR items for ${snapshot.pr.kind === "pr" ? `PR #${snapshot.pr.number}` : "the current branch"}.`,
		``,
		`Priority order:`,
		`1. Resolve merge conflicts first.`,
		`2. Resolve user comments / review feedback next.`,
		`3. Investigate pipeline failures and determine whether they are related to the branch changes; treat uncertain as related.`,
		`4. Handle BugBot items when they appear; they remain lower priority than merge conflicts, human feedback, and pipeline failures when multiple findings are present.`,
		``,
		`Findings:`,
		...findings.map((finding) => {
			const author =
				"author" in finding && finding.author ? ` @${finding.author}` : "";
			const detail =
				typeof finding.detail === "string"
					? ` — ${finding.detail.slice(0, 240)}`
					: "";
			return `- ${finding.kind}: ${finding.title}${author}${detail}`;
		}),
		``,
		`Use TDD for any fix path: write the smallest failing test first, make the smallest code change, then run the focused verification.`,
		`If reference-app behavior matters, use the nlm CLI to inspect it before changing code.`,
		`Spawn focused subagents only for the new items above.`,
	];

	return `${lines.join("\n")}\n`;
}

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/ctx is stale|stale after session replacement|after await ctx\.reload/i.test(
			error.message,
		)
	);
}

function ignoreOnlyStaleContext(error: unknown): void {
	if (!isStaleContextError(error)) throw error;
}

function notifyWatchUi(
	ctx: WatchUiContext,
	message: string,
	severity: Parameters<WatchUiContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(message, severity);
	} catch (error) {
		ignoreOnlyStaleContext(error);
	}
}

function updateStatus(ctx: WatchUiContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus(WATCH_STATUS_KEY, text);
	} catch (error) {
		ignoreOnlyStaleContext(error);
	}
}

function emptyFindingsByKind(): Record<WatchFinding["kind"], number> {
	return {
		"merge-conflict": 0,
		comment: 0,
		review: 0,
		check: 0,
		bugbot: 0,
	};
}

function countFindingsByKind(
	findings: readonly WatchFinding[],
): Record<WatchFinding["kind"], number> {
	const findingsByKind = emptyFindingsByKind();
	for (const finding of findings) findingsByKind[finding.kind] += 1;
	return findingsByKind;
}

const CHECK_BUCKET_COUNTS: Partial<Record<string, keyof CheckCounts>> = {
	pass: "passed",
	fail: "failed",
	pending: "pending",
	skipping: "skipped",
	cancel: "cancelled",
};

function countChecks(pr: OpenPullRequest): CheckCounts {
	const counts = emptyCheckCounts();
	for (const check of pr.checks) {
		const key = CHECK_BUCKET_COUNTS[check.bucket ?? ""] ?? "unknown";
		counts[key] += 1;
	}
	return counts;
}

function countActivities(pr: OpenPullRequest): ActivityCounts {
	const counts: ActivityCounts = { total: 0, human: 0, bot: 0, bugbot: 0 };
	for (const activity of pr.activities) {
		counts.total += 1;
		if (activity.isBot) counts.bot += 1;
		else counts.human += 1;
		if (activity.botKind === "cursor-bugbot") counts.bugbot += 1;
	}
	return counts;
}

function emptyCheckCounts(): CheckCounts {
	return {
		passed: 0,
		failed: 0,
		pending: 0,
		skipped: 0,
		cancelled: 0,
		unknown: 0,
	};
}

function emptyActivityCounts(): ActivityCounts {
	return { total: 0, human: 0, bot: 0, bugbot: 0 };
}

function baseCheckLog(
	input: BuildCheckLogInput,
): Omit<WatchCheckLog, "checks" | "activities" | "findingsByKind"> {
	const { snapshot, trigger, currentFindings, newFindings, status } = input;
	const investigationTurnsQueued = newFindings.length > 0 ? 1 : 0;
	return {
		version: 1,
		checkedAt: snapshot.checkedAt,
		trigger,
		totalFindings: currentFindings.length,
		newFindings: newFindings.length,
		...(status.blockingCategory
			? { blockingCategory: status.blockingCategory }
			: {}),
		agentsQueued: investigationTurnsQueued,
		investigationTurnsQueued,
	};
}

function buildCheckLog(input: BuildCheckLogInput): WatchCheckLog {
	const { snapshot, currentFindings } = input;
	const shared = {
		...baseCheckLog(input),
		findingsByKind: countFindingsByKind(currentFindings),
	};
	if (snapshot.pr.kind !== "pr") {
		return {
			...shared,
			checks: emptyCheckCounts(),
			activities: emptyActivityCounts(),
		};
	}
	return {
		...shared,
		prNumber: snapshot.pr.number,
		prState: snapshot.pr.state ?? "OPEN",
		checks: countChecks(snapshot.pr),
		activities: countActivities(snapshot.pr),
	};
}

function beginTick(state: WatchState): number | undefined {
	if (!state.running || state.inFlight) return undefined;
	state.inFlight = true;
	return state.runId;
}

function isCurrentTick(state: WatchState, runId: number): boolean {
	return state.running && state.runId === runId;
}

function finishTick(state: WatchState, runId: number): void {
	if (state.runId === runId) state.inFlight = false;
}

function closedSnapshotReason(snapshot: GhSnapshot): string {
	if (snapshot.pr.kind === "pr" && snapshot.pr.state) {
		return `PR is ${snapshot.pr.state.toLowerCase()}`;
	}
	return "PR is closed";
}

function unseenFindings(
	findings: readonly WatchFinding[],
	seen: ReadonlySet<string>,
): WatchFinding[] {
	return findings.filter((finding) => !seen.has(finding.id));
}

function rememberFindings(
	seen: Set<string>,
	findings: readonly WatchFinding[],
): void {
	for (const finding of findings) seen.add(finding.id);
}

function appendWatchCheck(pi: ExtensionAPI, input: BuildCheckLogInput): void {
	pi.appendEntry<WatchCheckLog>(WATCH_CHECK_CUSTOM_TYPE, buildCheckLog(input));
}

function queueWatchInvestigation(input: QueueWatchInvestigationInput): void {
	const { pi, ctx, snapshot, findings, status } = input;
	notifyWatchUi(ctx, formatWatchNotification(findings, status), "warning");
	pi.sendMessage(
		{
			customType: "the-watch-watch-trigger",
			content: formatPrompt(snapshot, [...findings]),
			display: true,
		},
		{ triggerTurn: true },
	);
}

function notifyRefreshFailure(ctx: WatchTickContext, error: unknown): void {
	notifyWatchUi(
		ctx,
		`Watch refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		"error",
	);
}

type WatchRuntime = {
	pi: ExtensionAPI;
	refreshController: RefreshController;
	state: WatchState;
};

async function runWatchTick(
	runtime: WatchRuntime,
	ctx: WatchTickContext,
	trigger: WatchCheckTrigger = "timer",
): Promise<boolean> {
	const { pi, refreshController, state } = runtime;
	const runId = beginTick(state);
	if (runId === undefined) return false;
	try {
		const snapshot = await refreshController.refresh(ctx, "timer", ctx.signal);
		if (!isCurrentTick(state, runId)) return false;
		state.lastSnapshot = snapshot;
		if (!isOpen(snapshot)) {
			stopWatch(runtime, ctx, closedSnapshotReason(snapshot));
			return false;
		}

		const currentFindings = collectFindings(snapshot, new Set<string>());
		const watchStatus = deriveWatchStatus(currentFindings);
		updateStatus(ctx, watchStatus.footerText);

		const findings = unseenFindings(currentFindings, state.seen);
		appendWatchCheck(pi, {
			snapshot,
			trigger,
			currentFindings,
			newFindings: findings,
			status: watchStatus,
		});
		if (findings.length === 0) return true;

		rememberFindings(state.seen, findings);
		queueWatchInvestigation({
			pi,
			ctx,
			snapshot,
			findings,
			status: watchStatus,
		});
		return true;
	} catch (error) {
		if (isCurrentTick(state, runId)) notifyRefreshFailure(ctx, error);
		return false;
	} finally {
		finishTick(state, runId);
	}
}

function scheduleWatch(runtime: WatchRuntime, ctx: WatchTickContext): void {
	const { state } = runtime;
	if (state.timer) clearInterval(state.timer);
	state.timer = setInterval(() => {
		void runWatchTick(runtime, ctx);
	}, state.intervalMs);
	state.timer.unref?.();
}

function initializeWatchState(
	state: WatchState,
	snapshot: GhSnapshot,
	options: WatchOptions,
): void {
	state.intervalMs = clampInterval(options.intervalMs);
	state.running = true;
	state.inFlight = false;
	state.runId += 1;
	state.seen.clear();
	state.lastSnapshot = snapshot;
}

function notifyWatchStarted(ctx: WatchTickContext, state: WatchState): void {
	updateStatus(ctx, WATCH_ACTIVE_STATUS);
	notifyWatchUi(
		ctx,
		`Watch started (every ${describeInterval(state.intervalMs)}); performing initial sweep of all PR items.`,
		"info",
	);
}

function notifyInitialSweep(
	ctx: WatchTickContext,
	state: WatchState,
	snapshot: GhSnapshot,
): void {
	const currentFindings = collectFindings(snapshot, new Set<string>());
	notifyWatchUi(
		ctx,
		`Initial sweep complete: found ${currentFindings.length} item${currentFindings.length === 1 ? "" : "s"} to investigate. Now monitoring for changes every ${describeInterval(state.intervalMs)}.`,
		"info",
	);
}

async function startWatch(
	runtime: WatchRuntime,
	ctx: WatchTickContext,
	options: WatchOptions = {},
): Promise<boolean> {
	const { refreshController, state } = runtime;
	if (state.running) {
		notifyWatchUi(
			ctx,
			"Watch is already on. Use /watch status or /watch stop.",
			"warning",
		);
		return false;
	}

	const snapshot = refreshController.getSnapshot();
	if (!snapshot || !isOpen(snapshot)) {
		notifyWatchUi(
			ctx,
			"Watch requires an open PR snapshot. Refresh GitHub status first.",
			"error",
		);
		return false;
	}

	initializeWatchState(state, snapshot, options);
	notifyWatchStarted(ctx, state);

	const initialCheck = await runWatchTick(runtime, ctx, "manual");
	if (!state.running) return true;
	scheduleWatch(runtime, ctx);
	if (initialCheck) notifyInitialSweep(ctx, state, snapshot);
	return true;
}

async function runWatchNow(
	runtime: WatchRuntime,
	ctx: WatchTickContext,
): Promise<boolean> {
	const { state } = runtime;
	if (!state.running) {
		notifyWatchUi(
			ctx,
			"Watch is not on. Start it with /watch first.",
			"warning",
		);
		return false;
	}
	if (state.inFlight) {
		notifyWatchUi(ctx, "Watch is already checking now.", "warning");
		return false;
	}

	const checked = await runWatchTick(runtime, ctx, "manual");
	if (state.running) scheduleWatch(runtime, ctx);
	if (checked && state.running) {
		notifyWatchUi(
			ctx,
			`Watch checked now; next automatic check in ${describeInterval(state.intervalMs)}.`,
			"info",
		);
	}
	return checked;
}

function stopWatch(
	runtime: Pick<WatchRuntime, "state">,
	ctx: WatchUiContext,
	reason = "stopped",
): void {
	const { state } = runtime;
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
	state.running = false;
	state.inFlight = false;
	state.runId += 1;
	updateStatus(ctx, undefined);
	notifyWatchUi(ctx, `Watch stopped: ${reason}`, "info");
}

function watchStatus(state: WatchState): string {
	if (!state.running) return "Watch is not running.";
	return `Watch running every ${describeInterval(state.intervalMs)}${state.lastSnapshot?.pr.kind === "pr" ? ` for PR #${state.lastSnapshot.pr.number}` : ""}.`;
}

export function createWatchController(
	pi: ExtensionAPI,
	refreshController: RefreshController,
) {
	const state: WatchState = {
		running: false,
		timer: undefined,
		intervalMs: DEFAULT_INTERVAL_MS,
		seen: new Set<string>(),
		inFlight: false,
		runId: 0,
	};
	const runtime: WatchRuntime = { pi, refreshController, state };

	return {
		start: (ctx: WatchTickContext, options?: WatchOptions) =>
			startWatch(runtime, ctx, options),
		runNow: (ctx: WatchTickContext) => runWatchNow(runtime, ctx),
		stop: (ctx: WatchUiContext, reason?: string) =>
			stopWatch(runtime, ctx, reason),
		dispose: () => {
			if (state.timer) clearInterval(state.timer);
			state.timer = undefined;
			state.running = false;
			state.inFlight = false;
			state.runId += 1;
		},
		status: () => watchStatus(state),
		isRunning: () => state.running,
		getLastSnapshot: () => state.lastSnapshot,
	};
}
