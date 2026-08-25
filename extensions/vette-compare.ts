import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { GhSnapshot } from "./gh-status/types.ts";
import {
	type VetteBetaCooldown,
	type PiAgentRunner,
	type VetteBetaConfig,
	type VetteBetaReviewTarget,
	type VetteBetaRunResult,
	type VetteBetaTopic,
	VETTE_BETA_TOPICS,
	runVetteBetaReview,
} from "./vette-beta.ts";

export type ParsedVetteCompareArgs = {
	listModels?: boolean;
	targetArg?: string;
	topics?: VetteBetaTopic[];
	remoteModel?: string;
	localModel?: string;
};

function readFlagValue(
	tokens: readonly string[],
	flag: string,
): string | undefined {
	const index = tokens.indexOf(flag);
	if (index < 0) return undefined;
	const value = tokens[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${flag}.`);
	}
	return value;
}

function stripFlags(
	tokens: readonly string[],
	flags: readonly string[],
): string[] {
	const skip = new Set<number>();
	for (const flag of flags) {
		const index = tokens.indexOf(flag);
		if (index < 0) continue;
		skip.add(index);
		if (tokens[index + 1] && !tokens[index + 1].startsWith("--")) {
			skip.add(index + 1);
		}
	}
	return tokens.filter((_, index) => !skip.has(index));
}

export function parseVetteCompareArgs(
	args: string,
	topicsCatalog: readonly VetteBetaTopic[] = VETTE_BETA_TOPICS,
): ParsedVetteCompareArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 1 && tokens[0].toLowerCase() === "models") {
		return { listModels: true };
	}

	const topicIds = readFlagValue(tokens, "--topics")
		?.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	const remoteModel = readFlagValue(tokens, "--model");
	const localModel = readFlagValue(tokens, "--local");
	const filtered = stripFlags(tokens, ["--topics", "--model", "--local"]);

	const topics = topicIds
		? topicsCatalog.filter((topic) => topicIds.includes(topic.id))
		: undefined;
	if (topicIds && topics && topics.length !== topicIds.length) {
		const known = new Set(topicsCatalog.map((topic) => topic.id));
		const unknown = topicIds.filter((id) => !known.has(id));
		throw new Error(`Unknown topic id(s) in --topics: ${unknown.join(", ")}`);
	}

	return {
		...(filtered[0] ? { targetArg: filtered[0] } : {}),
		...(topics ? { topics } : {}),
		...(remoteModel ? { remoteModel } : {}),
		...(localModel ? { localModel } : {}),
	};
}

export type VetteCompareFinding = {
	topicId: string;
	topicLabel: string;
	title: string;
	severity: string;
	file: string;
	line?: number;
	evidence: string;
	recommendation: string;
};

export type VetteCompareLeg = {
	label: string;
	model: string;
	run: VetteBetaRunResult;
	findings: VetteCompareFinding[];
};

export type VetteCompareOverlap = {
	remote: VetteCompareFinding;
	local: VetteCompareFinding;
};

export type VetteCompareResult = {
	targetLabel: string;
	remote: VetteCompareLeg;
	local: VetteCompareLeg;
	overlap: VetteCompareOverlap[];
	remoteOnly: VetteCompareFinding[];
	localOnly: VetteCompareFinding[];
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function extractVetteCompareFindings(
	run: VetteBetaRunResult,
): VetteCompareFinding[] {
	const findings: VetteCompareFinding[] = [];
	for (const result of run.results) {
		if (!result.ok || !isObject(result.parsed)) continue;
		const parsedFindings = result.parsed.findings;
		if (!Array.isArray(parsedFindings)) continue;
		for (const finding of parsedFindings) {
			if (!isObject(finding)) continue;
			findings.push({
				topicId: result.topic.id,
				topicLabel: result.topic.label,
				title: String(finding.title ?? "").trim(),
				severity: String(finding.severity ?? "").trim(),
				file: String(finding.file ?? "").trim(),
				line:
					typeof finding.line === "number" && Number.isFinite(finding.line)
						? finding.line
						: undefined,
				evidence: String(finding.evidence ?? "").trim(),
				recommendation: String(finding.recommendation ?? "").trim(),
			});
		}
	}
	return findings;
}

function normalizeFindingTitle(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeFindingFile(file: string): string {
	return file
		.trim()
		.replace(/^\.\//, "")
		.replace(/^[ab]\//, "")
		.split(":")[0]
		.toLowerCase();
}

export function findingMatchKey(finding: VetteCompareFinding): string {
	return [
		finding.topicId,
		normalizeFindingFile(finding.file),
		normalizeFindingTitle(finding.title),
	].join("|");
}

export function compareVetteFindings(input: {
	remote: readonly VetteCompareFinding[];
	local: readonly VetteCompareFinding[];
}): Pick<VetteCompareResult, "overlap" | "remoteOnly" | "localOnly"> {
	const localByKey = new Map<string, VetteCompareFinding[]>();
	for (const finding of input.local) {
		const key = findingMatchKey(finding);
		const bucket = localByKey.get(key);
		if (bucket) bucket.push(finding);
		else localByKey.set(key, [finding]);
	}

	const overlap: VetteCompareOverlap[] = [];
	const remoteOnly: VetteCompareFinding[] = [];
	const matchedLocalKeys = new Set<string>();

	for (const remoteFinding of input.remote) {
		const key = findingMatchKey(remoteFinding);
		const localMatches = localByKey.get(key);
		if (!localMatches || localMatches.length === 0) {
			remoteOnly.push(remoteFinding);
			continue;
		}
		const localFinding = localMatches.shift();
		if (!localFinding) {
			remoteOnly.push(remoteFinding);
			continue;
		}
		matchedLocalKeys.add(key);
		overlap.push({ remote: remoteFinding, local: localFinding });
	}

	const localOnly = input.local.filter((finding) => {
		const key = findingMatchKey(finding);
		if (!matchedLocalKeys.has(key)) return true;
		const bucket = localByKey.get(key);
		return bucket !== undefined && bucket.length > 0;
	});

	return { overlap, remoteOnly, localOnly };
}

function formatFindingLine(finding: VetteCompareFinding): string {
	const location =
		finding.file.length > 0
			? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
			: "no file";
	const severity = finding.severity ? ` [${finding.severity}]` : "";
	return `- **${finding.topicLabel}**${severity}: ${finding.title} (${location})`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "?";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function formatVetteCompareReport(result: VetteCompareResult): string {
	const remoteCount = result.remote.findings.length;
	const localCount = result.local.findings.length;
	const lines = [
		"# Vette model comparison",
		"",
		`Target: ${result.targetLabel}`,
		`Remote model: ${result.remote.model}`,
		`Local model: ${result.local.model}`,
		"",
		"## Summary",
		`- Remote findings: ${remoteCount}`,
		`- Local findings: ${localCount}`,
		`- Overlap: ${result.overlap.length}`,
		`- Remote only: ${result.remoteOnly.length}`,
		`- Local only: ${result.localOnly.length}`,
		`- Remote duration: ${formatDuration(result.remote.run.durationMs)}`,
		`- Local duration: ${formatDuration(result.local.run.durationMs)}`,
		"",
	];

	if (result.overlap.length > 0) {
		lines.push("## Overlap (both models flagged)", "");
		for (const pair of result.overlap) {
			lines.push(formatFindingLine(pair.remote));
			if (
				pair.remote.evidence &&
				pair.local.evidence !== pair.remote.evidence
			) {
				lines.push(`  - remote evidence: ${pair.remote.evidence}`);
				lines.push(`  - local evidence: ${pair.local.evidence}`);
			}
		}
		lines.push("");
	}

	if (result.remoteOnly.length > 0) {
		lines.push("## Remote only", "");
		for (const finding of result.remoteOnly) {
			lines.push(formatFindingLine(finding));
		}
		lines.push("");
	}

	if (result.localOnly.length > 0) {
		lines.push("## Local only", "");
		for (const finding of result.localOnly) {
			lines.push(formatFindingLine(finding));
		}
		lines.push("");
	}

	const topicIds = [
		...new Set([
			...result.remote.findings.map((finding) => finding.topicId),
			...result.local.findings.map((finding) => finding.topicId),
		]),
	];
	if (topicIds.length > 0) {
		lines.push("## Per-topic counts", "");
		lines.push("| Topic | Remote | Local | Overlap |");
		lines.push("| --- | ---: | ---: | ---: |");
		for (const topicId of topicIds) {
			const remoteTopic = result.remote.findings.filter(
				(finding) => finding.topicId === topicId,
			);
			const localTopic = result.local.findings.filter(
				(finding) => finding.topicId === topicId,
			);
			const topicLabel =
				remoteTopic[0]?.topicLabel ?? localTopic[0]?.topicLabel ?? topicId;
			const remoteKeys = new Set(
				remoteTopic.map((finding) => findingMatchKey(finding)),
			);
			const localKeys = new Set(
				localTopic.map((finding) => findingMatchKey(finding)),
			);
			let overlapCount = 0;
			for (const key of remoteKeys) {
				if (localKeys.has(key)) overlapCount += 1;
			}
			lines.push(
				`| ${topicLabel} | ${remoteTopic.length} | ${localTopic.length} | ${overlapCount} |`,
			);
		}
	}

	return lines.join("\n").trimEnd();
}

export function formatVetteCompareSummary(result: VetteCompareResult): string {
	return [
		`/vette compare complete for ${result.targetLabel}`,
		`remote ${result.remote.model}: ${result.remote.findings.length} finding(s) in ${formatDuration(result.remote.run.durationMs)}`,
		`local ${result.local.model}: ${result.local.findings.length} finding(s) in ${formatDuration(result.local.run.durationMs)}`,
		`overlap ${result.overlap.length} | remote-only ${result.remoteOnly.length} | local-only ${result.localOnly.length}`,
	].join("\n");
}

export function vetteCompareArtifactPath(branchSlug: string): string {
	return `/tmp/pi-vette-findings/${branchSlug}/model-compare.md`;
}

export async function writeVetteCompareArtifact(
	artifactPath: string,
	report: string,
): Promise<void> {
	await mkdir(dirname(artifactPath), { recursive: true });
	await writeFile(artifactPath, `${report}\n`, "utf8");
}

export async function runVetteBetaCompare(input: {
	ctx: ExtensionCommandContext;
	pi: Pick<ExtensionAPI, "exec">;
	config: VetteBetaConfig;
	cooldown: VetteBetaCooldown;
	remotePoolName: string;
	localPoolName: string;
	remoteModel: string;
	localModel: string;
	targetLabel: string;
	snapshot?: GhSnapshot;
	target?: VetteBetaReviewTarget;
	topics?: VetteBetaTopic[];
	runner?: PiAgentRunner;
	onLegStart?: (leg: "remote" | "local") => void;
	onLegComplete?: (leg: "remote" | "local", run: VetteBetaRunResult) => void;
}): Promise<VetteCompareResult> {
	input.onLegStart?.("remote");
	const remoteRun = await runVetteBetaReview({
		ctx: input.ctx,
		pi: input.pi,
		config: input.config,
		cooldown: input.cooldown,
		reviewMode: "doc",
		poolName: input.remotePoolName,
		...(input.snapshot ? { snapshot: input.snapshot } : {}),
		...(input.target ? { target: input.target } : {}),
		...(input.topics ? { topics: input.topics } : {}),
		...(input.runner ? { runner: input.runner } : {}),
	});
	input.onLegComplete?.("remote", remoteRun);

	if (remoteRun.aborted || input.ctx.signal?.aborted) {
		throw new Error("/vette compare aborted during remote leg.");
	}

	input.onLegStart?.("local");
	const localRun = await runVetteBetaReview({
		ctx: input.ctx,
		pi: input.pi,
		config: input.config,
		cooldown: input.cooldown,
		reviewMode: "doc",
		poolName: input.localPoolName,
		...(input.snapshot ? { snapshot: input.snapshot } : {}),
		...(input.target ? { target: input.target } : {}),
		...(input.topics ? { topics: input.topics } : {}),
		...(input.runner ? { runner: input.runner } : {}),
	});
	input.onLegComplete?.("local", localRun);

	if (localRun.aborted || input.ctx.signal?.aborted) {
		throw new Error("/vette compare aborted during local leg.");
	}

	const remoteFindings = extractVetteCompareFindings(remoteRun);
	const localFindings = extractVetteCompareFindings(localRun);
	const compared = compareVetteFindings({
		remote: remoteFindings,
		local: localFindings,
	});

	return {
		targetLabel: input.targetLabel,
		remote: {
			label: "remote",
			model: input.remoteModel,
			run: remoteRun,
			findings: remoteFindings,
		},
		local: {
			label: "local",
			model: input.localModel,
			run: localRun,
			findings: localFindings,
		},
		...compared,
	};
}
