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

function mergeConflictFinding(
	snapshot: GhSnapshot,
): WatchFinding | undefined {
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

function collectFindings(
	snapshot: GhSnapshot,
	seen: ReadonlySet<string>,
): WatchFinding[] {
	const findings: WatchFinding[] = [];

	const mergeConflict = mergeConflictFinding(snapshot);
	if (mergeConflict && !seen.has(mergeConflict.id))
		findings.push(mergeConflict);

	if (snapshot.pr.kind === "pr") {
		for (const check of snapshot.pr.checks) {
			if (check.bucket !== "fail") continue;
			const id = `check:${snapshot.pr.url}:${check.name}:${check.sha ?? snapshot.pr.headSha ?? "unknown"}`;
			if (seen.has(id)) continue;
			findings.push({
				kind: "check",
				id,
				title: `${check.name}${check.workflow ? ` (${check.workflow})` : ""}`,
				detail: `${check.bucket}${check.conclusion ? `/${check.conclusion}` : ""}`,
			});
		}

		for (const activity of snapshot.pr.activities) {
			if (seen.has(activity.key)) continue;
			const kind = classifyActivity(activity);
			const body = activity.body ?? "";
			const firstLine = body.split("\n")[0] ?? "";
			findings.push({
				kind,
				id: activity.key,
				title: firstLine.slice(0, 120) || "new activity",
				...(activity.authorLogin ? { author: activity.authorLogin } : {}),
				...(body ? { detail: body } : {}),
			});
		}
	}

	return findings;
}

function formatPrompt(
	snapshot: GhSnapshot,
	findings: WatchFinding[],
): string {
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

function updateStatus(ctx: WatchUiContext, text: string | undefined): void {
	ctx.ui.setStatus(WATCH_STATUS_KEY, text);
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

function buildCheckLog(
	snapshot: GhSnapshot,
	trigger: WatchCheckTrigger,
	currentFindings: readonly WatchFinding[],
	newFindings: readonly WatchFinding[],
	status: WatchStatusSummary,
): WatchCheckLog {
	const findingsByKind = emptyFindingsByKind();
	for (const finding of currentFindings) findingsByKind[finding.kind] += 1;

	const checks = {
		passed: 0,
		failed: 0,
		pending: 0,
		skipped: 0,
		cancelled: 0,
		unknown: 0,
	};
	const activities = { total: 0, human: 0, bot: 0, bugbot: 0 };
	if (snapshot.pr.kind === "pr") {
		for (const check of snapshot.pr.checks) {
			if (check.bucket === "pass") checks.passed += 1;
			else if (check.bucket === "fail") checks.failed += 1;
			else if (check.bucket === "pending") checks.pending += 1;
			else if (check.bucket === "skipping") checks.skipped += 1;
			else if (check.bucket === "cancel") checks.cancelled += 1;
			else checks.unknown += 1;
		}
		for (const activity of snapshot.pr.activities) {
			activities.total += 1;
			if (activity.isBot) activities.bot += 1;
			else activities.human += 1;
			if (activity.botKind === "cursor-bugbot") activities.bugbot += 1;
		}
	}

	const investigationTurnsQueued = newFindings.length > 0 ? 1 : 0;
	return {
		version: 1,
		checkedAt: snapshot.checkedAt,
		trigger,
		...(snapshot.pr.kind === "pr"
			? {
					prNumber: snapshot.pr.number,
					prState: snapshot.pr.state ?? "OPEN",
				}
			: {}),
		totalFindings: currentFindings.length,
		newFindings: newFindings.length,
		...(status.blockingCategory
			? { blockingCategory: status.blockingCategory }
			: {}),
		agentsQueued: investigationTurnsQueued,
		investigationTurnsQueued,
		checks,
		activities,
		findingsByKind,
	};
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

	async function tick(
		ctx: WatchTickContext,
		trigger: WatchCheckTrigger = "timer",
	): Promise<boolean> {
		if (!state.running || state.inFlight) return false;
		const runId = state.runId;
		state.inFlight = true;
		try {
			const snapshot = await refreshController.refresh(
				ctx,
				"timer",
				ctx.signal,
			);
			if (!state.running || state.runId !== runId) return false;
			state.lastSnapshot = snapshot;
			if (!isOpen(snapshot)) {
				stop(
					ctx,
					snapshot.pr.kind === "pr" && snapshot.pr.state
						? `PR is ${snapshot.pr.state.toLowerCase()}`
						: "PR is closed",
				);
				return false;
			}

			const currentFindings = collectFindings(snapshot, new Set<string>());
			const watchStatus = deriveWatchStatus(currentFindings);
			updateStatus(ctx, watchStatus.footerText);

			const findings = currentFindings.filter(
				(finding) => !state.seen.has(finding.id),
			);
			pi.appendEntry<WatchCheckLog>(
				WATCH_CHECK_CUSTOM_TYPE,
				buildCheckLog(
					snapshot,
					trigger,
					currentFindings,
					findings,
					watchStatus,
				),
			);
			if (findings.length === 0) return true;

			for (const finding of findings) state.seen.add(finding.id);
			ctx.ui.notify(
				formatWatchNotification(findings, watchStatus),
				"warning",
			);
			pi.sendMessage(
				{
					customType: "the-watch-watch-trigger",
					content: formatPrompt(snapshot, findings),
					display: true,
				},
				{ triggerTurn: true },
			);
			return true;
		} catch (error) {
			if (state.running && state.runId === runId) {
				ctx.ui.notify(
					`Watch refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return false;
		} finally {
			if (state.runId === runId) state.inFlight = false;
		}
	}

	function schedule(ctx: WatchTickContext): void {
		if (state.timer) clearInterval(state.timer);
		state.timer = setInterval(() => {
			void tick(ctx);
		}, state.intervalMs);
		state.timer.unref?.();
	}

	async function start(
		ctx: WatchTickContext,
		options: WatchOptions = {},
	): Promise<boolean> {
		if (state.running) {
			ctx.ui.notify(
				"Watch is already on. Use /watch status or /watch stop.",
				"warning",
			);
			return false;
		}

		const snapshot = refreshController.getSnapshot();
		if (!snapshot || !isOpen(snapshot)) {
			ctx.ui.notify(
				"Watch requires an open PR snapshot. Refresh GitHub status first.",
				"error",
			);
			return false;
		}

		state.intervalMs = clampInterval(options.intervalMs);
		state.running = true;
		state.inFlight = false;
		state.runId += 1;
		state.seen.clear(); // Start with empty seen set - investigate everything!
		state.lastSnapshot = snapshot;

		// DON'T mark existing findings as seen - we want to investigate them all
		updateStatus(ctx, WATCH_ACTIVE_STATUS);
		ctx.ui.notify(
			`Watch started (every ${describeInterval(state.intervalMs)}); performing initial sweep of all PR items.`,
			"info",
		);

		// Do immediate check to investigate ALL current findings
		const initialCheck = await tick(ctx, "manual");
		if (state.running) {
			// After initial sweep, start timer for delta monitoring
			schedule(ctx);
			if (initialCheck) {
				const currentFindings = collectFindings(snapshot, new Set<string>());
				ctx.ui.notify(
					`Initial sweep complete: found ${currentFindings.length} item${currentFindings.length === 1 ? "" : "s"} to investigate. Now monitoring for changes every ${describeInterval(state.intervalMs)}.`,
					"info",
				);
			}
		}
		return true;
	}

	async function runNow(ctx: WatchTickContext): Promise<boolean> {
		if (!state.running) {
			ctx.ui.notify(
				"Watch is not on. Start it with /watch first.",
				"warning",
			);
			return false;
		}
		if (state.inFlight) {
			ctx.ui.notify("Watch is already checking now.", "warning");
			return false;
		}

		const checked = await tick(ctx, "manual");
		if (state.running) schedule(ctx);
		if (checked && state.running) {
			ctx.ui.notify(
				`Watch checked now; next automatic check in ${describeInterval(state.intervalMs)}.`,
				"info",
			);
		}
		return checked;
	}

	function stop(ctx: WatchUiContext, reason = "stopped"): void {
		if (state.timer) clearInterval(state.timer);
		state.timer = undefined;
		state.running = false;
		state.inFlight = false;
		state.runId += 1;
		updateStatus(ctx, undefined);
		ctx.ui.notify(`Watch stopped: ${reason}`, "info");
	}

	function status(): string {
		if (!state.running) return "Watch is not running.";
		return `Watch running every ${describeInterval(state.intervalMs)}${state.lastSnapshot?.pr.kind === "pr" ? ` for PR #${state.lastSnapshot.pr.number}` : ""}.`;
	}

	return {
		start,
		runNow,
		stop,
		status,
		isRunning: () => state.running,
		getLastSnapshot: () => state.lastSnapshot,
	};
}
