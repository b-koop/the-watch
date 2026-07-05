import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import ghStatusExtension from "../extensions/gh-status/extension.ts";
import {
	markSeen,
	restoreSeenMarks,
} from "../extensions/gh-status/persistence.ts";
import { createRefreshController } from "../extensions/gh-status/refresh.ts";
import {
	deriveActionableNotifications,
	formatDiagnosticsMarkdown,
	renderPrStatus,
	renderServiceStatus,
	summarizeChecks,
} from "../extensions/gh-status/render.ts";
import type { GhSnapshot } from "../extensions/gh-status/types.ts";

type LifecycleHandler = (
	event: unknown,
	ctx: ExtensionContext,
) => Promise<void> | void;
type FooterFactory = (
	tui: unknown,
	theme: { fg: (color: string, text: string) => string },
	footerData: { getExtensionStatuses: () => Map<string, string> },
) => { render: (width: number) => string[] };

function fakeContext(): ExtensionContext {
	return {
		cwd: "/repo",
		hasUI: true,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setFooter: vi.fn(),
		},
		sessionManager: {
			getBranch: () => [
				{
					type: "custom",
					customType: "gh-status-seen",
					data: {
						version: 1,
						keys: ["seen-key"],
						updatedAt: "2026-05-27T00:00:00Z",
					},
				},
			],
		},
	} as unknown as ExtensionContext;
}

function healthyFetch() {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue({
		ok: true,
		json: async () => ({
			status: { indicator: "none", description: "All Systems Operational" },
			components: [],
		}),
	} as Response);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("render helpers", () => {
	it("summarizes checks and renders compact service and PR states", () => {
		expect(
			summarizeChecks([
				{ name: "ci", bucket: "fail" },
				{ name: "lint", bucket: "pass" },
				{ name: "build", bucket: "pending" },
			]),
		).toMatchObject({ failed: 1, passed: 1, pending: 1 });
		expect(
			renderPrStatus({
				kind: "pr",
				number: 1,
				url: "u",
				branch: "b",
				checks: [{ name: "ci", bucket: "fail" }],
				activities: [
					{ key: "human", source: "comment", body: "hello", isBot: false },
					{
						key: "bugbot",
						source: "comment",
						body: "bug",
						isBot: true,
						botKind: "cursor-bugbot",
					},
					{
						key: "copilot",
						source: "review",
						body: "note",
						isBot: true,
						botKind: "copilot",
					},
				],
			}),
		).toBe("PR #1: ✗ 1 failing · 1 human · BugBot 1 · Bot 1");
		expect(
			renderPrStatus({
				kind: "pr",
				number: 2,
				url: "u",
				branch: "b",
				checks: [{ name: "ci", bucket: "pending" }],
				activities: [],
			}),
		).toContain("1 pending");
		expect(
			renderPrStatus({ kind: "no_pr", branch: "b", message: "none" }),
		).toBe("No PR");
		expect(renderPrStatus({ kind: "error", message: "boom" })).toBe(
			"PR: ? boom",
		);
	});

	it("renders healthy, degraded, unknown, and stale service status", () => {
		expect(
			renderServiceStatus({
				indicator: "none",
				description: "ok",
				components: [],
				incidents: [],
				scheduledMaintenances: [],
				stale: false,
			}),
		).toBe("GitHub: ✓ ok");
		expect(
			renderServiceStatus({
				indicator: "minor",
				description: "degraded",
				components: [],
				incidents: [],
				scheduledMaintenances: [],
				stale: true,
			}),
		).toBe("GitHub: ! degraded stale");
		expect(
			renderServiceStatus({
				indicator: "unknown",
				description: "unknown",
				components: [],
				incidents: [],
				scheduledMaintenances: [],
				stale: false,
			}),
		).toBe("GitHub: ? unknown");
	});
});

describe("notifications", () => {
	it("includes service, check, human, and bot notifications while excluding seen keys", () => {
		const snapshot: GhSnapshot = {
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
				indicator: "minor",
				description: "degraded",
				updatedAt: "service-time",
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
				checks: [{ name: "ci", bucket: "fail", sha: "abc" }],
				activities: [
					{ key: "seen-key", source: "comment", body: "hello", isBot: false },
					{ key: "bot-key", source: "review", body: "fix it", isBot: true },
				],
			},
			checkedAt: "2026-05-27T00:00:00Z",
			reason: "tool",
		};

		const notifications = deriveActionableNotifications(
			snapshot,
			new Set(["seen-key"]),
		);

		expect(notifications.map((notification) => notification.title)).toEqual([
			"GitHub service degraded",
			"PR #1 check failed",
			"PR #1 bot alert",
		]);
	});
});

describe("persistence", () => {
	it("restores and appends only newly seen marks", () => {
		const ctx = fakeContext();
		const seen = restoreSeenMarks(ctx);
		const appendEntry = vi.fn();

		markSeen(
			{ appendEntry },
			seen,
			["seen-key", "new-key"],
			new Date("2026-05-27T00:00:00Z"),
		);

		expect(appendEntry).toHaveBeenCalledWith("gh-status-seen", {
			version: 1,
			keys: ["new-key"],
			updatedAt: "2026-05-27T00:00:00.000Z",
		});
	});
});

describe("createRefreshController", () => {
	it("refreshes, renders statuses, notifies once, persists seen keys, and exposes diagnostics", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					number: 1,
					url: "https://github.com/o/r/pull/1",
					headRefOid: "abc",
					statusCheckRollup: [
						{ name: "ci", conclusion: "FAILURE", commit: { oid: "abc" } },
					],
					comments: [],
				}),
				stderr: "",
				code: 0,
				killed: false,
			});
		const appendEntry = vi.fn();
		const pi = { exec, appendEntry } as unknown as ExtensionAPI;
		const ctx = fakeContext();
		healthyFetch();

		const controller = createRefreshController(pi, {
			now: () => new Date("2026-05-27T00:00:00Z"),
		});
		controller.restore(ctx);
		await controller.refresh(ctx, "tool");

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"gh-status.service",
			"GitHub: ✓ All Systems Operational",
		);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"gh-status.pr",
			"PR #1: ✗ 1 failing · 0 human",
		);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(appendEntry).toHaveBeenCalledWith(
			"gh-status-seen",
			expect.objectContaining({
				keys: ["https://github.com/o/r/pull/1:check:ci:abc"],
			}),
		);
		expect(controller.diagnostics()).toContain("# GitHub status");
	});

	it("deduplicates concurrent refreshes with one in-flight promise", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "no pull requests found",
				code: 1,
				killed: false,
			});
		const pi = { exec, appendEntry: vi.fn() } as unknown as ExtensionAPI;
		const ctx = fakeContext();
		healthyFetch();
		const controller = createRefreshController(pi);

		const first = controller.refresh(ctx, "tool");
		const second = controller.refresh(ctx, "command");
		await expect(second).resolves.toBe(await first);

		expect(exec).toHaveBeenCalledTimes(3);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("gh-status.pr", "No PR");
	});

	it("uses stale service status only after a previous successful fetch", async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "no pull requests found",
				code: 1,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "no pull requests found",
				code: 1,
				killed: false,
			});
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					status: { indicator: "none", description: "ok" },
				}),
			} as Response)
			.mockRejectedValueOnce(new Error("network down"));
		const controller = createRefreshController({
			exec,
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI);
		const ctx = fakeContext();

		await controller.refresh(ctx, "tool");
		const second = await controller.refresh(ctx, "tool");

		expect(second.service).toMatchObject({
			stale: true,
			description: "ok (last known; refresh failed)",
		});
	});

	it("schedules timer retries with exponential backoff and resets after success", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const exec = vi
			.fn()
			.mockRejectedValueOnce(new Error("git exploded"))
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "no pull requests found",
				code: 1,
				killed: false,
			});
		const controller = createRefreshController(
			{ exec, appendEntry: vi.fn() } as unknown as ExtensionAPI,
			{ intervalMs: 10, maxBackoffMs: 100 },
		);
		healthyFetch();

		controller.startTimer(fakeContext());
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(20);

		expect(
			setTimeoutSpy.mock.calls
				.map((call) => call[1])
				.filter((delay) => typeof delay === "number" && delay <= 100),
		).toEqual([10, 20, 10]);
	});

	it("stop clears the timer and aborts in-flight refresh work", async () => {
		vi.useFakeTimers();
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			});
		let aborted = false;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					const resolveAbort = () => {
						aborted = true;
						resolve({
							ok: false,
							status: 499,
							json: async () => ({}),
						} as Response);
					};
					if (init?.signal?.aborted) resolveAbort();
					else init?.signal?.addEventListener("abort", resolveAbort);
				}),
		);
		const controller = createRefreshController(
			{ exec, appendEntry: vi.fn() } as unknown as ExtensionAPI,
			{ intervalMs: 10 },
		);
		controller.startTimer(fakeContext());
		const refreshPromise = controller
			.refresh(fakeContext(), "tool")
			.catch(() => undefined);
		for (let i = 0; i < 20 && fetchSpy.mock.calls.length === 0; i += 1) {
			await Promise.resolve();
		}
		expect(fetchSpy).toHaveBeenCalled();

		controller.stop();
		await refreshPromise;

		expect(vi.getTimerCount()).toBe(0);
		expect(aborted).toBe(true);
	});
});

describe("ghStatusExtension", () => {
	it("shows GitHub service on the left and pull request health on the upper right footer line with matching severity colors", async () => {
		type LifecycleHandler = (
			event: unknown,
			ctx: ExtensionContext,
		) => Promise<void>;
		type FooterFactory = (
			tui: unknown,
			theme: { fg: (color: string, text: string) => string },
			footerData: { getExtensionStatuses: () => Map<string, string> },
		) => { render: (width: number) => string[] };
		const handlers = new Map<string, LifecycleHandler[]>();
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					number: 42,
					url: "https://github.com/o/r/pull/42",
					headRefOid: "abc",
					statusCheckRollup: [
						{ name: "ci", conclusion: "FAILURE", commit: { oid: "abc" } },
					],
					comments: [],
				}),
				stderr: "",
				code: 0,
				killed: false,
			});
		const pi = {
			exec,
			appendEntry: vi.fn(),
			on: vi.fn((event: string, handler: LifecycleHandler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}),
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = fakeContext();
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				status: { indicator: "minor", description: "degraded" },
				components: [],
			}),
		} as Response);
		ghStatusExtension(pi);

		await handlers.get("session_start")?.[0]?.({}, ctx);

		const setStatus = vi.mocked(ctx.ui.setStatus);
		const statuses = new Map(
			setStatus.mock.calls.map(([key, text]) => [key, text ?? ""]),
		);
		const footerFactory = vi.mocked(ctx.ui.setFooter).mock.calls.at(-1)?.[0] as
			| FooterFactory
			| undefined;
		const theme = { fg: vi.fn((_color: string, text: string) => text) };

		expect(footerFactory).toBeDefined();
		const lines = footerFactory?.({}, theme, {
			getExtensionStatuses: () => statuses,
		}).render(80);

		expect(lines?.[0]).toBe(
			"GitHub: ! degraded".padEnd(80 - "PR #42: ✗ 1 failing · 0 human".length) +
				"PR #42: ✗ 1 failing · 0 human",
		);
		expect(theme.fg).toHaveBeenCalledWith("warning", "GitHub: ! degraded");
		expect(theme.fg).toHaveBeenCalledWith(
			"error",
			"PR #42: ✗ 1 failing · 0 human",
		);

		const narrowLines = footerFactory?.({}, theme, {
			getExtensionStatuses: () =>
				new Map([
					["gh-status.service", "GitHub: ! Extremely degraded service"],
					["gh-status.pr", "PR #42: ✗ 1 failing · 0 human"],
				]),
		}).render(36);
		expect(visibleWidth(narrowLines?.[0] ?? "")).toBe(36);
		expect(narrowLines?.[0]?.endsWith("PR #42: ✗ 1 failing · 0 human")).toBe(
			true,
		);

		const noPrTheme = { fg: vi.fn((_color: string, text: string) => text) };
		const noPrLines = footerFactory?.({}, noPrTheme, {
			getExtensionStatuses: () =>
				new Map([
					["gh-status.service", "GitHub: ✓ All Systems Operational"],
					["gh-status.pr", "No PR"],
				]),
		}).render(80);
		expect(noPrLines?.[0]?.endsWith("No PR")).toBe(true);
		expect(noPrTheme.fg).toHaveBeenCalledWith("muted", "No PR");
	});

	it("hides pull request footer text when the git repository has no GitHub remote", async () => {
		const handlers = new Map<string, LifecycleHandler[]>();
		const exec = vi.fn().mockResolvedValueOnce({
			stdout: "origin\thttps://example.com/a/b.git (fetch)",
			stderr: "",
			code: 0,
			killed: false,
		});
		const pi = {
			exec,
			appendEntry: vi.fn(),
			on: vi.fn((event: string, handler: LifecycleHandler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}),
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = fakeContext();
		healthyFetch();
		ghStatusExtension(pi);

		await handlers.get("session_start")?.[0]?.({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("gh-status.pr", "");
		const statuses = new Map(
			vi
				.mocked(ctx.ui.setStatus)
				.mock.calls.map(([key, text]) => [key, text ?? ""]),
		);
		const footerFactory = vi.mocked(ctx.ui.setFooter).mock.calls.at(-1)?.[0] as
			| FooterFactory
			| undefined;
		const lines = footerFactory?.(
			{},
			{ fg: (_color, text) => text },
			{
				getExtensionStatuses: () => statuses,
			},
		).render(80);

		expect(lines?.[0]?.trimEnd()).toBe("GitHub: ✓ All Systems Operational");
		expect(lines?.[0]).not.toContain("PR");
		handlers.get("session_shutdown")?.[0]?.({}, ctx);
	});

	it("hides pull request footer text when the GitHub repo has no current branch", async () => {
		const handlers = new Map<string, LifecycleHandler[]>();
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "\n",
				stderr: "",
				code: 0,
				killed: false,
			});
		const pi = {
			exec,
			appendEntry: vi.fn(),
			on: vi.fn((event: string, handler: LifecycleHandler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}),
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = fakeContext();
		healthyFetch();
		ghStatusExtension(pi);

		await handlers.get("session_start")?.[0]?.({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("gh-status.pr", "");
		const statuses = new Map(
			vi
				.mocked(ctx.ui.setStatus)
				.mock.calls.map(([key, text]) => [key, text ?? ""]),
		);
		const footerFactory = vi.mocked(ctx.ui.setFooter).mock.calls.at(-1)?.[0] as
			| FooterFactory
			| undefined;
		const lines = footerFactory?.(
			{},
			{ fg: (_color, text) => text },
			{
				getExtensionStatuses: () => statuses,
			},
		).render(80);

		expect(lines?.[0]?.trimEnd()).toBe("GitHub: ✓ All Systems Operational");
		expect(lines?.[0]).not.toContain("PR");
		expect(exec).toHaveBeenCalledTimes(2);
		handlers.get("session_shutdown")?.[0]?.({}, ctx);
	});

	it("keeps auto refresh and timer lifecycle registered while using the custom footer", async () => {
		const handlers = new Map<string, unknown[]>();
		const commands = new Map<string, unknown>();
		const tools = new Map<string, unknown>();
		const pi = {
			exec: vi.fn(),
			appendEntry: vi.fn(),
			on: vi.fn((event: string, handler: unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}),
			registerCommand: vi.fn((name: string, command: unknown) => {
				commands.set(name, command);
			}),
			registerTool: vi.fn((tool: { name: string }) => {
				tools.set(tool.name, tool);
			}),
		} as unknown as ExtensionAPI;

		ghStatusExtension(pi);

		expect([...handlers.keys()]).toEqual(
			expect.arrayContaining(["session_start", "turn_end", "session_shutdown"]),
		);
		expect([...commands.keys()]).toEqual(
			expect.arrayContaining([
				"gh-status-refresh",
				"gh-pr",
				"gh-status-debug",
				"watch",
			]),
		);
		expect([...commands.keys()]).not.toEqual(
			expect.arrayContaining(["watch-status", "watch-stop", "watch-now"]),
		);
		const watchCommand = commands.get("watch") as {
			getArgumentCompletions: (
				prefix: string,
			) => Array<{ value: string }> | null;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		};
		expect(
			watchCommand.getArgumentCompletions("st")?.map((item) => item.value),
		).toEqual(["start", "status", "stop"]);
		const ctx = fakeContext();
		await watchCommand.handler("status", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Watch is not running.", "info");
		await watchCommand.handler("wat", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Usage: /watch [start [--notify-only] [--local]|status|stop|now]",
			"warning",
		);
		expect([...tools.keys()]).toEqual(
			expect.arrayContaining([
				"github_status_refresh",
				"github_pr_diagnostics",
				"github_status_debug",
			]),
		);
	});

	it("exposes bounded metadata for PR diagnostics instead of full snapshots", async () => {
		type RegisteredTool = {
			execute: (
				toolCallId: string,
				params: { includeComments?: boolean },
				signal: AbortSignal | undefined,
				onUpdate: () => void,
				ctx: ExtensionContext,
			) => Promise<{ details?: unknown }>;
		};
		const tools = new Map<string, RegisteredTool>();
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "origin\tgit@github.com:o/r.git (fetch)",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "b\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					number: 1,
					url: "https://github.com/o/r/pull/1",
					headRefOid: "abc",
					statusCheckRollup: [
						{ name: "ci", conclusion: "FAILURE", commit: { oid: "abc" } },
						{ name: "lint", conclusion: "SUCCESS", commit: { oid: "abc" } },
						{ name: "build", state: "PENDING", commit: { oid: "abc" } },
					],
					comments: [
						{
							id: "human-comment",
							author: { login: "person", type: "User" },
							body: "Please fix this.",
						},
					],
					reviews: [
						{
							id: "copilot-review",
							author: { login: "github-copilot[bot]", type: "Bot" },
							body: "Automated note.",
						},
					],
				}),
				stderr: "",
				code: 0,
				killed: false,
			});
		const pi = {
			exec,
			appendEntry: vi.fn(),
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: vi.fn((tool: { name: string } & RegisteredTool) => {
				tools.set(tool.name, tool);
			}),
		} as unknown as ExtensionAPI;
		healthyFetch();
		ghStatusExtension(pi);

		const result = await tools
			.get("github_pr_diagnostics")
			?.execute("tool-call", {}, undefined, vi.fn(), fakeContext());

		expect(result?.details).toEqual({
			checkedAt: expect.any(String),
			reason: "tool",
			repoKind: "repo",
			branch: "b",
			prKind: "pr",
			prNumber: 1,
			checks: {
				total: 3,
				passed: 1,
				failed: 1,
				pending: 1,
				skipped: 0,
				cancelled: 0,
				unknown: 0,
			},
			activities: { total: 2, human: 1, bot: 1, bugbot: 0, copilot: 1 },
		});
		expect(result?.details).not.toHaveProperty("snapshot");
	});
});

describe("diagnostics", () => {
	it("formats bounded markdown diagnostics", () => {
		const markdown = formatDiagnosticsMarkdown({
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
				url: "u",
				branch: "b",
				checks: [],
				activities: [],
			},
			checkedAt: "now",
			reason: "tool",
		});

		expect(markdown).toContain("Repository: o/r");
		expect(markdown).toContain("Pull request: PR #1");
	});
});
