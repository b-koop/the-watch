import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_VETTE_BETA_CONFIG,
	VETTE_BETA_TOPICS,
	VetteBetaCooldown,
	buildVetteBetaDiffBundle,
	formatResolvedModelPool,
	formatVetteBetaSynthesisPrompt,
	parseVetteBetaConfig,
	resolveModelPool,
	runTopicWithFallback,
	runVetteBetaReview,
	type PiAgentRunner,
	type PiAgentRunResult,
	type VetteBetaTopic,
} from "../extensions/vette-beta.ts";

const topic: VetteBetaTopic = {
	id: "correctness",
	label: "Correctness",
	prompt: "Check correctness only.",
};

function successResult(
	text = '{"topicId":"correctness","findings":[]}',
): PiAgentRunResult {
	return {
		exitCode: 0,
		stdout: text,
		stderr: "",
		messages: [],
		finalText: text,
	};
}

function fakeContext(modelRegistry?: unknown): ExtensionCommandContext {
	return {
		cwd: "/repo",
		hasUI: true,
		signal: undefined,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		...(modelRegistry ? { modelRegistry } : {}),
	} as unknown as ExtensionCommandContext;
}

function fakeExec(): ExtensionAPI["exec"] {
	return vi.fn(async (command: string, args: string[]) => {
		const joined = args.join(" ");
		if (command === "linear" && joined === "issue id") {
			return { code: 0, stdout: "ENG-123\n", stderr: "", killed: false };
		}
		if (command === "linear" && joined === "issue view ENG-123") {
			return {
				code: 0,
				stdout:
					"ENG-123 Add beta review\nAcceptance criteria:\n- Show requirements gaps\n",
				stderr: "",
				killed: false,
			};
		}
		if (command === "git" && joined.startsWith("ls-files")) {
			return {
				code: 0,
				stdout: "features/watch-review.feature\n",
				stderr: "",
				killed: false,
			};
		}
		if (
			command === "git" &&
			joined === "show HEAD:features/watch-review.feature"
		) {
			return {
				code: 0,
				stdout:
					"Feature: Watch review\n\n  Scenario: Changed watch behavior is reviewed\n    Given changed watch behavior\n    When vette reviews the branch\n    Then behavior gaps are reported\n",
				stderr: "",
				killed: false,
			};
		}
		if (command === "gh" && joined.includes("--name-only")) {
			return {
				code: 0,
				stdout: "extensions/pr-vette.ts\nextensions/vette-beta.ts\n",
				stderr: "",
				killed: false,
			};
		}
		if (command === "gh" && joined.includes("--patch")) {
			return {
				code: 0,
				stdout:
					"diff --git a/extensions/pr-vette.ts b/extensions/pr-vette.ts\n+beta\n",
				stderr: "",
				killed: false,
			};
		}
		if (joined.startsWith("merge-base")) {
			return { code: 0, stdout: "base\n", stderr: "", killed: false };
		}
		if (joined.includes("--name-status")) {
			return {
				code: 0,
				stdout: "M\textensions/gh-status/watch.ts\n",
				stderr: "",
				killed: false,
			};
		}
		if (joined.includes("--stat")) {
			return {
				code: 0,
				stdout: " watch.ts | 1 +\n",
				stderr: "",
				killed: false,
			};
		}
		if (joined.includes("--unified=80")) {
			return {
				code: 0,
				stdout: "diff --git a/watch.ts b/watch.ts\n+change\n",
				stderr: "",
				killed: false,
			};
		}
		return { code: 1, stdout: "", stderr: "unexpected", killed: false };
	}) as unknown as ExtensionAPI["exec"];
}

describe("vette beta config", () => {
	it("uses defaults when config is missing or invalid", () => {
		expect(parseVetteBetaConfig("not json")).toEqual(DEFAULT_VETTE_BETA_CONFIG);
		expect(parseVetteBetaConfig("{}").vetteBeta.modelPool).toBe("light");
		expect(parseVetteBetaConfig("{}").vetteBeta.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
		const defaultConfig = parseVetteBetaConfig("{}");
		expect(defaultConfig.modelPools.light[0].model).toBe(
			"cursor/gemini-3-flash",
		);
		expect(defaultConfig.modelPools.light[0].timeoutMs).toBe(180_000);
		expect(defaultConfig.modelPools.light[3].timeoutMs).toBe(600_000);
		expect(defaultConfig.vetteBeta.topicThinking).toMatchObject({
			correctness: "medium",
			tests: "low",
			"error-handling": "medium",
			"security-data": "high",
			contracts: "medium",
			"async-state": "high",
			naming: "off",
			maintainability: "medium",
			requirements: "medium",
			"behavior-specs": "medium",
		});
	});

	it("preserves ordered user model pools", () => {
		const config = parseVetteBetaConfig(
			JSON.stringify({
				modelPools: {
					light: [
						{ model: "provider/first", thinking: "off", timeoutMs: 1 },
						{ model: "provider/second", thinking: "low", timeoutMs: 2 },
					],
				},
				vetteBeta: { modelPool: "light", maxParallel: 99, tools: ["read"] },
			}),
		);

		expect(config.modelPools.light.map((entry) => entry.model)).toEqual([
			"provider/first",
			"provider/second",
		]);
		expect(config.vetteBeta.maxParallel).toBe(99);
		expect(config.vetteBeta.tools).toEqual(["read"]);
	});

	it("defaults remote models to three minutes and local models to ten minutes", () => {
		const config = parseVetteBetaConfig(
			JSON.stringify({
				modelPools: {
					light: [{ model: "provider/remote" }, { model: "ollama/local" }],
				},
			}),
		);

		expect(config.modelPools.light.map((entry) => entry.timeoutMs)).toEqual([
			180_000, 600_000,
		]);
	});

	it("allows topic thinking overrides while preserving defaults", () => {
		const config = parseVetteBetaConfig(
			JSON.stringify({
				vetteBeta: { topicThinking: { naming: "minimal" } },
			}),
		);

		expect(config.vetteBeta.topicThinking.naming).toBe("minimal");
		expect(config.vetteBeta.topicThinking.maintainability).toBe("medium");
		expect(config.vetteBeta.topicThinking.requirements).toBe("medium");
		expect(config.vetteBeta.topicThinking["behavior-specs"]).toBe("medium");
	});

	it("reports missing models when the model registry can validate selectors", () => {
		const config = parseVetteBetaConfig(
			JSON.stringify({
				modelPools: {
					light: [{ model: "provider/present" }, { model: "provider/missing" }],
				},
			}),
		);
		const modelRegistry = {
			find: (provider: string, id: string) =>
				provider === "provider" && id === "present" ? {} : undefined,
		};

		const resolved = resolveModelPool({ config, modelRegistry }).entries;

		expect(resolved.map((entry) => entry.availability)).toEqual([
			"available",
			"missing",
		]);
		expect(resolved[1].availabilityReason).toMatch(/not found/);
		expect(formatResolvedModelPool({ config, modelRegistry })).toContain(
			"connection=provider model=present selector=provider/present",
		);
	});
});

describe("vette beta fallback runner", () => {
	it("falls back after an exit-code failure and records the winning model", async () => {
		const runner = vi
			.fn<PiAgentRunner>()
			.mockResolvedValueOnce({
				exitCode: 1,
				stdout: "",
				stderr: "provider down",
				messages: [],
				finalText: "",
			})
			.mockResolvedValueOnce(successResult());

		const result = await runTopicWithFallback({
			topic,
			bundle: "diff",
			cwd: "/repo",
			tools: ["read"],
			pool: [
				{
					index: 0,
					model: "provider/first",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
				{
					index: 1,
					model: "provider2/second",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			cooldown: new VetteBetaCooldown({ now: () => 1, cooldownMs: 1000 }),
			runner,
		});

		expect(result.ok).toBe(true);
		expect(result.finalModel).toBe("provider2/second");
		expect(result.attempts.map((attempt) => attempt.status)).toEqual([
			"failed",
			"success",
		]);
	});

	it("falls back after a JSON-mode assistant error message", async () => {
		const runner = vi
			.fn<PiAgentRunner>()
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: "",
				stderr: "",
				messages: [],
				finalText: "",
				errorMessage: "rate limit from provider",
				stopReason: "error",
			})
			.mockResolvedValueOnce(successResult());

		const result = await runTopicWithFallback({
			topic,
			bundle: "diff",
			cwd: "/repo",
			tools: ["read"],
			pool: [
				{
					index: 0,
					model: "provider/first",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
				{
					index: 1,
					model: "provider2/second",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			cooldown: new VetteBetaCooldown({ now: () => 1, cooldownMs: 1000 }),
			runner,
		});

		expect(result.ok).toBe(true);
		expect(result.attempts[0].errorMessage).toMatch(/rate limit/);
	});

	it("falls back after timeout", async () => {
		const runner = vi
			.fn<PiAgentRunner>()
			.mockResolvedValueOnce({
				exitCode: 143,
				stdout: "",
				stderr: "",
				messages: [],
				finalText: "",
				timedOut: true,
			})
			.mockResolvedValueOnce(successResult());

		const result = await runTopicWithFallback({
			topic,
			bundle: "diff",
			cwd: "/repo",
			tools: ["read"],
			pool: [
				{
					index: 0,
					model: "provider/first",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
				{
					index: 1,
					model: "provider2/second",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			cooldown: new VetteBetaCooldown({ now: () => 1, cooldownMs: 1000 }),
			runner,
		});

		expect(result.ok).toBe(true);
		expect(result.attempts[0].timedOut).toBe(true);
	});

	it("runs a second model before accepting clean security or async results", async () => {
		const runner = vi
			.fn<PiAgentRunner>()
			.mockResolvedValueOnce(
				successResult(
					'{"topicId":"security-data","summary":"clean","findings":[]}',
				),
			)
			.mockResolvedValueOnce(
				successResult(
					'{"topicId":"security-data","summary":"clean","findings":[]}',
				),
			);

		const result = await runTopicWithFallback({
			topic: {
				id: "security-data",
				label: "Security/data",
				prompt: "Check security only.",
			},
			bundle: "diff",
			cwd: "/repo",
			tools: ["read"],
			pool: [
				{
					index: 0,
					model: "provider/first",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
				{
					index: 1,
					model: "provider2/second",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			cooldown: new VetteBetaCooldown({ now: () => 1, cooldownMs: 1000 }),
			runner,
		});

		expect(result.ok).toBe(true);
		expect(result.finalModel).toBe("provider2/second");
		expect(runner).toHaveBeenCalledTimes(2);
		expect(result.attempts.map((attempt) => attempt.status)).toEqual([
			"success",
			"success",
		]);
	});

	it("uses per-topic thinking over model-pool thinking", async () => {
		const runner = vi.fn<PiAgentRunner>().mockResolvedValue(successResult());
		await runTopicWithFallback({
			topic: {
				id: "maintainability",
				label: "Maintainability",
				prompt: "Check maintainability only.",
			},
			bundle: "diff",
			cwd: "/repo",
			tools: ["read"],
			pool: [
				{
					index: 0,
					model: "provider/light",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			cooldown: new VetteBetaCooldown({ now: () => 1, cooldownMs: 1000 }),
			runner,
			topicThinking: { maintainability: "medium" },
		});

		expect(runner).toHaveBeenCalledWith(
			expect.objectContaining({ thinking: "medium" }),
		);
	});

	it("skips a cooled provider for later tasks", async () => {
		let now = 1;
		const cooldown = new VetteBetaCooldown({
			now: () => now,
			cooldownMs: 1000,
		});
		cooldown.markFailure("provider/first", "provider unavailable");
		const runner = vi.fn<PiAgentRunner>().mockResolvedValue(successResult());

		const result = await runTopicWithFallback({
			topic,
			bundle: "diff",
			cwd: "/repo",
			tools: ["read"],
			pool: [
				{
					index: 0,
					model: "provider/first",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
				{
					index: 1,
					model: "provider/second",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
				{
					index: 2,
					model: "other/third",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			cooldown,
			runner,
		});

		expect(result.finalModel).toBe("other/third");
		expect(result.attempts.map((attempt) => attempt.status)).toEqual([
			"skipped",
			"skipped",
			"success",
		]);
		expect(runner).toHaveBeenCalledOnce();

		now = 2000;
		const afterCooldown = await runTopicWithFallback({
			topic,
			bundle: "diff",
			cwd: "/repo",
			tools: ["read"],
			pool: [
				{
					index: 0,
					model: "provider/first",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			cooldown,
			runner,
		});
		expect(afterCooldown.finalModel).toBe("provider/first");
	});
});

describe("vette beta review integration", () => {
	it("builds one diff bundle and runs all topic agents", async () => {
		const config = parseVetteBetaConfig(
			JSON.stringify({
				modelPools: {
					light: [{ model: "provider/light", thinking: "off", timeoutMs: 1 }],
				},
				vetteBeta: { modelPool: "light", maxParallel: 8, tools: ["read"] },
			}),
		);
		const runner = vi
			.fn<PiAgentRunner>()
			.mockResolvedValue(successResult('{"topicId":"x","findings":[]}'));
		const exec = fakeExec();
		const result = await runVetteBetaReview({
			ctx: fakeContext({ find: () => ({}) }),
			pi: { exec },
			config,
			cooldown: new VetteBetaCooldown(),
			runner,
		});

		expect(result.results).toHaveLength(VETTE_BETA_TOPICS.length);
		expect(result.bundle).toContain("Changed files:");
		expect(result.startedAt).toMatch(/T/);
		expect(result.finishedAt).toMatch(/T/);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.bundle).toContain("Linear requirements:");
		expect(result.bundle).toContain("ENG-123 Add beta review");
		expect(result.bundle).toContain("Behavior specs:");
		expect(result.bundle).toContain("Feature: Watch review");
		expect(runner).toHaveBeenCalledTimes(VETTE_BETA_TOPICS.length);
		expect(vi.mocked(exec)).toHaveBeenCalledWith(
			"git",
			expect.arrayContaining(["diff", "--unified=80"]),
			expect.any(Object),
		);
	});

	it("formats synthesis instructions to continue through verification and comments", async () => {
		const prompt = formatVetteBetaSynthesisPrompt({
			poolName: "light",
			resolvedPool: [
				{
					index: 0,
					model: "provider/light",
					thinking: "off",
					timeoutMs: 1,
					availability: "available",
				},
			],
			bundle: "diff",
			startedAt: "2026-07-02T10:00:00.000Z",
			finishedAt: "2026-07-02T10:00:03.000Z",
			durationMs: 3000,
			reviewMode: "comment",
			results: [
				{
					topic,
					attempts: [
						{
							model: "provider/light",
							thinking: "off",
							timeoutMs: 1,
							status: "success",
							inputTokens: 100,
							outputTokens: 20,
							durationMs: 2500,
						},
					],
					ok: true,
					output:
						'{"topicId":"correctness","findings":[{"title":"Bug","severity":"concern"}]}',
				},
			],
			target: {
				label: "PR #123",
				prNumber: 123,
				prUrl: "https://github.com/o/r/pull/123",
			},
		});

		expect(prompt).toContain("Timing: started 2026-07-02T10:00:00.000Z");
		expect(prompt).toContain("Usage: tokens in=100 out=20");
		expect(prompt).toContain("connection=provider model=light");
		expect(prompt).toContain("Continue the full vette workflow");
		expect(prompt).toContain("deduplicate all topic findings");
		expect(prompt).toContain("Verify each remaining actionable finding");
		expect(prompt).toContain(
			"post verified findings to https://github.com/o/r/pull/123",
		);
	});

	it("formats owned self reviews as repair work instead of comments", async () => {
		const prompt = formatVetteBetaSynthesisPrompt({
			poolName: "light",
			resolvedPool: [],
			bundle: "diff",
			startedAt: "2026-07-02T10:00:00.000Z",
			finishedAt: "2026-07-02T10:00:03.000Z",
			durationMs: 3000,
			reviewMode: "repair",
			results: [{ topic, attempts: [], ok: true, output: "{}" }],
			target: {
				label: "PR #123",
				prNumber: 123,
				prUrl: "https://github.com/o/r/pull/123",
				reviewMode: "repair",
			},
		});

		expect(prompt).toContain("Mode: owned/self repair");
		expect(prompt).toContain("Do not post or draft PR review comments");
		expect(prompt).toContain(
			"fix confirmed issues directly in the working tree",
		);
		expect(prompt).not.toContain(
			"post verified findings to https://github.com/o/r/pull/123",
		);
	});

	it("builds a compact diff bundle from git output", async () => {
		const bundle = await buildVetteBetaDiffBundle({
			exec: fakeExec(),
			cwd: "/repo",
		});

		expect(bundle).toContain("Range: base..HEAD");
		expect(bundle).toContain("M\textensions/gh-status/watch.ts");
		expect(bundle).toContain("Linear requirements:");
		expect(bundle).toContain("Acceptance criteria:");
		expect(bundle).toContain("Behavior specs:");
		expect(bundle).toContain("features/watch-review.feature");
		expect(bundle).toContain("diff --git");
	});

	it("uses gh pr diff for a selected PR target", async () => {
		const exec = fakeExec();
		const bundle = await buildVetteBetaDiffBundle({
			exec,
			cwd: "/repo",
			target: {
				label: "PR #123",
				headRef: "feature/demo",
				baseRef: "origin/main",
				prNumber: 123,
				prUrl: "https://github.com/o/r/pull/123",
			},
		});

		expect(bundle).toContain("Target: PR #123");
		expect(bundle).toContain("Range: gh pr diff 123");
		expect(bundle).toContain("extensions/pr-vette.ts");
		expect(bundle).toContain("diff --git a/extensions/pr-vette.ts");
		expect(vi.mocked(exec)).toHaveBeenCalledWith(
			"gh",
			["pr", "diff", "123", "--patch"],
			expect.any(Object),
		);
	});

	it("builds a diff bundle for a selected branch target", async () => {
		const exec = fakeExec();
		const bundle = await buildVetteBetaDiffBundle({
			exec,
			cwd: "/repo",
			target: {
				label: "branch feature/demo",
				headRef: "feature/demo",
				baseRef: "origin/develop",
			},
		});

		expect(bundle).toContain("Target: branch feature/demo");
		expect(bundle).toContain("Branch: feature/demo");
		expect(bundle).toContain("Base: origin/develop");
		expect(vi.mocked(exec)).toHaveBeenCalledWith(
			"git",
			expect.arrayContaining(["merge-base", "origin/develop", "feature/demo"]),
			expect.any(Object),
		);
	});
});
