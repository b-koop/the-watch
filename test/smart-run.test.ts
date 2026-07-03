import { describe, expect, it, vi } from "vitest";
import {
	pickModels,
	pickModelsAcrossBudget,
	smartRun,
	formatSmartRunSummary,
	type AgentRunner,
	type SmartRunResult,
} from "../extensions/smart-run.ts";
import type {
	ModelAxes,
	ModelRanking,
	RankingsTable,
} from "../extensions/model-rankings.ts";

const ZERO_AXES: ModelAxes = {
	correctness: 0,
	spec: 0,
	codeQuality: 0,
	efficiency: 0,
	stability: 0,
	refusal: 0,
	recovery: 0,
};

function makeModel(overrides: Partial<ModelRanking>): ModelRanking {
	return {
		id: "1",
		name: "test-model",
		vendor: "anthropic",
		score: 70,
		confidenceLower: 60,
		confidenceUpper: 80,
		trend: "stable",
		costInput: 3,
		costOutput: 15,
		costNote: "$3/$15 per MTok",
		axes: { ...ZERO_AXES },
		supportsToolCalling: false,
		toolCallReliability: 0,
		maxToolsPerCall: 0,
		usesReasoningEffort: false,
		...overrides,
	};
}

function makeTable(models: ModelRanking[]): RankingsTable {
	return { fetchedAt: new Date().toISOString(), models };
}

function successResult(text = "ok"): SmartRunResult {
	return { exitCode: 0, stdout: text, stderr: "", finalText: text };
}

function failResult(msg = "boom"): SmartRunResult {
	return {
		exitCode: 1,
		stdout: "",
		stderr: msg,
		finalText: "",
		errorMessage: msg,
	};
}

// ── pickModels ──

describe("pickModels", () => {
	const table = makeTable([
		makeModel({
			name: "cheap-good",
			score: 80,
			costOutput: 2,
			vendor: "deepseek",
		}),
		makeModel({
			name: "mid-good",
			score: 75,
			costOutput: 10,
			vendor: "openai",
		}),
		makeModel({
			name: "expensive",
			score: 90,
			costOutput: 25,
			vendor: "anthropic",
		}),
		makeModel({
			name: "no-price",
			score: 85,
			costOutput: null,
			vendor: "anthropic",
		}),
	]);

	it("cheap tier filters to models ≤$5 output", () => {
		const result = pickModels(table, "cheap");
		expect(result).toHaveLength(1);
		expect(result[0].model.name).toBe("cheap-good");
	});

	it("mid tier filters to models ≤$15 output", () => {
		const result = pickModels(table, "mid");
		expect(result).toHaveLength(2);
	});

	it("high tier includes everything including unknown-price models", () => {
		const result = pickModels(table, "high");
		expect(result).toHaveLength(4);
	});

	it("ranks by match score when needs are provided", () => {
		const t = makeTable([
			makeModel({
				name: "no-tools",
				score: 90,
				costOutput: 3,
				vendor: "openai",
				supportsToolCalling: false,
				axes: { ...ZERO_AXES, correctness: 0.9 },
			}),
			makeModel({
				name: "has-tools",
				score: 60,
				costOutput: 4,
				vendor: "openai",
				supportsToolCalling: true,
				axes: { ...ZERO_AXES, correctness: 0.8 },
			}),
		]);
		const result = pickModels(t, "mid", { needs: ["tools", "correctness"] });
		expect(result[0].model.name).toBe("has-tools");
		expect(result[0].matchScore).toBeGreaterThan(result[1].matchScore);
	});

	it("scores partial axis matches", () => {
		const t = makeTable([
			makeModel({
				name: "partial",
				score: 70,
				costOutput: 3,
				vendor: "openai",
				axes: { ...ZERO_AXES, correctness: 0.5 },
			}),
		]);
		const result = pickModels(t, "mid", { needs: ["correctness"] });
		expect(result[0].matchScore).toBeGreaterThan(0);
		expect(result[0].matchScore).toBeLessThan(1);
		expect(result[0].partial).toContain("correctness");
	});

	it("reports unmet needs", () => {
		const t = makeTable([
			makeModel({
				name: "bare",
				score: 70,
				costOutput: 3,
				vendor: "openai",
				supportsToolCalling: false,
				usesReasoningEffort: false,
			}),
		]);
		const result = pickModels(t, "mid", { needs: ["tools", "thinking"] });
		expect(result[0].unmet).toContain("tools");
		expect(result[0].unmet).toContain("thinking");
		expect(result[0].matchScore).toBe(0);
	});

	it("uses overall score as tiebreaker when match scores are equal", () => {
		const t = makeTable([
			makeModel({
				name: "lower-score",
				score: 60,
				costOutput: 3,
				vendor: "openai",
				supportsToolCalling: true,
			}),
			makeModel({
				name: "higher-score",
				score: 80,
				costOutput: 4,
				vendor: "openai",
				supportsToolCalling: true,
			}),
		]);
		const result = pickModels(t, "mid", { needs: ["tools"] });
		expect(result[0].model.name).toBe("higher-score");
	});
});

// ── pickModelsAcrossBudget ──

describe("pickModelsAcrossBudget", () => {
	const table = makeTable([
		makeModel({
			name: "cheap-no-tools",
			score: 80,
			costOutput: 2,
			vendor: "deepseek",
			supportsToolCalling: false,
		}),
		makeModel({
			name: "mid-with-tools",
			score: 75,
			costOutput: 10,
			vendor: "openai",
			supportsToolCalling: true,
			toolCallReliability: 0.95,
		}),
		makeModel({
			name: "expensive-all",
			score: 90,
			costOutput: 25,
			vendor: "anthropic",
			supportsToolCalling: true,
			toolCallReliability: 0.95,
			usesReasoningEffort: true,
			axes: { ...ZERO_AXES, correctness: 1, codeQuality: 0.9 },
		}),
	]);

	it("stays in budget when match is good enough", () => {
		const result = pickModelsAcrossBudget(table, "mid", {
			ceiling: "high",
			needs: ["tools"],
		});
		expect(result.tier).toBe("mid");
		expect(result.escalated).toBe(false);
		expect(result.models[0].model.name).toBe("mid-with-tools");
	});

	it("escalates to ceiling when budget has no match", () => {
		const result = pickModelsAcrossBudget(table, "cheap", {
			ceiling: "mid",
			needs: ["tools"],
			minMatch: 0.8,
		});
		expect(result.tier).toBe("mid");
		expect(result.escalated).toBe(true);
		expect(result.models[0].model.name).toBe("mid-with-tools");
	});

	it("does NOT escalate when no ceiling set", () => {
		const result = pickModelsAcrossBudget(table, "cheap", {
			needs: ["tools"],
			minMatch: 0.8,
		});
		expect(result.tier).toBe("cheap");
		expect(result.escalated).toBe(false);
	});

	it("escalates through mid to high if mid also insufficient", () => {
		const result = pickModelsAcrossBudget(table, "cheap", {
			ceiling: "high",
			needs: ["tools", "thinking", "correctness"],
			minMatch: 0.8,
		});
		expect(result.tier).toBe("high");
		expect(result.escalated).toBe(true);
		expect(result.models[0].model.name).toBe("expensive-all");
	});

	it("stops at ceiling even if higher tiers have better matches", () => {
		const result = pickModelsAcrossBudget(table, "cheap", {
			ceiling: "mid",
			needs: ["tools", "thinking", "correctness"],
			minMatch: 0.8,
		});
		// mid doesn't have thinking+correctness, so falls back to best-effort from cheap
		expect(result.tier).toBe("cheap");
		expect(result.escalated).toBe(false);
	});

	it("returns budget tier models when no needs specified", () => {
		const result = pickModelsAcrossBudget(table, "cheap", { ceiling: "high" });
		expect(result.tier).toBe("cheap");
		expect(result.models.length).toBeGreaterThan(0);
	});
});

// ── smartRun ──

describe("smartRun", () => {
	it("uses fallbackSelectors when no rankings available", async () => {
		const runner = vi
			.fn<AgentRunner>()
			.mockResolvedValueOnce(successResult("done"));

		const result = await smartRun({
			budget: "cheap",
			thinking: "off",
			prompt: "test",
			tools: ["read"],
			cwd: "/tmp",
			runner,
			fallbackSelectors: ["openai/gpt-4o-mini"],
			_rankings: null,
		});

		expect(result.ok).toBe(true);
		expect(result.finalModel).toBe("openai/gpt-4o-mini");
		expect(runner).toHaveBeenCalledOnce();
	});

	it("falls back to next model on failure", async () => {
		const runner = vi
			.fn<AgentRunner>()
			.mockResolvedValueOnce(failResult("rate limited"))
			.mockResolvedValueOnce(successResult("ok from second"));

		const result = await smartRun({
			budget: "cheap",
			thinking: "low",
			prompt: "test",
			tools: ["read"],
			cwd: "/tmp",
			runner,
			fallbackSelectors: ["openai/bad-model", "anthropic/claude-haiku-4.5"],
			_rankings: null,
		});

		expect(result.ok).toBe(true);
		expect(result.finalModel).toBe("anthropic/claude-haiku-4.5");
		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0].status).toBe("failed");
		expect(result.attempts[1].status).toBe("success");
	});

	it("returns ok=false when all candidates fail", async () => {
		const runner = vi.fn<AgentRunner>().mockResolvedValue(failResult("nope"));

		const result = await smartRun({
			budget: "cheap",
			thinking: "off",
			prompt: "test",
			tools: [],
			cwd: "/tmp",
			runner,
			fallbackSelectors: ["a/b", "c/d"],
			_rankings: null,
		});

		expect(result.ok).toBe(false);
		expect(result.attempts).toHaveLength(2);
	});

	it("picks best-matching model from rankings with needs", async () => {
		const runner = vi
			.fn<AgentRunner>()
			.mockResolvedValue(successResult("reviewed"));
		const table = makeTable([
			makeModel({
				name: "bad-match",
				score: 90,
				costOutput: 3,
				vendor: "openai",
				supportsToolCalling: false,
			}),
			makeModel({
				name: "good-match",
				score: 70,
				costOutput: 4,
				vendor: "openai",
				supportsToolCalling: true,
				axes: { ...ZERO_AXES, correctness: 0.9 },
			}),
		]);

		const result = await smartRun({
			budget: "mid",
			thinking: "low",
			prompt: "review",
			tools: ["read"],
			cwd: "/tmp",
			runner,
			needs: ["tools", "correctness"],
			_rankings: table,
		});

		expect(result.ok).toBe(true);
		expect(result.finalModel).toBe("openai/good-match");
	});

	it("escalates tier when ceiling allows", async () => {
		const runner = vi.fn<AgentRunner>().mockResolvedValue(successResult("ok"));
		const table = makeTable([
			makeModel({
				name: "cheap-bad",
				score: 80,
				costOutput: 2,
				vendor: "openai",
				supportsToolCalling: false,
			}),
			makeModel({
				name: "mid-good",
				score: 75,
				costOutput: 10,
				vendor: "openai",
				supportsToolCalling: true,
			}),
		]);

		const result = await smartRun({
			budget: "cheap",
			ceiling: "mid",
			thinking: "off",
			prompt: "test",
			tools: ["read"],
			cwd: "/tmp",
			runner,
			needs: ["tools"],
			minMatch: 0.8,
			_rankings: table,
		});

		expect(result.ok).toBe(true);
		expect(result.escalated).toBe(true);
		expect(result.tier).toBe("mid");
	});

	it("returns noMatchReason when nothing fits and no fallbacks", async () => {
		const runner = vi.fn<AgentRunner>();
		const table = makeTable([
			makeModel({
				name: "only-model",
				score: 80,
				costOutput: 2,
				vendor: "openai",
			}),
		]);

		const result = await smartRun({
			budget: "cheap",
			thinking: "off",
			prompt: "test",
			tools: [],
			cwd: "/tmp",
			runner,
			needs: ["tools", "thinking"],
			minMatch: 0.8,
			_rankings: table,
		});

		expect(result.ok).toBe(false);
		expect(result.noMatchReason).toBeDefined();
		expect(runner).not.toHaveBeenCalled();
	});
});

// ── formatSmartRunSummary ──

describe("formatSmartRunSummary", () => {
	it("shows model on success", () => {
		const summary = formatSmartRunSummary({
			ok: true,
			finalModel: "openai/gpt-5.3-codex",
			output: "result",
			attempts: [
				{
					selector: "openai/gpt-5.3-codex",
					score: 61,
					cost: 5,
					matchScore: 0.9,
					status: "success",
				},
			],
			tier: "cheap",
			escalated: false,
			rankings: { fetchedAt: "2026-07-03T10:00:00Z", candidateCount: 5 },
		});
		expect(summary).toContain("openai/gpt-5.3-codex");
	});

	it("shows escalation info", () => {
		const summary = formatSmartRunSummary({
			ok: true,
			finalModel: "openai/model",
			output: "",
			attempts: [
				{
					selector: "openai/model",
					score: 70,
					cost: 10,
					matchScore: 0.8,
					status: "success",
				},
			],
			tier: "mid",
			escalated: true,
			rankings: null,
		});
		expect(summary).toContain("Escalated");
		expect(summary).toContain("mid");
	});

	it("shows all attempts on failure", () => {
		const summary = formatSmartRunSummary({
			ok: false,
			finalModel: null,
			output: "",
			attempts: [
				{
					selector: "a/b",
					score: 70,
					cost: 5,
					matchScore: 0.9,
					status: "failed",
					errorMessage: "timeout",
				},
				{
					selector: "c/d",
					score: 60,
					cost: 2,
					matchScore: 0.6,
					status: "failed",
					errorMessage: "exit 1",
				},
			],
			tier: "cheap",
			escalated: false,
			rankings: null,
		});
		expect(summary).toContain("All models failed");
		expect(summary).toContain("match=90%");
	});

	it("shows noMatchReason", () => {
		const summary = formatSmartRunSummary({
			ok: false,
			finalModel: null,
			output: "",
			attempts: [],
			tier: "cheap",
			escalated: false,
			rankings: null,
			noMatchReason: "No models have: tools, thinking",
		});
		expect(summary).toContain("No match:");
		expect(summary).toContain("tools, thinking");
	});
});
