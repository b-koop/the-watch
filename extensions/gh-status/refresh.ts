import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveGitHubRepo } from "./git.ts";
import { fetchCurrentBranchPr } from "./github-pr.ts";
import {
	fetchGitHubServiceStatus,
	unknownServiceStatus,
} from "./github-status.ts";
import { markSeen, restoreSeenMarks } from "./persistence.ts";
import {
	deriveActionableNotifications,
	formatDiagnosticsMarkdown,
	renderPrStatus,
	renderServiceStatus,
} from "./render.ts";
import type {
	GhSnapshot,
	GitHubServiceStatus,
	PullRequestStatus,
	RefreshReason,
} from "./types.ts";

type RefreshOptions = {
	intervalMs?: number;
	maxBackoffMs?: number;
	now?: () => Date;
	cacheWindowMs?: number;
	minRefreshIntervalMs?: number;
};

export type RefreshController = {
	refresh(
		ctx: ExtensionContext,
		reason: RefreshReason,
		signal?: AbortSignal,
	): Promise<GhSnapshot>;
	restore(ctx: ExtensionContext): void;
	startTimer(ctx: ExtensionContext): void;
	stop(): void;
	getSnapshot(): GhSnapshot | undefined;
	diagnostics(): string;
};

function errorPr(
	branch: string | undefined,
	message: string,
	stderr?: string,
): PullRequestStatus {
	return {
		kind: "error",
		...(branch ? { branch } : {}),
		message,
		...(stderr ? { stderr } : {}),
	};
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

function renderSnapshot(ctx: ExtensionContext, snapshot: GhSnapshot): void {
	try {
		ctx.ui.setStatus(
			"gh-status.service",
			renderServiceStatus(snapshot.service),
		);
		ctx.ui.setStatus(
			"gh-status.pr",
			snapshot.repo.kind === "repo" ? renderPrStatus(snapshot.pr) : "",
		);
	} catch (error) {
		ignoreOnlyStaleContext(error);
	}
}

export function createRefreshController(
	pi: ExtensionAPI,
	options: RefreshOptions = {},
): RefreshController {
	let seen = new Set<string>();
	let snapshot: GhSnapshot | undefined;
	let refreshPromise: Promise<GhSnapshot> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let lastServiceStatus: GitHubServiceStatus | undefined;
	let timerFailures = 0;
	let rateLimitBackoffUntil: Date | undefined;
	let lastRefreshTime: Date | undefined;
	let lastBranch: string | undefined;
	let lastCommitSha: string | undefined;
	const intervalMs = options.intervalMs ?? 120_000;
	const maxBackoffMs = options.maxBackoffMs ?? 10 * 60_000;
	const cacheWindowMs = options.cacheWindowMs ?? 45_000; // 45 seconds
	const minRefreshIntervalMs = options.minRefreshIntervalMs ?? 15_000; // 15 seconds
	const now = options.now ?? (() => new Date());

	function isRateLimited(): boolean {
		return rateLimitBackoffUntil ? now() < rateLimitBackoffUntil : false;
	}

	function shouldSkipRefresh(
		reason: RefreshReason,
		currentBranch?: string,
		currentSha?: string,
	): boolean {
		// Always refresh on explicit commands
		if (reason === "command" || reason === "tool") return false;

		// Skip if we're in rate limit backoff
		if (isRateLimited()) return true;

		// Skip if last refresh was very recent
		if (
			lastRefreshTime &&
			now().getTime() - lastRefreshTime.getTime() < minRefreshIntervalMs
		) {
			return true;
		}

		// Skip if we have cached data and no significant changes
		if (
			snapshot &&
			lastRefreshTime &&
			now().getTime() - lastRefreshTime.getTime() < cacheWindowMs
		) {
			// Check if branch or commit changed
			if (
				currentBranch &&
				currentSha &&
				lastBranch === currentBranch &&
				lastCommitSha === currentSha
			) {
				return true;
			}
		}

		return false;
	}

	function handleRateLimit(ctx: ExtensionContext, error: any): void {
		const errorMessage = error?.message || error?.stderr || String(error);
		// Check for various rate limit patterns
		const isRateLimit =
			/rate limit|API rate limit|already exceeded|GraphQL.*rate.*limit|403.*limit/i.test(
				errorMessage,
			);

		if (isRateLimit) {
			// Exponential backoff for rate limits: start with 5 minutes, max 30 minutes
			const backoffMinutes = Math.min(30, 5 * 2 ** timerFailures);
			rateLimitBackoffUntil = new Date(
				now().getTime() + backoffMinutes * 60_000,
			);
			try {
				ctx.ui.notify(
					`GitHub API rate limited. Backing off for ${backoffMinutes} minutes. Error: ${errorMessage.substring(0, 100)}`,
					"warning",
				);
			} catch (error) {
				ignoreOnlyStaleContext(error);
			}
			// Log for debugging
			console.warn("[gh-status] Rate limit detected:", errorMessage);
		}
	}

	async function getCurrentGitInfo(
		cwd: string,
	): Promise<{ branch?: string; sha?: string }> {
		try {
			const branchResult = await pi.exec("git", ["branch", "--show-current"], {
				cwd,
			});
			const shaResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd });
			const branch =
				branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
			const sha = shaResult.code === 0 ? shaResult.stdout.trim() : undefined;
			return {
				...(branch && { branch }),
				...(sha && { sha }),
			};
		} catch {
			return {};
		}
	}

	async function buildSnapshot(
		ctx: ExtensionContext,
		reason: RefreshReason,
		signal?: AbortSignal,
	): Promise<GhSnapshot> {
		const checkedAt = now().toISOString();
		const repo = await resolveGitHubRepo(pi.exec, ctx.cwd);
		const serviceResult = await fetchGitHubServiceStatus({
			...(signal ? { signal } : {}),
			timeoutMs: 10_000,
		});
		const service = serviceResult.ok
			? serviceResult.value
			: lastServiceStatus
				? {
						...lastServiceStatus,
						stale: true,
						description: `${lastServiceStatus.description} (last known; refresh failed)`,
					}
				: unknownServiceStatus(serviceResult.error.message);
		lastServiceStatus = serviceResult.ok ? service : lastServiceStatus;

		let pr: PullRequestStatus;
		if (repo.kind === "repo") {
			const prResult = await fetchCurrentBranchPr(
				pi.exec,
				ctx.cwd,
				repo.repo,
				repo.branch,
				signal,
			);
			pr = prResult.ok
				? prResult.value
				: errorPr(repo.branch, prResult.error.message, prResult.error.stderr);
		} else if (repo.kind === "detached_head") {
			pr = errorPr(undefined, repo.message);
		} else {
			pr = errorPr(undefined, repo.message);
		}

		return { repo, service, pr, checkedAt, reason };
	}

	async function refresh(
		ctx: ExtensionContext,
		reason: RefreshReason,
		signal?: AbortSignal,
	): Promise<GhSnapshot> {
		if (refreshPromise) return refreshPromise;

		// Check if we should skip this refresh only after an initial snapshot exists.
		// The first refresh must not spend test doubles or real command budget on
		// cache probes before resolving the repository and PR state.
		let currentGitInfo: { branch?: string; sha?: string } | undefined;
		if (snapshot) {
			currentGitInfo = await getCurrentGitInfo(ctx.cwd);
			if (
				shouldSkipRefresh(reason, currentGitInfo.branch, currentGitInfo.sha)
			) {
				return snapshot;
			}
		}

		controller?.abort();
		controller = new AbortController();
		const abortFromCaller = () => controller?.abort();
		signal?.addEventListener("abort", abortFromCaller, { once: true });

		refreshPromise = buildSnapshot(ctx, reason, controller.signal)
			.then((next) => {
				snapshot = next;
				// Update tracking variables on success
				lastRefreshTime = now();
				lastBranch =
					currentGitInfo?.branch ??
					(next.repo.kind === "repo" ? next.repo.branch : undefined);
				lastCommitSha =
					currentGitInfo?.sha ??
					(next.pr.kind === "pr" ? next.pr.headSha : undefined);
				// Clear rate limit backoff on success
				rateLimitBackoffUntil = undefined;

				renderSnapshot(ctx, next);
				const notifications = deriveActionableNotifications(next, seen);
				for (const notification of notifications) {
					try {
						ctx.ui.notify(
							`${notification.title}: ${notification.message}`,
							notification.severity,
						);
					} catch (error) {
						ignoreOnlyStaleContext(error);
					}
				}
				markSeen(
					pi,
					seen,
					notifications.map((notification) => notification.key),
					now(),
				);
				return next;
			})
			.catch((error) => {
				// Handle rate limits and other errors
				handleRateLimit(ctx, error);
				throw error;
			})
			.finally(() => {
				signal?.removeEventListener("abort", abortFromCaller);
				refreshPromise = undefined;
			});

		return refreshPromise;
	}

	function scheduleNext(ctx: ExtensionContext, delayMs: number): void {
		timer = setTimeout(() => {
			void refresh(ctx, "timer")
				.then(() => {
					timerFailures = 0;
					scheduleNext(ctx, intervalMs);
				})
				.catch((error) => {
					handleRateLimit(ctx, error);
					timerFailures += 1;
					const backoff = Math.min(
						maxBackoffMs,
						intervalMs * 2 ** timerFailures,
					);
					scheduleNext(ctx, backoff);
				});
		}, delayMs);
	}

	return {
		refresh,
		restore(ctx) {
			seen = restoreSeenMarks(ctx);
		},
		startTimer(ctx) {
			if (timer) clearTimeout(timer);
			timer = undefined;
			timerFailures = 0;
			scheduleNext(ctx, intervalMs);
		},
		stop() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			controller?.abort();
			controller = undefined;
			refreshPromise = undefined;
			timerFailures = 0;
		},
		getSnapshot() {
			return snapshot;
		},
		diagnostics() {
			let output = snapshot
				? formatDiagnosticsMarkdown(snapshot)
				: "GitHub status has not been refreshed yet.\n";

			// Add rate limit status if in backoff
			if (rateLimitBackoffUntil) {
				const remaining = Math.ceil(
					(rateLimitBackoffUntil.getTime() - now().getTime()) / 1000 / 60,
				);
				if (remaining > 0) {
					output += `\n⏰ **Rate Limited**: API calls paused for ${remaining} more minutes.\n`;
				}
			}

			// Add cache info
			if (lastRefreshTime) {
				const age = Math.floor(
					(now().getTime() - lastRefreshTime.getTime()) / 1000,
				);
				output += `\n🕒 Last refresh: ${age}s ago`;
				if (lastBranch) {
					output += ` (${lastBranch}`;
					if (lastCommitSha) {
						output += `:${lastCommitSha.substring(0, 8)}`;
					}
					output += ")";
				}
				output += "\n";
			}

			return output;
		},
	};
}
