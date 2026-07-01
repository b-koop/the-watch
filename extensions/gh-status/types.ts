export type Result<T, E = GhStatusError> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export type RefreshReason =
	| "session_start"
	| "turn_start"
	| "turn_end"
	| "timer"
	| "command"
	| "tool";

export type GitHubRepo = {
	owner: string;
	name: string;
	fullName: string;
	remoteUrl: string;
};

export type GitResolution =
	| { kind: "repo"; repo: GitHubRepo; branch: string }
	| { kind: "not_git_repo"; message: string }
	| { kind: "not_github_repo"; message: string }
	| { kind: "detached_head"; repo: GitHubRepo; message: string }
	| { kind: "git_error"; message: string; stderr?: string };

export type GitHubStatusIndicator =
	| "none"
	| "minor"
	| "major"
	| "critical"
	| "maintenance"
	| "unknown";

export type GitHubStatusComponent = {
	name: string;
	status: string;
	updatedAt?: string;
};

export type GitHubServiceStatus = {
	indicator: GitHubStatusIndicator;
	description: string;
	updatedAt?: string;
	components: GitHubStatusComponent[];
	incidents: GitHubStatusIncident[];
	scheduledMaintenances: GitHubStatusIncident[];
	stale: boolean;
};

export type GitHubStatusIncident = {
	id?: string;
	name: string;
	status?: string;
	impact?: string;
	shortlink?: string;
	updatedAt?: string;
};

export type CheckBucket =
	| "pass"
	| "fail"
	| "pending"
	| "skipping"
	| "cancel"
	| "unknown";

export type PullRequestCheck = {
	name: string;
	workflow?: string;
	bucket: CheckBucket;
	state?: string;
	conclusion?: string;
	sha?: string;
	link?: string;
	startedAt?: string;
	completedAt?: string;
};

export type BotKind = "copilot" | "cursor-bugbot" | "github-bot" | "other-bot";

export type PullRequestActivity = {
	key: string;
	source: "comment" | "review" | "review_thread";
	authorLogin?: string;
	authorType?: string;
	body: string;
	url?: string;
	createdAt?: string;
	updatedAt?: string;
	isBot: boolean;
	botKind?: BotKind;
	botMatcher?: string;
	cursorBugBot?: CursorBugBotSignal;
};

export type CursorBugBotSignal = {
	type: "BUGBOT_FIX_IN_WEB";
	repoOwner: string;
	repoName: string;
	prNumber: number;
	branch?: string;
	commitSha?: string;
};

export type PullRequestStatus =
	| { kind: "no_pr"; branch: string; message: string }
	| { kind: "error"; branch?: string; message: string; stderr?: string }
	| {
			kind: "pr";
			number: number;
			url: string;
			branch: string;
			headSha?: string;
			baseRefName?: string;
			state?: string;
			isDraft?: boolean;
			mergeStateStatus?: string;
			reviewDecision?: string;
			checks: PullRequestCheck[];
			activities: PullRequestActivity[];
			updatedAt?: string;
	  };

export type CheckSummary = {
	passed: number;
	failed: number;
	pending: number;
	skipped: number;
	cancelled: number;
	unknown: number;
};

export type ActionableNotification = {
	key: string;
	severity: "info" | "warning" | "error";
	title: string;
	message: string;
};

export type SeenMarks = {
	version: 1;
	keys: string[];
	updatedAt: string;
};

export type GhSnapshot = {
	repo: GitResolution;
	service: GitHubServiceStatus;
	pr: PullRequestStatus;
	checkedAt: string;
	reason: RefreshReason;
};

export type GhStatusError = {
	kind:
		| "exec_failed"
		| "exec_timeout"
		| "json_parse_failed"
		| "fetch_failed"
		| "fetch_timeout"
		| "not_found"
		| "unknown";
	message: string;
	stderr?: string;
};
