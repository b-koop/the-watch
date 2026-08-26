#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildVetteBetaDiffBundle,
	VetteBetaDiffError,
	wrapUntrustedContent,
	type VetteBetaReviewTarget,
} from "../extensions/vette-beta.ts";
import { discoverReviewers } from "../extensions/vette-reviewers.ts";
import { resolveVetteBetaTarget } from "../extensions/pr-vette.ts";
import { nodeExec } from "./vette-exec.ts";

export type VettePrepareMode = "comment" | "repair" | "doc";

/**
 * Per-lane reasoning effort, mirroring pi's `vetteBeta.topicThinking`. Lanes
 * absent from this map inherit the caller's default.
 */
export const LANE_EFFORT: Record<string, string> = {
	"security-data": "high",
	"async-state": "high",
	correctness: "medium",
	"error-handling": "medium",
	contracts: "medium",
	maintainability: "medium",
	requirements: "medium",
	"behavior-specs": "medium",
	"test-quality": "low",
	"test-scenarios": "low",
	typescript: "medium",
	javascript: "medium",
	naming: "low",
};

/**
 * Per-lane model tier. Lanes are the bulk of a run's token spend — every one of
 * them re-reads the whole diff bundle — so none of them inherit the session
 * model, which on an Opus session bills at 5x Haiku's input rate for work that
 * does not need it.
 *
 * Every lane runs on `haiku`. Lane firepower is not what keeps wrong findings
 * out — the adversarial verify pass is, and that stays on `sonnet`. Raising a
 * lane's recall costs the bundle re-read at the higher rate on every lane it is
 * applied to, so the cheap-lanes/expensive-gate split is the better trade. Pin
 * an individual lane higher here when a run proves it needs more; `--model
 * <tier>` raises the whole run at once.
 */
export const LANE_MODEL: Record<string, string> = {
	naming: "haiku",
	"test-quality": "haiku",
	"test-scenarios": "haiku",
	maintainability: "haiku",
	"security-data": "haiku",
	"async-state": "haiku",
	correctness: "haiku",
	"error-handling": "haiku",
	contracts: "haiku",
	requirements: "haiku",
	"behavior-specs": "haiku",
	typescript: "haiku",
	javascript: "haiku",
};

/** Lanes absent from `LANE_MODEL` — including repository-local ones. */
export const DEFAULT_LANE_MODEL = "haiku";

/**
 * Refuting a finding is the quality gate, and the only stage that reads real
 * source rather than the bundle. It does not go on the cheapest tier — with
 * every lane on haiku, this pass is what stands between a plausible-sounding
 * lane finding and a posted comment.
 */
export const VERIFY_MODEL = "sonnet";

/** One call per run, and it writes the comment payload. */
export const SYNTHESIS_MODEL = "sonnet";

export const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"];

/**
 * Haiku 4.5 holds 200K tokens against Sonnet's 1M. Past roughly a third of that
 * in bundle text alone — leaving room for reviewer bodies, tool results, and
 * output — a haiku lane would truncate, so those lanes move up a tier instead.
 */
export const HAIKU_BUNDLE_CHAR_LIMIT = 400_000;

/** Lanes whose "no findings" answer must be confirmed by a second agent. */
export const SECOND_CLEAN_CHECK = ["security-data", "async-state"];

/** The tier a lane runs on, given the bundle it has to read. */
export function laneModel(name: string, bundleChars: number): string {
	const tier = LANE_MODEL[name] ?? DEFAULT_LANE_MODEL;
	if (tier === "haiku" && bundleChars > HAIKU_BUNDLE_CHAR_LIMIT) return "sonnet";
	return tier;
}

export type PrepareArgs = {
	selector?: string;
	mode?: VettePrepareMode;
	regression: boolean;
	runDir?: string;
	/** Overrides every lane's tier, for a run that wants more (or less) firepower. */
	model?: string;
};

export function parsePrepareArgs(argv: string[]): PrepareArgs {
	const result: PrepareArgs = { regression: false };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--pr" || token === "--selector") result.selector = argv[++i];
		else if (token === "--mode") {
			const value = argv[++i];
			if (value !== "comment" && value !== "repair" && value !== "doc")
				throw new Error("--mode must be comment, repair, or doc");
			result.mode = value;
		} else if (token === "--model") {
			const value = argv[++i];
			if (!MODEL_TIERS.includes(value))
				throw new Error(`--model must be one of ${MODEL_TIERS.join(", ")}`);
			result.model = value;
		} else if (token === "--run-dir") result.runDir = argv[++i];
		else if (token === "--regression") result.regression = true;
		else if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
		else if (!result.selector) result.selector = token;
		else throw new Error("Only one pull-request selector is allowed");
	}
	return result;
}

function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

export type PrepareManifest = {
	bundlePath: string;
	/**
	 * The wrapped bundle inline. Lane prompts embed this identically ahead of
	 * anything lane-specific, so every lane shares one cacheable prefix; having
	 * each lane read the file instead would arrive as a tool result and share
	 * no prefix at all.
	 */
	bundleText: string;
	changedPaths: string[];
	reviewers: Array<{
		name: string;
		prompt: string;
		body: string;
		effort: string;
		/** Model tier this lane runs on — see `LANE_MODEL`. */
		model: string;
		priority: number;
		matchReason: string;
	}>;
	/** Tier for the adversarial verifiers. */
	verifyModel: string;
	/** Tier for the single synthesis call. */
	synthesisModel: string;
	mode: VettePrepareMode;
	label: string;
	runDir: string;
	prNumber?: number;
	prUrl?: string;
	secondCleanCheck: string[];
	skipped: Array<{ name: string; reason: string }>;
};

export async function prepare(
	args: PrepareArgs,
	cwd = process.cwd(),
): Promise<PrepareManifest> {
	const target: VetteBetaReviewTarget | undefined = await resolveVetteBetaTarget(
		args.selector,
		cwd,
	);
	const effectiveTarget =
		target && args.regression ? { ...target, regression: true } : target;

	const bundle = await buildVetteBetaDiffBundle({
		exec: nodeExec,
		cwd,
		...(effectiveTarget ? { target: effectiveTarget } : {}),
	});

	// Reviewing an empty diff is how hallucinated findings got in before; fail
	// loudly instead of fanning out over nothing.
	if (bundle.isEmpty) {
		throw new VetteBetaDiffError(
			`No reviewable diff for ${target?.label ?? "the current worktree"}. Refusing to review an empty change.`,
		);
	}

	const catalog = await discoverReviewers(cwd, bundle.changedPaths);
	if (catalog.selected.length === 0) {
		throw new VetteBetaDiffError(
			`No reviewer matched the ${bundle.changedPaths.length} changed file(s). Nothing to review.`,
		);
	}

	const label = target?.label ?? "current worktree";
	const runDir =
		args.runDir ?? join(tmpdir(), "claude-vette", slug(label));
	mkdirSync(runDir, { recursive: true });

	const bundlePath = join(runDir, "bundle.md");
	const bundleText = wrapUntrustedContent("diff/context bundle", bundle.text);
	writeFileSync(bundlePath, bundleText, "utf8");

	const mode: VettePrepareMode =
		args.mode ??
		(target?.reviewMode === "repair"
			? "repair"
			: target?.reviewMode === "doc"
				? "doc"
				: "comment");

	return {
		bundlePath,
		bundleText,
		changedPaths: bundle.changedPaths,
		reviewers: catalog.selected.map((reviewer) => ({
			name: reviewer.name,
			prompt: reviewer.selector ?? reviewer.description,
			body: reviewer.body,
			effort: LANE_EFFORT[reviewer.name] ?? "medium",
			model: args.model ?? laneModel(reviewer.name, bundleText.length),
			priority: reviewer.priority,
			matchReason: reviewer.matchReason,
		})),
		verifyModel: args.model ?? VERIFY_MODEL,
		synthesisModel: args.model ?? SYNTHESIS_MODEL,
		mode,
		label,
		runDir,
		...(target?.prNumber ? { prNumber: target.prNumber } : {}),
		...(target?.prUrl ? { prUrl: target.prUrl } : {}),
		secondCleanCheck: SECOND_CLEAN_CHECK.filter((name) =>
			catalog.selected.some((reviewer) => reviewer.name === name),
		),
		skipped: catalog.skipped,
	};
}

if (process.argv[1]?.endsWith("vette-prepare.ts")) {
	try {
		const manifest = await prepare(parsePrepareArgs(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
	} catch (error) {
		process.stderr.write(
			`vette-prepare failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
