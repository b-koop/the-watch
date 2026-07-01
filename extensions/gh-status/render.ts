import type {
	ActionableNotification,
	CheckSummary,
	GhSnapshot,
	GitHubServiceStatus,
	PullRequestActivity,
	PullRequestCheck,
	PullRequestStatus,
} from "./types.ts";

export function summarizeChecks(checks: PullRequestCheck[]): CheckSummary {
	return checks.reduce<CheckSummary>(
		(summary, check) => {
			if (check.bucket === "pass") summary.passed += 1;
			else if (check.bucket === "fail") summary.failed += 1;
			else if (check.bucket === "pending") summary.pending += 1;
			else if (check.bucket === "skipping") summary.skipped += 1;
			else if (check.bucket === "cancel") summary.cancelled += 1;
			else summary.unknown += 1;
			return summary;
		},
		{ passed: 0, failed: 0, pending: 0, skipped: 0, cancelled: 0, unknown: 0 },
	);
}

export function renderServiceStatus(service: GitHubServiceStatus): string {
	const marker =
		service.indicator === "none"
			? "✓"
			: service.indicator === "unknown"
				? "?"
				: "!";
	const stale = service.stale ? " stale" : "";
	return `GitHub: ${marker} ${service.description}${stale}`;
}

export function renderPrStatus(pr: PullRequestStatus): string {
	if (pr.kind === "no_pr") return "No PR";
	if (pr.kind === "error") return `PR: ? ${pr.message}`;

	const checks = summarizeChecks(pr.checks);
	const humanCount = pr.activities.filter((activity) => !activity.isBot).length;
	const bugBotCount = pr.activities.filter(
		(activity) => activity.botKind === "cursor-bugbot",
	).length;
	const otherBotCount = pr.activities.filter(
		(activity) => activity.isBot && activity.botKind !== "cursor-bugbot",
	).length;
	const checkText =
		checks.failed > 0
			? `✗ ${checks.failed} failing`
			: checks.pending > 0
				? `… ${checks.pending} pending`
				: "✓ checks";
	const activityText = [
		`${humanCount} human`,
		bugBotCount > 0 ? `BugBot ${bugBotCount}` : undefined,
		otherBotCount > 0 ? `Bot ${otherBotCount}` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	return `PR #${pr.number}: ${checkText}${activityText ? ` · ${activityText}` : ""}`;
}

function checkNotification(
	pr: Extract<PullRequestStatus, { kind: "pr" }>,
	check: PullRequestCheck,
): ActionableNotification | undefined {
	if (check.bucket !== "fail") return undefined;
	const suffix = check.sha ?? pr.headSha ?? "unknown-sha";
	return {
		key: `${pr.url}:check:${check.name}:${suffix}`,
		severity: "error",
		title: `PR #${pr.number} check failed`,
		message: `${check.name}${check.workflow ? ` (${check.workflow})` : ""} is failing on ${pr.branch}.`,
	};
}

function activityNotification(
	pr: Extract<PullRequestStatus, { kind: "pr" }>,
	activity: PullRequestActivity,
): ActionableNotification {
	const kind = activity.isBot ? (activity.botKind ?? "bot") : "comment";
	return {
		key: activity.key,
		severity: activity.isBot ? "warning" : "info",
		title: activity.isBot
			? `PR #${pr.number} bot alert`
			: `PR #${pr.number} new comment`,
		message: `${activity.authorLogin ?? kind}: ${activity.body.slice(0, 120)}`,
	};
}

export function deriveActionableNotifications(
	snapshot: GhSnapshot,
	seen: ReadonlySet<string>,
): ActionableNotification[] {
	const notifications: ActionableNotification[] = [];

	if (
		snapshot.service.indicator !== "none" &&
		snapshot.service.indicator !== "unknown"
	) {
		const key = `service:${snapshot.service.indicator}:${snapshot.service.updatedAt ?? snapshot.checkedAt}`;
		if (!seen.has(key)) {
			notifications.push({
				key,
				severity: "warning",
				title: "GitHub service degraded",
				message: snapshot.service.description,
			});
		}
	}

	if (snapshot.pr.kind !== "pr") return notifications;

	for (const check of snapshot.pr.checks) {
		const notification = checkNotification(snapshot.pr, check);
		if (notification && !seen.has(notification.key))
			notifications.push(notification);
	}

	for (const activity of snapshot.pr.activities) {
		if (!seen.has(activity.key))
			notifications.push(activityNotification(snapshot.pr, activity));
	}

	return notifications;
}

export function formatDiagnosticsMarkdown(snapshot: GhSnapshot): string {
	const lines = [
		"# GitHub status",
		"",
		`Checked: ${snapshot.checkedAt}`,
		`Reason: ${snapshot.reason}`,
		"",
		`Service: ${renderServiceStatus(snapshot.service)}`,
	];

	if (snapshot.repo.kind === "repo") {
		lines.push(
			`Repository: ${snapshot.repo.repo.fullName}`,
			`Branch: ${snapshot.repo.branch}`,
		);
	} else {
		lines.push(`Repository: ${snapshot.repo.message}`);
	}

	lines.push("", `Pull request: ${renderPrStatus(snapshot.pr)}`);
	if (snapshot.pr.kind === "pr") {
		const checks = summarizeChecks(snapshot.pr.checks);
		lines.push(
			`Checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending, ${checks.skipped} skipped, ${checks.cancelled} cancelled`,
		);
		for (const activity of snapshot.pr.activities.slice(0, 10)) {
			lines.push(
				`- ${activity.isBot ? "bot" : "human"}: ${activity.authorLogin ?? "unknown"} — ${activity.body.slice(0, 160)}`,
			);
		}
	}

	return `${lines.join("\n")}\n`;
}
