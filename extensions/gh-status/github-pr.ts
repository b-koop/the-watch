import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyBotActivity } from "./bugbot.ts";
import type {
	CheckBucket,
	GhStatusError,
	GitHubRepo,
	PullRequestActivity,
	PullRequestCheck,
	PullRequestStatus,
	Result,
} from "./types.ts";

type Exec = ExtensionAPI["exec"];

type GhPrView = {
	number?: number;
	url?: string;
	state?: string;
	isDraft?: boolean;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
	mergeStateStatus?: string;
	reviewDecision?: string;
	updatedAt?: string;
	comments?: GhActivity[];
	reviews?: GhActivity[];
	latestReviews?: GhActivity[];
	statusCheckRollup?: GhCheckRollup[];
};

type GhActivity = {
	id?: string;
	databaseId?: number;
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
	link?: string;
	detailsUrl?: string;
	startedAt?: string;
	completedAt?: string;
	commit?: { oid?: string };
};

function stableTextHash(value: string): string {
	let hash = 0x811c9dc5;
	for (const char of value) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

function activityIdentity(activity: GhActivity): string {
	if (activity.id) return `node:${activity.id}`;
	if (typeof activity.databaseId === "number")
		return `database:${activity.databaseId}`;
	if (activity.url) return `url:${activity.url}`;
	if (activity.createdAt) return `created:${activity.createdAt}`;
	if (activity.submittedAt) return `submitted:${activity.submittedAt}`;
	if (activity.updatedAt) return `updated:${activity.updatedAt}`;
	return `body:${stableTextHash(`${activity.author?.login ?? "unknown"}\n${activity.body ?? ""}`)}`;
}

export function bucketFromCheck(check: GhCheckRollup): CheckBucket {
	const bucket = check.bucket?.toLowerCase();
	if (
		bucket === "pass" ||
		bucket === "fail" ||
		bucket === "pending" ||
		bucket === "skipping" ||
		bucket === "cancel"
	) {
		return bucket;
	}

	const conclusion = check.conclusion?.toLowerCase();
	if (conclusion === "success" || conclusion === "neutral") return "pass";
	if (
		conclusion === "failure" ||
		conclusion === "timed_out" ||
		conclusion === "action_required"
	)
		return "fail";
	if (conclusion === "cancelled") return "cancel";
	if (conclusion === "skipped") return "skipping";

	const state = check.state?.toLowerCase() ?? check.status?.toLowerCase();
	if (state === "success" || state === "completed") return "pass";
	if (state === "failure" || state === "error") return "fail";
	if (
		state === "pending" ||
		state === "queued" ||
		state === "in_progress" ||
		state === "waiting"
	)
		return "pending";
	if (state === "cancelled" || state === "cancel") return "cancel";
	if (state === "skipped" || state === "skipping") return "skipping";

	return "unknown";
}

export function normalizeChecks(
	checks: GhCheckRollup[] | undefined,
	headSha: string | undefined,
): PullRequestCheck[] {
	return (checks ?? [])
		.map((check) => {
			const sha = check.commit?.oid;
			return {
				name: check.name ?? check.workflowName ?? "Unnamed check",
				...((check.workflowName ?? check.workflow)
					? { workflow: check.workflowName ?? check.workflow }
					: {}),
				bucket: bucketFromCheck(check),
				...(check.state ? { state: check.state } : {}),
				...(check.conclusion ? { conclusion: check.conclusion } : {}),
				...(sha ? { sha } : {}),
				...((check.link ?? check.detailsUrl)
					? { link: check.link ?? check.detailsUrl }
					: {}),
				...(check.startedAt ? { startedAt: check.startedAt } : {}),
				...(check.completedAt ? { completedAt: check.completedAt } : {}),
			} satisfies PullRequestCheck;
		})
		.filter((check) => !headSha || !check.sha || check.sha === headSha);
}

function activityKey(
	repo: GitHubRepo,
	prNumber: number,
	source: PullRequestActivity["source"],
	activity: GhActivity,
): string {
	return `${repo.fullName}:${prNumber}:${source}:${activityIdentity(activity)}`;
}

function normalizeActivity(
	repo: GitHubRepo,
	prNumber: number,
	source: PullRequestActivity["source"],
	activity: GhActivity,
): PullRequestActivity {
	const body = activity.body ?? "";
	const bot = classifyBotActivity(activity.author, body);
	const authorType = activity.author?.type ?? activity.author?.__typename;
	const createdAt = activity.createdAt ?? activity.submittedAt;

	return {
		key: activityKey(repo, prNumber, source, activity),
		source,
		...(activity.author?.login ? { authorLogin: activity.author.login } : {}),
		...(authorType ? { authorType } : {}),
		body,
		...(activity.url ? { url: activity.url } : {}),
		...(createdAt ? { createdAt } : {}),
		...(activity.updatedAt ? { updatedAt: activity.updatedAt } : {}),
		...bot,
	};
}

export function normalizeActivities(
	repo: GitHubRepo,
	prNumber: number,
	view: GhPrView,
): PullRequestActivity[] {
	const activities = [
		...(view.comments ?? []).map((activity) =>
			normalizeActivity(repo, prNumber, "comment", activity),
		),
		...(view.reviews ?? []).map((activity) =>
			normalizeActivity(repo, prNumber, "review", activity),
		),
		...(view.latestReviews ?? []).map((activity) =>
			normalizeActivity(repo, prNumber, "review", activity),
		),
	];
	return [
		...new Map(activities.map((activity) => [activity.key, activity])).values(),
	];
}

export function normalizePullRequestView(
	repo: GitHubRepo,
	branch: string,
	view: GhPrView,
): PullRequestStatus {
	if (!view.number || !view.url) {
		return {
			kind: "no_pr",
			branch,
			message: `No pull request found for branch ${branch}.`,
		};
	}

	return {
		kind: "pr",
		number: view.number,
		url: view.url,
		branch,
		...(view.headRefOid ? { headSha: view.headRefOid } : {}),
		...(view.baseRefName ? { baseRefName: view.baseRefName } : {}),
		...(view.state ? { state: view.state } : {}),
		...(typeof view.isDraft === "boolean" ? { isDraft: view.isDraft } : {}),
		...(view.mergeStateStatus
			? { mergeStateStatus: view.mergeStateStatus }
			: {}),
		...(view.reviewDecision ? { reviewDecision: view.reviewDecision } : {}),
		checks: normalizeChecks(view.statusCheckRollup, view.headRefOid),
		activities: normalizeActivities(repo, view.number, view),
		...(view.updatedAt ? { updatedAt: view.updatedAt } : {}),
	};
}

export async function fetchCurrentBranchPr(
	exec: Exec,
	cwd: string,
	repo: GitHubRepo,
	branch: string,
	signal?: AbortSignal,
): Promise<Result<PullRequestStatus>> {
	const fields = [
		"number",
		"url",
		"state",
		"isDraft",
		"headRefName",
		"headRefOid",
		"baseRefName",
		"mergeStateStatus",
		"reviewDecision",
		"updatedAt",
		"comments",
		"reviews",
		"latestReviews",
		"statusCheckRollup",
	].join(",");
	const execOptions = { cwd, timeout: 15_000, ...(signal ? { signal } : {}) };

	const result = await exec(
		"gh",
		["pr", "view", branch, "--repo", repo.fullName, "--json", fields],
		execOptions,
	);
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		if (
			/no pull requests? found/i.test(stderr) ||
			/pull request .*not found/i.test(stderr)
		) {
			return {
				ok: true,
				value: {
					kind: "no_pr",
					branch,
					message: `No pull request found for branch ${branch}.`,
				},
			};
		}

		const error: GhStatusError = {
			kind: result.killed ? "exec_timeout" : "exec_failed",
			message: stderr || `gh pr view exited with code ${result.code}.`,
			...(stderr ? { stderr } : {}),
		};
		return { ok: false, error };
	}

	try {
		const view = JSON.parse(result.stdout) as GhPrView;
		return { ok: true, value: normalizePullRequestView(repo, branch, view) };
	} catch {
		return {
			ok: false,
			error: {
				kind: "json_parse_failed",
				message: "Failed to parse gh pr view JSON output.",
			},
		};
	}
}
