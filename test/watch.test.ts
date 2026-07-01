import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WATCH_ACTIVE_STATUS,
	createWatchController,
	deriveWatchStatus,
	WATCH_STATUS_KEY,
	WATCH_CHECK_CUSTOM_TYPE,
	type WatchFinding,
} from "../extensions/gh-status/watch.ts";
import type { RefreshController } from "../extensions/gh-status/refresh.ts";
import type { GhSnapshot } from "../extensions/gh-status/types.ts";

function finding(kind: WatchFinding["kind"]): WatchFinding {
	return { kind, id: `${kind}:1`, title: `${kind} finding` };
}

function prSnapshot(
	overrides: Partial<Extract<GhSnapshot["pr"], { kind: "pr" }>> = {},
): GhSnapshot {
	return {
		repo: {
			kind: "repo",
			repo: {
				owner: "o",
				name: "r",
				fullName: "o/r",
				remoteUrl: "git@github.com:o/r.git",
			},
			branch: "b",
		},
		service: {
			indicator: "none",
			description: "ok",
			components: [],
			incidents: [],
			scheduledMaintenances: [],
			stale: false,
		},
		pr: {
			kind: "pr",
			number: 1,
			url: "https://github.com/o/r/pull/1",
			branch: "b",
			checks: [],
			activities: [],
			...overrides,
		},
		checkedAt: "2026-06-04T10:33:05.000Z",
		reason: "timer",
	};
}

function fakeContext(): ExtensionContext & { signal: AbortSignal | undefined } {
	return {
		cwd: "/repo",
		hasUI: true,
		signal: undefined,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	} as unknown as ExtensionContext & { signal: AbortSignal | undefined };
}

function fakePi(): ExtensionAPI {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("deriveWatchStatus", () => {
	it("shows compact active status when there are no new findings", () => {
		expect(deriveWatchStatus([])).toEqual({
			footerText: WATCH_ACTIVE_STATUS,
		});
	});

	it("maps failed checks and merge conflicts to pipeline blocking status", () => {
		expect(deriveWatchStatus([finding("check")])).toEqual({
			footerText: "blocking - pipeline",
			blockingCategory: "pipeline",
		});
		expect(deriveWatchStatus([finding("merge-conflict")])).toEqual({
			footerText: "blocking - pipeline",
			blockingCategory: "pipeline",
		});
	});

	it("maps comments and reviews to comment blocking status", () => {
		expect(deriveWatchStatus([finding("comment")])).toEqual({
			footerText: "blocking - comment",
			blockingCategory: "comment",
		});
		expect(deriveWatchStatus([finding("review")])).toEqual({
			footerText: "blocking - comment",
			blockingCategory: "comment",
		});
	});

	it("maps BugBot findings to bugbot blocking status", () => {
		expect(deriveWatchStatus([finding("bugbot")])).toEqual({
			footerText: "blocking - bugbot",
			blockingCategory: "bugbot",
		});
	});

	it("prioritizes pipeline over comment and BugBot when multiple blocker classes are present", () => {
		expect(
			deriveWatchStatus([
				finding("bugbot"),
				finding("comment"),
				finding("check"),
			]),
		).toEqual({
			footerText: "blocking - pipeline",
			blockingCategory: "pipeline",
		});
	});
});

describe("createWatchController", () => {
	it("shows a clear on indicator when watch starts", async () => {
		const refresh = vi.fn().mockResolvedValue(prSnapshot());
		const refreshController = {
			getSnapshot: () => prSnapshot(),
			refresh,
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		expect(await controller.start(ctx)).toBe(true);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			WATCH_STATUS_KEY,
			WATCH_ACTIVE_STATUS,
		);
		expect(WATCH_ACTIVE_STATUS).toMatch(/\bon\b/i);
		expect(vi.mocked(ctx.ui.notify).mock.calls.flat().join("\n")).not.toContain(
			"agent X",
		);
	});

	it("refuses to start a second watch watcher while one is already running", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockResolvedValue(prSnapshot());
		const refreshController = {
			getSnapshot: () => prSnapshot(),
			refresh,
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		expect(await controller.start(ctx, { intervalMs: 5 * 60_000 })).toBe(true);
		vi.mocked(ctx.ui.notify).mockClear();
		vi.mocked(ctx.ui.setStatus).mockClear();

		expect(await controller.start(ctx, { intervalMs: 15 * 60_000 })).toBe(
			false,
		);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Watch is already on. Use /watch status or /watch stop.",
			"warning",
		);
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(controller.status()).toBe("Watch running every 5m for PR #1.");
	});

	it("starts checking the PR every five minutes by default", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockResolvedValue(prSnapshot());
		const refreshController = {
			refresh,
			getSnapshot: () => prSnapshot(),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		expect(await controller.start(ctx)).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringMatching(/Watch started.*performing initial sweep/),
			"info",
		);

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		// Refresh should be called twice: once on startup (initial sweep) and once on timer
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("runs a watch check now and restarts the wait for the next automatic check", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockResolvedValue(prSnapshot());
		const refreshController = {
			refresh,
			getSnapshot: () => prSnapshot(),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		expect(await controller.start(ctx, { intervalMs: 10 * 60_000 })).toBe(true);
		vi.mocked(ctx.ui.notify).mockClear();
		refresh.mockClear();

		await controller.runNow(ctx);

		expect(refresh).toHaveBeenCalledOnce();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Watch checked now; next automatic check in 10m.",
			"info",
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			WATCH_CHECK_CUSTOM_TYPE,
			expect.objectContaining({
				version: 1,
				checkedAt: "2026-06-04T10:33:05.000Z",
				trigger: "manual",
				prNumber: 1,
				totalFindings: 0,
				newFindings: 0,
				agentsQueued: 0,
				checks: expect.objectContaining({ failed: 0, passed: 0, pending: 0 }),
				activities: expect.objectContaining({ total: 0, human: 0, bot: 0 }),
				findingsByKind: expect.objectContaining({ check: 0, bugbot: 0 }),
			}),
		);

		await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
		expect(refresh).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("does not queue stale findings after watch is stopped", async () => {
		vi.useFakeTimers();
		let resolveRefresh!: (snapshot: GhSnapshot) => void;
		const refresh = vi.fn(
			() =>
				new Promise<GhSnapshot>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const refreshController = {
			refresh,
			getSnapshot: () => prSnapshot(),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		controller.start(ctx, { intervalMs: 5 * 60_000 });
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		controller.stop(ctx, "stopped by user");
		vi.mocked(ctx.ui.notify).mockClear();
		vi.mocked(ctx.ui.setStatus).mockClear();

		resolveRefresh(
			prSnapshot({
				checks: [{ name: "ci", bucket: "fail", sha: "abc" }],
				headSha: "abc",
			}),
		);
		await vi.runAllTimersAsync();

		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
			WATCH_STATUS_KEY,
			"blocking - pipeline",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			"Watch detected 1 new item: blocking - pipeline; investigation queued.",
			"warning",
		);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("emits one unified pipeline notification and trigger message for new failed checks", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockResolvedValue(
			prSnapshot({
				checks: [{ name: "ci", bucket: "fail", sha: "abc" }],
				headSha: "abc",
			}),
		);
		const refreshController = {
			refresh,
			getSnapshot: () => prSnapshot(),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		controller.start(ctx, { intervalMs: 10 * 60_000 });
		vi.mocked(ctx.ui.notify).mockClear();
		vi.mocked(ctx.ui.setStatus).mockClear();
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			WATCH_STATUS_KEY,
			"blocking - pipeline",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Watch detected 1 new item: blocking - pipeline; investigation queued.",
			"warning",
		);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "the-watch-watch-trigger" }),
			{ triggerTurn: true },
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			WATCH_CHECK_CUSTOM_TYPE,
			expect.objectContaining({
				totalFindings: 1,
				newFindings: 1,
				agentsQueued: 1,
				blockingCategory: "pipeline",
				checks: expect.objectContaining({ failed: 1 }),
				findingsByKind: expect.objectContaining({ check: 1 }),
			}),
		);
	});

	it("triggers a watch message for BugBot-only findings", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockResolvedValue(
			prSnapshot({
				activities: [
					{
						key: "bugbot-key",
						source: "comment",
						body: "BugBot found an issue",
						isBot: true,
						botKind: "cursor-bugbot",
					},
				],
			}),
		);
		const refreshController = {
			refresh,
			getSnapshot: () => prSnapshot(),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		controller.start(ctx, { intervalMs: 10 * 60_000 });
		vi.mocked(ctx.ui.notify).mockClear();
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			WATCH_STATUS_KEY,
			"blocking - bugbot",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Watch detected 1 new item: blocking - bugbot; investigation queued.",
			"warning",
		);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "the-watch-watch-trigger" }),
			{ triggerTurn: true },
		);
	});

	it("refuses to start when there is no open PR", async () => {
		const refreshController = {
			getSnapshot: () => prSnapshot({ state: "CLOSED" }),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		expect(await controller.start(ctx)).toBe(false);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Watch requires an open PR snapshot. Refresh GitHub status first.",
			"error",
		);
	});

	it("stops automatically when PR is closed during monitoring", async () => {
		vi.useFakeTimers();
		// First call returns open PR, second call (during timer) returns merged PR
		const refresh = vi
			.fn()
			.mockResolvedValueOnce(prSnapshot()) // Initial call during start
			.mockResolvedValueOnce(prSnapshot({ state: "MERGED" })); // Timer call
		const refreshController = {
			refresh,
			getSnapshot: () => prSnapshot(),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		expect(await controller.start(ctx)).toBe(true);
		vi.mocked(ctx.ui.notify).mockClear();

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Watch stopped: PR is merged",
			"info",
		);
		expect(controller.isRunning()).toBe(false);
	});

	it("handles refresh errors gracefully", async () => {
		vi.useFakeTimers();
		// First call succeeds, second call (during timer) fails
		const refresh = vi
			.fn()
			.mockResolvedValueOnce(prSnapshot()) // Initial call during start
			.mockRejectedValueOnce(new Error("Network error")); // Timer call
		const refreshController = {
			refresh,
			getSnapshot: () => prSnapshot(),
		} as unknown as RefreshController;
		const pi = fakePi();
		const ctx = fakeContext();
		const controller = createWatchController(pi, refreshController);

		expect(await controller.start(ctx)).toBe(true);
		vi.mocked(ctx.ui.notify).mockClear();

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Watch refresh failed: Network error",
			"error",
		);
		expect(controller.isRunning()).toBe(true); // Should still be running
	});
});
