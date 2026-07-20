import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type AutocompleteItem,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createWatchController } from "./watch.ts";
import { createRefreshController } from "./refresh.ts";
import type { GhSnapshot } from "./types.ts";

type FooterFactory = NonNullable<
	Parameters<ExtensionContext["ui"]["setFooter"]>[0]
>;

type SnapshotMetadata = {
	checkedAt?: string;
	reason?: GhSnapshot["reason"];
	repoKind?: GhSnapshot["repo"]["kind"];
	branch?: string;
	prKind?: GhSnapshot["pr"]["kind"];
	prNumber?: number;
	checks?: {
		total: number;
		passed: number;
		failed: number;
		pending: number;
		skipped: number;
		cancelled: number;
		unknown: number;
	};
	activities?: {
		total: number;
		human: number;
		bot: number;
		bugbot: number;
		copilot: number;
	};
};

function statusSeverity(
	text: string,
): "error" | "warning" | "success" | "muted" {
	if (text.startsWith("GitHub: ?") || text === "No PR") {
		return "muted";
	}
	if (text.includes("✗") || text.startsWith("PR: ?")) return "error";
	if (text.includes("!") || text.includes("pending")) return "warning";
	if (text.includes("✓")) return "success";
	return "muted";
}

function canFitThreeColumnFooter(input: {
	width: number;
	leftWidth: number;
	middleWidth: number;
	rightWidth: number;
}): boolean {
	const contentWidth = input.leftWidth + input.middleWidth + input.rightWidth;
	const requiredGapWidth = 2;
	return contentWidth + requiredGapWidth <= input.width;
}

const githubFooter: FooterFactory = (_tui, theme, footerData) => ({
	invalidate() {},
	render(width: number) {
		const statuses = footerData.getExtensionStatuses();
		const service = statuses.get("gh-status.service") ?? "";
		const pr = statuses.get("gh-status.pr") ?? "";
		const watch = statuses.get("watch.watch") ?? "";
		const hasFooterStatus = Boolean(service || pr || watch);
		if (!hasFooterStatus) return [];

		const left = theme.fg(statusSeverity(service), service);
		const right = theme.fg(statusSeverity(pr), pr);
		const watchStatus = watch ? theme.fg("warning", watch) : "";

		// If watch is active, show three-column layout
		if (watchStatus) {
			const leftWidth = visibleWidth(left);
			const middleWidth = visibleWidth(watchStatus);
			const rightWidth = visibleWidth(right);
			if (
				canFitThreeColumnFooter({
					width,
					leftWidth,
					middleWidth,
					rightWidth,
				})
			) {
				const leftGap = Math.max(
					1,
					Math.floor((width - leftWidth - middleWidth - rightWidth) / 2),
				);
				const rightGap = Math.max(
					1,
					width - leftWidth - leftGap - middleWidth - rightWidth,
				);
				return [
					`${left}${" ".repeat(leftGap)}${watchStatus}${" ".repeat(rightGap)}${right}`,
				];
			}

			// If it doesn't fit, prioritize PR > watch > service
			if (rightWidth >= width) return [truncateToWidth(right, width)];
			if (middleWidth + rightWidth + 1 >= width) {
				const gapWidth = Math.max(1, width - middleWidth - rightWidth);
				return [`${watchStatus}${" ".repeat(gapWidth)}${right}`];
			}

			// Try to fit left + watch + right
			const availableForLeft = Math.max(
				0,
				width - middleWidth - rightWidth - 2,
			);
			const visibleLeft = truncateToWidth(left, availableForLeft);
			const gapWidth = Math.max(
				1,
				width - visibleWidth(visibleLeft) - middleWidth - rightWidth - 1,
			);
			return [`${visibleLeft}${" ".repeat(gapWidth)}${watchStatus} ${right}`];
		}

		// Original two-column layout when no watch
		const rightWidth = visibleWidth(right);
		if (rightWidth >= width) return [truncateToWidth(right, width)];

		const availableLeftWidth = Math.max(0, width - rightWidth - 1);
		const visibleLeft = truncateToWidth(left, availableLeftWidth);
		const gapWidth = Math.max(
			1,
			width - visibleWidth(visibleLeft) - rightWidth,
		);
		return [`${visibleLeft}${" ".repeat(gapWidth)}${right}`];
	},
});

const WATCH_SUBCOMMANDS = ["start", "status", "stop", "now"] as const;

function watchDescription(
	subcommand: (typeof WATCH_SUBCOMMANDS)[number],
): string {
	switch (subcommand) {
		case "start":
			return "Start PR watch mode";
		case "status":
			return "Show watch status";
		case "stop":
			return "Stop watch mode";
		case "now":
			return "Run a watch check now";
		default: {
			const exhaustive: never = subcommand;
			return exhaustive;
		}
	}
}

function watchCompletions(prefix: string): AutocompleteItem[] | null {
	const normalized = prefix.trimStart().toLowerCase();
	const matches = WATCH_SUBCOMMANDS.flatMap((subcommand) => {
		if (!subcommand.startsWith(normalized)) return [];
		return [
			{
				value: subcommand,
				label: subcommand,
				description: watchDescription(subcommand),
			},
		];
	});
	return matches.length > 0 ? matches : null;
}

function snapshotMetadata(snapshot: GhSnapshot | undefined): SnapshotMetadata {
	if (!snapshot) return {};
	const metadata: SnapshotMetadata = {
		checkedAt: snapshot.checkedAt,
		reason: snapshot.reason,
		repoKind: snapshot.repo.kind,
		prKind: snapshot.pr.kind,
	};
	if ("branch" in snapshot.repo) metadata.branch = snapshot.repo.branch;
	if (snapshot.pr.kind !== "pr") return metadata;

	const checks = snapshot.pr.checks.reduce(
		(counts, check) => {
			counts.total += 1;
			if (check.bucket === "pass") counts.passed += 1;
			else if (check.bucket === "fail") counts.failed += 1;
			else if (check.bucket === "pending") counts.pending += 1;
			else if (check.bucket === "skipping") counts.skipped += 1;
			else if (check.bucket === "cancel") counts.cancelled += 1;
			else counts.unknown += 1;
			return counts;
		},
		{
			total: 0,
			passed: 0,
			failed: 0,
			pending: 0,
			skipped: 0,
			cancelled: 0,
			unknown: 0,
		},
	);
	const activities = snapshot.pr.activities.reduce(
		(counts, activity) => {
			counts.total += 1;
			if (activity.isBot) counts.bot += 1;
			else counts.human += 1;
			if (activity.botKind === "cursor-bugbot") counts.bugbot += 1;
			if (activity.botKind === "copilot") counts.copilot += 1;
			return counts;
		},
		{ total: 0, human: 0, bot: 0, bugbot: 0, copilot: 0 },
	);
	return {
		...metadata,
		branch: snapshot.pr.branch,
		prNumber: snapshot.pr.number,
		checks,
		activities,
	};
}

type RefreshControllerInstance = ReturnType<typeof createRefreshController>;
type WatchControllerInstance = ReturnType<typeof createWatchController>;
type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolExecute = NonNullable<ToolRegistration["execute"]>;

type PrDiagnosticsParams = {
	includeComments?: boolean;
};

function shouldIncludePrComments(params: unknown): boolean {
	return (params as PrDiagnosticsParams).includeComments !== false;
}

function registerGithubLifecycle(
	pi: ExtensionAPI,
	controller: RefreshControllerInstance,
	watchController: WatchControllerInstance,
): void {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter(githubFooter);
		controller.restore(ctx);
		controller.startTimer(ctx);
		await controller.refresh(ctx, "session_start");
	});

	// Refresh less aggressively - only on turn_end to avoid double API calls.
	// The caching logic will prevent redundant calls anyway.
	pi.on("turn_end", async (_event, ctx) => {
		void controller.refresh(ctx, "turn_end", ctx.signal).catch(() => undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		watchController.dispose();
		controller.stop();
		ctx.ui.setFooter(undefined);
	});
}

function registerGithubStatusCommands(
	pi: ExtensionAPI,
	controller: RefreshControllerInstance,
): void {
	pi.registerCommand("gh-status-refresh", {
		description: "Refresh GitHub service and current-branch PR status",
		handler: async (_args, ctx) => {
			await controller.refresh(ctx, "command", ctx.signal);
			ctx.ui.notify("GitHub status refreshed", "info");
		},
	});

	pi.registerCommand("gh-pr", {
		description: "Show current branch PR diagnostics",
		handler: async (_args, ctx) => {
			if (!controller.getSnapshot()) {
				await controller.refresh(ctx, "command", ctx.signal);
			}
			ctx.ui.notify(controller.diagnostics(), "info");
		},
	});

	pi.registerCommand("gh-status-debug", {
		description: "Show GitHub status extension debug information",
		handler: async (_args, ctx) => {
			ctx.ui.notify(controller.diagnostics(), "info");
		},
	});
}

function registerWatchCommand(
	pi: ExtensionAPI,
	watchController: WatchControllerInstance,
): void {
	pi.registerCommand("watch", {
		description:
			"Watch the current PR for blockers. Subcommands: start [--notify-only] [--local], status, stop, now.",
		getArgumentCompletions: watchCompletions,
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const flags = tokens.filter((token) => token.startsWith("--"));
			const words = tokens.filter((token) => !token.startsWith("--"));
			const [subcommand = "start"] = words;
			const notifyOnly = flags.includes("--notify-only");
			const forceLocal =
				flags.includes("--local") || flags.includes("--force-local");
			switch (subcommand.toLowerCase()) {
				case "start":
					await watchController.start(ctx, { notifyOnly, forceLocal });
					return;
				case "status":
					ctx.ui.notify(watchController.status(), "info");
					return;
				case "stop":
					watchController.stop(ctx);
					return;
				case "now":
					await watchController.runNow(ctx);
					return;
				default:
					ctx.ui.notify(
						"Usage: /watch [start [--notify-only] [--local]|status|stop|now]",
						"warning",
					);
			}
		},
	});

	pi.registerCommand("peek", {
		description:
			"Check the current PR once and queue investigation agents without starting watch mode.",
		handler: async (args, ctx) => {
			const flags = args.trim().split(/\s+/).filter(Boolean);
			const notifyOnly = flags.includes("--notify-only");
			const forceLocal =
				flags.includes("--local") || flags.includes("--force-local");
			await watchController.peek(ctx, { notifyOnly, forceLocal });
		},
	});
}

function registerGithubTools(
	pi: ExtensionAPI,
	controller: RefreshControllerInstance,
): void {
	const executeGithubStatusRefresh: ToolExecute = async (...args) => {
		const [, , signal, , ctx] = args;
		const snapshot = await controller.refresh(ctx, "tool", signal);
		return {
			content: [{ type: "text", text: controller.diagnostics() }],
			details: {
				checkedAt: snapshot.checkedAt,
				reason: snapshot.reason,
				prKind: snapshot.pr.kind,
			},
		};
	};

	const executeGithubPrDiagnostics: ToolExecute = async (...args) => {
		const [, params, signal, , ctx] = args;
		if (!controller.getSnapshot()) {
			await controller.refresh(ctx, "tool", signal);
		}
		const diagnostics = controller.diagnostics();
		const text = shouldIncludePrComments(params)
			? diagnostics
			: `${diagnostics.split("\n- ")[0]}\n`;
		return {
			content: [{ type: "text", text }],
			details: snapshotMetadata(controller.getSnapshot()),
		};
	};

	const executeGithubStatusDebug: ToolExecute = async () => ({
		content: [{ type: "text", text: controller.diagnostics() }],
		details: snapshotMetadata(controller.getSnapshot()),
	});

	pi.registerTool({
		name: "github_status_refresh",
		label: "GitHub Status Refresh",
		description:
			"Refresh GitHub service status and current-branch pull request status.",
		promptSnippet:
			"Refresh GitHub service/current-branch PR status when PR health or GitHub incidents matter.",
		parameters: Type.Object({}),
		execute: executeGithubStatusRefresh,
	});

	pi.registerTool({
		name: "github_pr_diagnostics",
		label: "GitHub PR Diagnostics",
		description:
			"Return current branch pull request diagnostics, including checks, comments, and bot alerts.",
		promptSnippet:
			"Use github_pr_diagnostics to inspect current branch PR checks, human comments, and BugBot/Copilot alerts.",
		parameters: Type.Object({
			includeComments: Type.Optional(
				Type.Boolean({
					description:
						"Include normalized comment/review excerpts in the diagnostics output.",
				}),
			),
		}),
		execute: executeGithubPrDiagnostics,
	});

	pi.registerTool({
		name: "github_status_debug",
		label: "GitHub Status Debug",
		description:
			"Show GitHub status extension debug state without forcing a refresh.",
		parameters: Type.Object({}),
		execute: executeGithubStatusDebug,
	});
}

export default function ghStatusExtension(pi: ExtensionAPI): void {
	// One bundled PR snapshot at startup, then a 15-minute shared refresh cadence.
	const controller = createRefreshController(pi, {
		intervalMs: 15 * 60_000,
		cacheWindowMs: 15 * 60_000,
		minRefreshIntervalMs: 60_000,
	});
	const watchController = createWatchController(pi, controller);

	registerGithubLifecycle(pi, controller, watchController);
	registerGithubStatusCommands(pi, controller);
	registerWatchCommand(pi, watchController);
	registerGithubTools(pi, controller);
}
