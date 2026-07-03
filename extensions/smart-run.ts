/**
 * smart-run: benchmark-driven sub-agent execution.
 *
 * Usage:
 *   const result = await smartRun({
 *     budget: "cheap",
 *     ceiling: "mid",  // highest tier allowed if cheap has no match
 *     thinking: "low",
 *     prompt: "Review this diff for correctness issues.",
 *     tools: ["read", "grep", "find", "ls"],
 *     needs: ["tools", "correctness", "codeQuality"],
 *     cwd: "/path/to/repo",
 *     runner: spawnPiAgent,
 *   });
 *
 * Picks the closest-matching model from live aistupidlevel.info benchmarks.
 * Starts at the requested budget tier; if nothing matches well enough,
 * escalates up to the ceiling. Falls back through the ranked list on failure.
 */

import {
	getRankings,
	type AxisName,
	type ModelRanking,
	type RankingsTable,
} from "./model-rankings.ts";

// ── Budget tiers ──

export type Tier = "cheap" | "mid" | "high";

const OUTPUT_COST_CEILING: Record<Tier, number> = {
	cheap: 5,
	mid: 15,
	high: Number.MAX_SAFE_INTEGER,
};

const TIER_ORDER: Tier[] = ["cheap", "mid", "high"];

function tiersInRange(budget: Tier, ceiling?: Tier): Tier[] {
	const start = TIER_ORDER.indexOf(budget);
	const end = ceiling ? TIER_ORDER.indexOf(ceiling) : start;
	if (start < 0 || end < start) return [budget];
	return TIER_ORDER.slice(start, end + 1);
}

// ── Needs: what the caller wants from a model ──

const AXIS_NAMES: Set<string> = new Set<string>([
	"correctness",
	"spec",
	"codeQuality",
	"efficiency",
	"stability",
	"refusal",
	"recovery",
]);

export type Need = "tools" | "reliable-tools" | "thinking" | AxisName;

const AXIS_STRONG_THRESHOLD = 0.7;

function needScore(m: ModelRanking, need: Need): number {
	switch (need) {
		case "tools":
			return m.supportsToolCalling ? 1 : 0;
		case "reliable-tools":
			return m.toolCallReliability >= 0.9 ? 1 : m.toolCallReliability;
		case "thinking":
			return m.usesReasoningEffort ? 1 : 0;
		default:
			if (AXIS_NAMES.has(need)) return m.axes[need as AxisName] ?? 0;
			return 0;
	}
}

export type ModelMatch = {
	selector: string;
	model: ModelRanking;
	matchScore: number;
	met: Need[];
	partial: Need[];
	unmet: Need[];
};

function scoreModel(
	m: ModelRanking,
	needs: Need[],
): {
	matchScore: number;
	met: Need[];
	partial: Need[];
	unmet: Need[];
} {
	if (needs.length === 0)
		return { matchScore: 1, met: [], partial: [], unmet: [] };
	const met: Need[] = [];
	const partial: Need[] = [];
	const unmet: Need[] = [];
	let total = 0;
	for (const need of needs) {
		const s = needScore(m, need);
		total += s;
		if (AXIS_NAMES.has(need)) {
			if (s >= AXIS_STRONG_THRESHOLD) met.push(need);
			else if (s > 0) partial.push(need);
			else unmet.push(need);
		} else {
			if (s >= 1) met.push(need);
			else if (s > 0) partial.push(need);
			else unmet.push(need);
		}
	}
	return { matchScore: total / needs.length, met, partial, unmet };
}

// ── Vendor → Pi provider mapping ──

const VENDOR_TO_PROVIDER: Record<string, string> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	deepseek: "deepseek",
	kimi: "openrouter",
	glm: "openrouter",
};

function toPiSelector(model: ModelRanking): string {
	const provider = VENDOR_TO_PROVIDER[model.vendor] ?? "openrouter";
	return `${provider}/${model.name}`;
}

// ── Runner interface (matches vette-beta's PiAgentRunner) ──

export type SmartRunInput = {
	cwd: string;
	prompt: string;
	model: string;
	thinking: string;
	tools: string[];
	timeoutMs: number;
	signal?: AbortSignal;
	extensionPaths?: string[];
};

export type SmartRunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	finalText: string;
	errorMessage?: string;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
};

export type AgentRunner = (input: SmartRunInput) => Promise<SmartRunResult>;

// ── Model availability check ──

type ModelRegistryLike = {
	find?: (provider: string, id: string) => unknown;
};

function splitSelector(
	selector: string,
): { provider: string; id: string } | undefined {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return undefined;
	return { provider: selector.slice(0, slash), id: selector.slice(slash + 1) };
}

function isAvailable(selector: string, registry?: ModelRegistryLike): boolean {
	if (!registry?.find) return true;
	const split = splitSelector(selector);
	if (!split) return false;
	return !!registry.find(split.provider, split.id);
}

// ── Core: pick + rank models in a single tier ──

export function pickModels(
	table: RankingsTable,
	tier: Tier,
	opts?: {
		registry?: ModelRegistryLike;
		needs?: Need[];
	},
): ModelMatch[] {
	const ceiling = OUTPUT_COST_CEILING[tier];
	const needs = opts?.needs ?? [];

	const inBudget = table.models.filter((m) => {
		if (m.costOutput == null) return tier === "high";
		return m.costOutput <= ceiling;
	});

	const scored = inBudget.map((m) => {
		const { matchScore, met, partial, unmet } = scoreModel(m, needs);
		return {
			selector: toPiSelector(m),
			model: m,
			matchScore,
			met,
			partial,
			unmet,
		};
	});

	scored.sort((a, b) => {
		if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
		if (b.model.score !== a.model.score) return b.model.score - a.model.score;
		const aCost = a.model.costOutput ?? Number.MAX_SAFE_INTEGER;
		const bCost = b.model.costOutput ?? Number.MAX_SAFE_INTEGER;
		return aCost - bCost;
	});

	return scored.filter((entry) => isAvailable(entry.selector, opts?.registry));
}

/**
 * Start at `budget`, escalate up to `ceiling` if nothing meets `minMatch`.
 * If no ceiling, stays in the budget tier.
 */
export function pickModelsAcrossBudget(
	table: RankingsTable,
	budget: Tier,
	opts?: {
		ceiling?: Tier;
		registry?: ModelRegistryLike;
		needs?: Need[];
		minMatch?: number;
	},
): { tier: Tier; escalated: boolean; models: ModelMatch[] } {
	const tiers = tiersInRange(budget, opts?.ceiling);
	const needs = opts?.needs ?? [];
	const minMatch = opts?.minMatch ?? 0.5;

	for (const tier of tiers) {
		const models = pickModels(table, tier, { registry: opts?.registry, needs });
		const acceptable = models.filter((m) => m.matchScore >= minMatch);
		if (acceptable.length > 0) {
			return { tier, escalated: tier !== budget, models: acceptable };
		}
		if (needs.length === 0 && models.length > 0) {
			return { tier, escalated: tier !== budget, models };
		}
	}

	// Nothing acceptable at any allowed tier — return best-effort from budget tier
	const fallback = pickModels(table, budget, {
		registry: opts?.registry,
		needs,
	});
	return { tier: budget, escalated: false, models: fallback };
}

// ── Public API ──

export type SmartRunOptions = {
	/** Preferred budget tier */
	budget: Tier;
	/** Highest tier allowed if budget tier has no match (omit = stay in budget) */
	ceiling?: Tier;
	thinking: string;
	prompt: string;
	tools: string[];
	cwd: string;
	runner: AgentRunner;
	/** What capabilities/strengths the model should have */
	needs?: Need[];
	/** Minimum match quality 0..1 (default 0.5) */
	minMatch?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	extensionPaths?: string[];
	modelRegistry?: ModelRegistryLike;
	/** Safety-net selectors tried after all ranked models */
	fallbackSelectors?: string[];
	/** Inject rankings (for testing); undefined = fetch live, null = skip */
	_rankings?: RankingsTable | null;
};

export type SmartRunAttempt = {
	selector: string;
	score: number | null;
	cost: number | null;
	matchScore: number | null;
	status: "success" | "failed" | "skipped";
	errorMessage?: string;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
};

export type SmartRunOutput = {
	ok: boolean;
	finalModel: string | null;
	output: string;
	attempts: SmartRunAttempt[];
	/** Which tier was actually used */
	tier: Tier | null;
	/** Whether it escalated beyond the first requested tier */
	escalated: boolean;
	rankings: { fetchedAt: string; candidateCount: number } | null;
	noMatchReason?: string;
};

const DEFAULT_TIMEOUT_MS = 3 * 60_000;

export async function smartRun(opts: SmartRunOptions): Promise<SmartRunOutput> {
	const attempts: SmartRunAttempt[] = [];
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const table =
		opts._rankings !== undefined ? opts._rankings : await getRankings();

	type Candidate = {
		selector: string;
		score: number | null;
		cost: number | null;
		matchScore: number | null;
	};
	let candidates: Candidate[] = [];
	let tier: Tier | null = null;
	let escalated = false;

	if (table) {
		const pick = pickModelsAcrossBudget(table, opts.budget, {
			ceiling: opts.ceiling,
			registry: opts.modelRegistry,
			needs: opts.needs,
			minMatch: opts.minMatch,
		});
		tier = pick.tier;
		escalated = pick.escalated;
		candidates = pick.models.map((p) => ({
			selector: p.selector,
			score: p.model.score,
			cost: p.model.costOutput,
			matchScore: p.matchScore,
		}));

		const minMatch = opts.minMatch ?? 0.5;
		const bestMatch = candidates[0]?.matchScore ?? 0;
		if (opts.needs && opts.needs.length > 0 && bestMatch < minMatch) {
			const allModels = pickModels(table, "high", { needs: opts.needs });
			const bestAvailable = allModels[0];
			const reason = bestAvailable
				? `Best match across all tiers: ${bestAvailable.selector} (match=${(bestAvailable.matchScore * 100).toFixed(0)}%, unmet: ${bestAvailable.unmet.join(", ")})`
				: `No models have: ${opts.needs.join(", ")}`;
			if (!opts.fallbackSelectors?.length) {
				return {
					ok: false,
					finalModel: null,
					output: "",
					attempts: [],
					tier,
					escalated,
					rankings: { fetchedAt: table.fetchedAt, candidateCount: 0 },
					noMatchReason: reason,
				};
			}
			candidates = [];
		}
	}

	if (opts.fallbackSelectors) {
		const seen = new Set(candidates.map((c) => c.selector));
		for (const sel of opts.fallbackSelectors) {
			if (!seen.has(sel)) {
				candidates.push({
					selector: sel,
					score: null,
					cost: null,
					matchScore: null,
				});
				seen.add(sel);
			}
		}
	}

	if (candidates.length === 0) {
		return {
			ok: false,
			finalModel: null,
			output: "",
			attempts: [],
			tier,
			escalated,
			rankings: null,
		};
	}

	for (const candidate of candidates) {
		if (opts.signal?.aborted) break;

		const result = await opts.runner({
			cwd: opts.cwd,
			prompt: opts.prompt,
			model: candidate.selector,
			thinking: opts.thinking,
			tools: opts.tools,
			timeoutMs,
			signal: opts.signal,
			extensionPaths: opts.extensionPaths,
		});

		const failed =
			result.exitCode !== 0 || result.timedOut || !!result.errorMessage;

		attempts.push({
			selector: candidate.selector,
			score: candidate.score,
			cost: candidate.cost,
			matchScore: candidate.matchScore,
			status: failed ? "failed" : "success",
			errorMessage: failed
				? (result.errorMessage ??
					(result.timedOut ? "timeout" : `exit ${result.exitCode}`))
				: undefined,
			durationMs: result.durationMs,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
		});

		if (!failed) {
			return {
				ok: true,
				finalModel: candidate.selector,
				output: result.finalText || result.stdout,
				attempts,
				tier,
				escalated,
				rankings: table
					? { fetchedAt: table.fetchedAt, candidateCount: candidates.length }
					: null,
			};
		}
	}

	return {
		ok: false,
		finalModel: null,
		output: "",
		attempts,
		tier,
		escalated,
		rankings: table
			? { fetchedAt: table.fetchedAt, candidateCount: candidates.length }
			: null,
	};
}

export function formatSmartRunSummary(result: SmartRunOutput): string {
	const lines: string[] = [];
	if (result.ok) {
		lines.push(`Model: ${result.finalModel}`);
	} else {
		lines.push("All models failed.");
	}
	if (result.escalated) {
		lines.push(`Escalated to tier: ${result.tier}`);
	}
	if (result.noMatchReason) {
		lines.push(`No match: ${result.noMatchReason}`);
	}
	if (result.rankings) {
		lines.push(
			`Rankings: ${result.rankings.candidateCount} candidates (cached ${result.rankings.fetchedAt})`,
		);
	}
	if (result.attempts.length > 1 || !result.ok) {
		lines.push("Attempts:");
		for (const a of result.attempts) {
			const cost = a.cost != null ? `$${a.cost}/MTok` : "n/a";
			const match =
				a.matchScore != null ? `match=${(a.matchScore * 100).toFixed(0)}%` : "";
			const dur =
				a.durationMs != null ? `${(a.durationMs / 1000).toFixed(1)}s` : "";
			const status =
				a.status === "success" ? "ok" : (a.errorMessage ?? "failed");
			lines.push(
				`  ${a.selector} score=${a.score ?? "?"} ${match} cost=${cost} ${dur} → ${status}`,
			);
		}
	}
	return lines.join("\n");
}
