import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { GhSnapshot } from "./gh-status/types.ts";

type TextBlock = { type: "text"; text: string };
type LocalMessage = {
	role: string;
	content: Array<TextBlock | { type: string; [key: string]: unknown }>;
};

export type VetteBetaModelEntry = {
	model: string;
	thinking?: string;
	timeoutMs?: number;
};

export type VetteBetaConfig = {
	modelPools: Record<string, VetteBetaModelEntry[]>;
	vetteBeta: {
		modelPool: string;
		maxParallel: number;
		tools: string[];
		topicThinking: Record<string, string>;
	};
};

type PartialVetteBetaConfig = {
	modelPools?: Record<string, VetteBetaModelEntry[]>;
	vetteBeta?: {
		modelPool?: string;
		maxParallel?: number;
		tools?: string[];
		topicThinking?: Record<string, string>;
	};
};

export type ResolvedModelEntry = VetteBetaModelEntry & {
	index: number;
	availability: "available" | "missing" | "unknown";
	availabilityReason?: string;
};

export type VetteBetaTopic = {
	id: string;
	label: string;
	prompt: string;
};

export type VetteBetaAttempt = {
	model: string;
	thinking: string;
	timeoutMs: number;
	status: "success" | "failed" | "skipped";
	skippedReason?: string;
	exitCode?: number;
	timedOut?: boolean;
	errorMessage?: string;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
};

export type VetteBetaTopicResult = {
	topic: VetteBetaTopic;
	attempts: VetteBetaAttempt[];
	finalModel?: string;
	ok: boolean;
	output: string;
	parsed?: unknown;
	errorMessage?: string;
};

export type VetteBetaReviewMode = "comment" | "repair";

export type VetteBetaReviewTarget = {
	label: string;
	headRef?: string;
	baseRef?: string;
	prNumber?: number;
	prUrl?: string;
	title?: string;
	body?: string;
	reviewMode?: VetteBetaReviewMode;
};

export type VetteBetaRunResult = {
	poolName: string;
	resolvedPool: ResolvedModelEntry[];
	bundle: string;
	results: VetteBetaTopicResult[];
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	reviewMode: VetteBetaReviewMode;
	target?: VetteBetaReviewTarget;
};

export type PiAgentRunInput = {
	cwd: string;
	prompt: string;
	model: string;
	thinking: string;
	tools: string[];
	timeoutMs: number;
	signal?: AbortSignal;
};

export type PiAgentRunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	messages: LocalMessage[];
	finalText: string;
	errorMessage?: string;
	stopReason?: string;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
};

export type PiAgentRunner = (
	input: PiAgentRunInput,
) => Promise<PiAgentRunResult>;

type ModelLike = {
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
};

type ModelRegistryLike = {
	find?: (provider: string, id: string) => unknown;
	getAvailable?: () => ModelLike[];
};

type ExecLike = ExtensionAPI["exec"];

const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const LOCAL_MODEL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_DIFF_CHARS = 35_000;

const THE_WATCH_CONFIG_PATH = join(homedir(), ".pi", "agent", "the-watch.json");
const TIMINGS_PATH = join(homedir(), ".pi", "agent", "vette-beta-timings.json");
const TIMINGS_HISTORY_LIMIT = 10;

export type TopicTimingEntry = {
	durationMs: number;
	model: string;
	at: string;
};

export type TopicTimings = Record<string, TopicTimingEntry[]>;

export async function loadTopicTimings(
	path = TIMINGS_PATH,
): Promise<TopicTimings> {
	if (!existsSync(path)) return {};
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {};
		return parsed as TopicTimings;
	} catch {
		return {};
	}
}

export async function saveTopicTimings(
	timings: TopicTimings,
	path = TIMINGS_PATH,
): Promise<void> {
	const dir = path.replace(/\/[^/]+$/, "");
	mkdirSync(dir, { recursive: true });
	await writeFile(path, JSON.stringify(timings, null, 2) + "\n");
}

export function recordTopicTiming(
	timings: TopicTimings,
	topicId: string,
	entry: TopicTimingEntry,
): TopicTimings {
	const existing = timings[topicId] ?? [];
	const updated = [entry, ...existing].slice(0, TIMINGS_HISTORY_LIMIT);
	return { ...timings, [topicId]: updated };
}

export function averageTopicDuration(
	timings: TopicTimings,
	topicId: string,
): number {
	const entries = timings[topicId];
	if (!entries || entries.length === 0) return 0;
	const total = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
	return total / entries.length;
}

export function sortTopicsSlowestFirst(
	topics: VetteBetaTopic[],
	timings: TopicTimings,
): VetteBetaTopic[] {
	return [...topics].sort(
		(a, b) =>
			averageTopicDuration(timings, b.id) - averageTopicDuration(timings, a.id),
	);
}

export const DEFAULT_VETTE_BETA_CONFIG: VetteBetaConfig = {
	modelPools: {
		light: [
			{
				model: "cursor/gemini-3-flash",
				thinking: "off",
				timeoutMs: DEFAULT_TIMEOUT_MS,
			},
			{
				model: "cursor/gpt-5-mini",
				thinking: "off",
				timeoutMs: DEFAULT_TIMEOUT_MS,
			},
			{
				model: "cursor/default",
				thinking: "off",
				timeoutMs: DEFAULT_TIMEOUT_MS,
			},
			{
				model: "ollama/ornith:9b",
				thinking: "off",
				timeoutMs: LOCAL_MODEL_TIMEOUT_MS,
			},
		],
	},
	vetteBeta: {
		modelPool: "light",
		maxParallel: 16,
		tools: ["read", "grep", "find", "ls"],
		topicThinking: {
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
		},
	},
};

export const VETTE_BETA_TOPICS: VetteBetaTopic[] = [
	{
		id: "correctness",
		label: "Correctness",
		prompt:
			"Detect behavior regressions only: changed runtime behavior, missed branches, invalid assumptions, or correctness failures introduced by the diff.",
	},
	{
		id: "tests",
		label: "Tests",
		prompt:
			"Detect missing assertions and false confidence only: gaps where tests would pass while the changed behavior is broken or unprotected.",
	},
	{
		id: "error-handling",
		label: "Error handling",
		prompt:
			"Detect unhandled failure paths only: exceptions, timeouts, retries, cancellation, partial failures, or user-facing error gaps introduced by the diff.",
	},
	{
		id: "security-data",
		label: "Security/data",
		prompt:
			"Detect auth, data, and validation risk only: authorization, privacy, input-validation, injection, or data integrity issues introduced by the diff.",
	},
	{
		id: "contracts",
		label: "Contracts",
		prompt:
			"Detect public compatibility changes only: API, CLI, config, event, schema, payload, status-code, or backwards-compatibility contract breaks.",
	},
	{
		id: "async-state",
		label: "Async/state",
		prompt:
			"Detect race, lifecycle, and stale-state risk only: ordering problems, lifecycle leaks, cache invalidation gaps, or stale state introduced by the diff.",
	},
	{
		id: "naming",
		label: "Naming",
		prompt:
			"Apply deterministic naming lint/rule checks only: misleading identifiers, vague test names, unclear user-facing wording, or names that hide behavior.",
	},
	{
		id: "maintainability",
		label: "Maintainability",
		prompt:
			"Detect review-worthy complexity only: unnecessary complexity, duplicated logic, poor boundaries, or simpler alternatives that materially reduce risk; do not report style-only issues.",
	},
	{
		id: "requirements",
		label: "Requirements/Linear",
		prompt:
			"Detect requirement coverage gaps only: compare the Linear requirements context against the diff and changed-code behavior; report missing acceptance criteria, unclear scope matches, implementation gaps, or requirement ambiguity that needs human review.",
	},
	{
		id: "behavior-specs",
		label: "Feature behavior specs",
		prompt:
			"Detect behavior-spec drift only: compare matching Gherkin/feature-file scenarios against the diff and changed-code behavior; report behavior that violates scenarios, missing scenario coverage for changed behavior, or ambiguous spec matches that need review.",
	},
];

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isModelEntry(value: unknown): value is VetteBetaModelEntry {
	if (!isObject(value)) return false;
	return (
		typeof value.model === "string" &&
		value.model.trim().length > 0 &&
		(value.thinking === undefined || typeof value.thinking === "string") &&
		(value.timeoutMs === undefined || typeof value.timeoutMs === "number")
	);
}

function isLocalModelSelector(selector: string): boolean {
	return /^(ollama|lmstudio|local)\//i.test(selector.trim());
}

function defaultTimeoutForModel(selector: string): number {
	return isLocalModelSelector(selector)
		? LOCAL_MODEL_TIMEOUT_MS
		: DEFAULT_TIMEOUT_MS;
}

function normalizeModelEntry(entry: VetteBetaModelEntry): VetteBetaModelEntry {
	const model = entry.model.trim();
	const defaultTimeoutMs = defaultTimeoutForModel(model);
	return {
		model,
		thinking: entry.thinking?.trim() || "off",
		timeoutMs:
			Number.isFinite(entry.timeoutMs ?? Number.NaN) &&
			(entry.timeoutMs ?? 0) > 0
				? Math.round(entry.timeoutMs ?? defaultTimeoutMs)
				: defaultTimeoutMs,
	};
}

function mergeConfig(partial: PartialVetteBetaConfig): VetteBetaConfig {
	const modelPools: Record<string, VetteBetaModelEntry[]> = {
		...DEFAULT_VETTE_BETA_CONFIG.modelPools,
	};
	if (isObject(partial.modelPools)) {
		for (const [poolName, entries] of Object.entries(partial.modelPools)) {
			if (!Array.isArray(entries)) continue;
			const normalized = entries.flatMap((entry) =>
				isModelEntry(entry) ? [normalizeModelEntry(entry)] : [],
			);
			if (normalized.length > 0) modelPools[poolName] = normalized;
		}
	}

	const vetteBeta = partial.vetteBeta ?? {};
	return {
		modelPools,
		vetteBeta: {
			modelPool:
				typeof vetteBeta.modelPool === "string" && vetteBeta.modelPool.trim()
					? vetteBeta.modelPool.trim()
					: DEFAULT_VETTE_BETA_CONFIG.vetteBeta.modelPool,
			maxParallel:
				typeof vetteBeta.maxParallel === "number" && vetteBeta.maxParallel > 0
					? Math.max(1, Math.round(vetteBeta.maxParallel))
					: DEFAULT_VETTE_BETA_CONFIG.vetteBeta.maxParallel,
			tools:
				Array.isArray(vetteBeta.tools) &&
				vetteBeta.tools.every((tool) => typeof tool === "string") &&
				vetteBeta.tools.length > 0
					? vetteBeta.tools.map((tool) => tool.trim()).filter(Boolean)
					: DEFAULT_VETTE_BETA_CONFIG.vetteBeta.tools,
			topicThinking: {
				...DEFAULT_VETTE_BETA_CONFIG.vetteBeta.topicThinking,
				...(isObject(vetteBeta.topicThinking)
					? Object.fromEntries(
							Object.entries(vetteBeta.topicThinking).filter(
								([, level]) => typeof level === "string" && level.trim(),
							),
						)
					: {}),
			},
		},
	};
}

export function parseVetteBetaConfig(raw: string): VetteBetaConfig {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return mergeConfig(
			isObject(parsed) ? (parsed as PartialVetteBetaConfig) : {},
		);
	} catch {
		return DEFAULT_VETTE_BETA_CONFIG;
	}
}

export async function loadVetteBetaConfig(
	configPath = THE_WATCH_CONFIG_PATH,
): Promise<VetteBetaConfig> {
	if (!existsSync(configPath)) return DEFAULT_VETTE_BETA_CONFIG;
	return parseVetteBetaConfig(await readFile(configPath, "utf8"));
}

function splitModelSelector(
	selector: string,
): { provider: string; id: string } | undefined {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return undefined;
	return { provider: selector.slice(0, slash), id: selector.slice(slash + 1) };
}

function modelProvider(selector: string): string {
	return splitModelSelector(selector)?.provider ?? selector;
}

function modelId(selector: string): string {
	return splitModelSelector(selector)?.id ?? selector;
}

function formatConnectionModel(selector: string): string {
	return `connection=${modelProvider(selector)} model=${modelId(selector)}`;
}

function formatResolvedModelEntry(entry: VetteBetaModelEntry): string {
	return `${formatConnectionModel(entry.model)} selector=${entry.model}`;
}

export function resolveModelPool(input: {
	config: VetteBetaConfig;
	modelRegistry?: ModelRegistryLike;
	poolName?: string;
}): { poolName: string; entries: ResolvedModelEntry[]; error?: string } {
	const poolName = input.poolName ?? input.config.vetteBeta.modelPool;
	const pool = input.config.modelPools[poolName];
	if (!pool || pool.length === 0) {
		return {
			poolName,
			entries: [],
			error: `Model pool '${poolName}' is not defined or empty.`,
		};
	}

	return {
		poolName,
		entries: pool.map((rawEntry, index) => {
			const entry = normalizeModelEntry(rawEntry);
			const split = splitModelSelector(entry.model);
			if (!split || !input.modelRegistry?.find) {
				return { ...entry, index, availability: "unknown" };
			}
			const found = input.modelRegistry.find(split.provider, split.id);
			return found
				? { ...entry, index, availability: "available" }
				: {
						...entry,
						index,
						availability: "missing",
						availabilityReason: "not found in Pi model registry",
					};
		}),
	};
}

export function formatResolvedModelPool(input: {
	config: VetteBetaConfig;
	modelRegistry?: ModelRegistryLike;
	poolName?: string;
}): string {
	const resolved = resolveModelPool(input);
	const lines = [
		`Vette beta model pool: ${resolved.poolName}`,
		`Config path: ${THE_WATCH_CONFIG_PATH}`,
	];
	if (resolved.error) lines.push(`Error: ${resolved.error}`);
	if (resolved.entries.length === 0) return lines.join("\n");
	lines.push("Order:");
	for (const entry of resolved.entries) {
		let status = "unknown";
		if (entry.availability === "available") {
			status = "available";
		} else if (entry.availability === "missing") {
			status = `missing (${entry.availabilityReason ?? "unavailable"})`;
		}
		lines.push(
			`${entry.index + 1}. ${formatResolvedModelEntry(entry)} thinking=${entry.thinking ?? "off"} timeout=${entry.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms — ${status}`,
		);
	}
	return lines.join("\n");
}

export class VetteBetaCooldown {
	private readonly entries = new Map<string, number>();

	constructor(
		private readonly options: {
			now?: () => number;
			cooldownMs?: number;
		} = {},
	) {}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private cooldownMs(): number {
		return this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	isCooling(selector: string): string | undefined {
		const now = this.now();
		for (const key of [
			`model:${selector}`,
			`provider:${modelProvider(selector)}`,
		]) {
			const until = this.entries.get(key);
			if (until && until > now) return key;
			if (until && until <= now) this.entries.delete(key);
		}
		return undefined;
	}

	markFailure(selector: string, message: string): void {
		const until = this.now() + this.cooldownMs();
		this.entries.set(`model:${selector}`, until);
		if (isProviderLevelFailure(message)) {
			this.entries.set(`provider:${modelProvider(selector)}`, until);
		}
	}
}

function isProviderLevelFailure(message: string): boolean {
	return /rate.?limit|overload|timeout|timed out|temporary|unavailable|503|502|504|429|econn|enotfound|socket|network|provider/i.test(
		message,
	);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function textFromMessage(message: LocalMessage): string {
	return message.content
		.map((block: LocalMessage["content"][number]) =>
			block.type === "text" ? block.text : "",
		)
		.join("\n");
}

function parsePiJsonLine(line: string): unknown | undefined {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
}

type TokenUsage = { inputTokens?: number; outputTokens?: number };

function numericField(
	value: Record<string, unknown>,
	keys: string[],
): number | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function extractTokenUsage(value: unknown): TokenUsage | undefined {
	if (!isObject(value)) return undefined;
	const direct = isObject(value.usage) ? value.usage : value;
	const inputTokens = numericField(direct, [
		"input_tokens",
		"inputTokens",
		"prompt_tokens",
		"promptTokens",
	]);
	const outputTokens = numericField(direct, [
		"output_tokens",
		"outputTokens",
		"completion_tokens",
		"completionTokens",
	]);
	if (inputTokens !== undefined || outputTokens !== undefined) {
		return { inputTokens, outputTokens };
	}
	for (const child of Object.values(value)) {
		const nested = extractTokenUsage(child);
		if (nested) return nested;
	}
	return undefined;
}

const spawnPiAgent: PiAgentRunner = (input) =>
	new Promise<PiAgentRunResult>((resolve) => {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			input.model,
			"--thinking",
			input.thinking,
			"--tools",
			input.tools.join(","),
			"--no-extensions",
			"--no-prompt-templates",
			"--no-themes",
			"--no-skills",
			"--no-context-files",
			input.prompt,
		];
		const invocation = getPiInvocation(args);
		const startedAt = Date.now();
		let inputTokens: number | undefined;
		let outputTokens: number | undefined;
		const proc = spawn(invocation.command, invocation.args, {
			cwd: input.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let buffer = "";
		const messages: LocalMessage[] = [];
		let errorMessage: string | undefined;
		let stopReason: string | undefined;
		let finalText = "";

		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5_000).unref?.();
		}, input.timeoutMs);
		timer.unref?.();

		const abort = () => {
			timedOut = true;
			proc.kill("SIGTERM");
		};
		if (input.signal?.aborted) abort();
		else input.signal?.addEventListener("abort", abort, { once: true });

		const processLine = (line: string) => {
			const parsed = parsePiJsonLine(line);
			if (!isObject(parsed)) return;
			const usage = extractTokenUsage(parsed);
			if (usage?.inputTokens !== undefined) inputTokens = usage.inputTokens;
			if (usage?.outputTokens !== undefined) outputTokens = usage.outputTokens;
			if (parsed.type === "message_end" && isObject(parsed.message)) {
				const message = parsed.message as unknown as LocalMessage;
				messages.push(message);
				if (message.role === "assistant") {
					finalText = textFromMessage(message);
					const maybeError = (message as unknown as { errorMessage?: unknown })
						.errorMessage;
					if (typeof maybeError === "string") errorMessage = maybeError;
					const maybeStop = (message as unknown as { stopReason?: unknown })
						.stopReason;
					if (typeof maybeStop === "string") stopReason = maybeStop;
				}
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			const text = data.toString();
			stdout += text;
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", abort);
			if (buffer.trim()) processLine(buffer);
			resolve({
				exitCode: code ?? 0,
				stdout,
				stderr,
				...(timedOut ? { timedOut } : {}),
				messages,
				finalText,
				...(errorMessage ? { errorMessage } : {}),
				...(stopReason ? { stopReason } : {}),
				durationMs: Date.now() - startedAt,
				...(inputTokens !== undefined ? { inputTokens } : {}),
				...(outputTokens !== undefined ? { outputTokens } : {}),
			});
		});
		proc.on("error", (error) => {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", abort);
			resolve({
				exitCode: 1,
				stdout,
				stderr: stderr || error.message,
				messages,
				finalText,
				errorMessage: error.message,
				durationMs: Date.now() - startedAt,
				...(inputTokens !== undefined ? { inputTokens } : {}),
				...(outputTokens !== undefined ? { outputTokens } : {}),
			});
		});
	});

function runFailure(result: PiAgentRunResult): string | undefined {
	if (result.timedOut) return `timed out after provider/model call`;
	if (result.errorMessage) return result.errorMessage;
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		return `agent stopped with ${result.stopReason}`;
	}
	if (result.exitCode !== 0) {
		return result.stderr.trim() || `pi exited with code ${result.exitCode}`;
	}
	return undefined;
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (!match) return undefined;
		try {
			return JSON.parse(match[0]) as unknown;
		} catch {
			return undefined;
		}
	}
}

const SECOND_CLEAN_CHECK_TOPICS = new Set(["security-data", "async-state"]);

function isCleanFindingsResult(parsed: unknown): boolean {
	return (
		isObject(parsed) &&
		Array.isArray(parsed.findings) &&
		parsed.findings.length === 0
	);
}

function countParsedFindings(parsed: unknown): number {
	if (!isObject(parsed) || !Array.isArray(parsed.findings)) return 0;
	return parsed.findings.length;
}

function buildTopicPrompt(input: {
	topic: VetteBetaTopic;
	bundle: string;
}): string {
	return `You are a lightweight single-topic pull request diff reviewer.

Topic: ${input.topic.label}
Scope: ${input.topic.prompt}

Rules:
- Review only this topic. Do not broaden into unrelated review lanes.
- Focus on finding concrete or plausible issues only; do not spend effort proving the diff is clean.
- Use the diff/context bundle first. Use read/grep/find/ls only if needed to verify changed-file context.
- Return JSON only, with this exact shape:
{
  "topicId": "${input.topic.id}",
  "summary": "one sentence",
  "findings": [
    {
      "title": "behavior-first title",
      "severity": "blocker|concern|suggestion",
      "file": "path or empty",
      "line": 0,
      "evidence": "specific evidence from the diff or file context",
      "recommendation": "smallest safe next check or fix"
    }
  ]
}
- If no finding is worth parent validation, return an empty findings array.

Diff/context bundle:
${input.bundle}`;
}

function discoverFallbackModels(
	modelRegistry: ModelRegistryLike | undefined,
	pool: ResolvedModelEntry[],
): ResolvedModelEntry[] {
	if (!modelRegistry?.getAvailable) return [];
	const available = modelRegistry.getAvailable();
	if (!available || available.length === 0) return [];

	const poolSelectors = new Set(pool.map((entry) => entry.model));
	const candidates = available.filter(
		(model) => !poolSelectors.has(`${model.provider}/${model.id}`),
	);

	candidates.sort(
		(left, right) =>
			(left.contextWindow ?? 200_000) - (right.contextWindow ?? 200_000),
	);

	return candidates.map((model, index) => ({
		model: `${model.provider}/${model.id}`,
		thinking: "off",
		timeoutMs: DEFAULT_TIMEOUT_MS,
		index: pool.length + index,
		availability: "available" as const,
	}));
}

export async function runTopicWithFallback(input: {
	topic: VetteBetaTopic;
	bundle: string;
	cwd: string;
	tools: string[];
	pool: ResolvedModelEntry[];
	cooldown: VetteBetaCooldown;
	runner: PiAgentRunner;
	signal?: AbortSignal;
	topicThinking?: Record<string, string>;
	modelRegistry?: ModelRegistryLike;
}): Promise<VetteBetaTopicResult> {
	const attempts: VetteBetaAttempt[] = [];
	const prompt = buildTopicPrompt({ topic: input.topic, bundle: input.bundle });
	const effectiveThinking =
		input.topicThinking?.[input.topic.id] ?? input.pool[0]?.thinking ?? "off";
	let lastError = "No model was attempted.";
	let cleanCandidate:
		| { model: string; output: string; parsed: unknown | undefined }
		| undefined;
	let cleanSuccesses = 0;

	for (const entry of input.pool) {
		if (entry.availability === "missing") {
			attempts.push({
				model: entry.model,
				thinking: effectiveThinking,
				timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				status: "skipped",
				skippedReason: entry.availabilityReason ?? "missing model",
			});
			continue;
		}
		const cooling = input.cooldown.isCooling(entry.model);
		if (cooling) {
			attempts.push({
				model: entry.model,
				thinking: effectiveThinking,
				timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				status: "skipped",
				skippedReason: `cooldown ${cooling}`,
			});
			continue;
		}

		const result = await input.runner({
			cwd: input.cwd,
			prompt,
			model: entry.model,
			thinking: effectiveThinking,
			tools: input.tools,
			timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			...(input.signal ? { signal: input.signal } : {}),
		});
		const failure = runFailure(result);
		if (!failure) {
			const output = result.finalText || result.stdout;
			const parsed = tryParseJsonOutput(output);
			attempts.push({
				model: entry.model,
				thinking: effectiveThinking,
				timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				status: "success",
				exitCode: result.exitCode,
				...(result.durationMs !== undefined
					? { durationMs: result.durationMs }
					: {}),
				...(result.inputTokens !== undefined
					? { inputTokens: result.inputTokens }
					: {}),
				...(result.outputTokens !== undefined
					? { outputTokens: result.outputTokens }
					: {}),
			});
			if (
				SECOND_CLEAN_CHECK_TOPICS.has(input.topic.id) &&
				isCleanFindingsResult(parsed)
			) {
				cleanCandidate ??= { model: entry.model, output, parsed };
				cleanSuccesses += 1;
				if (cleanSuccesses < 2) continue;
			}
			return {
				topic: input.topic,
				attempts,
				finalModel: entry.model,
				ok: true,
				output,
				parsed,
			};
		}

		lastError = failure;
		attempts.push({
			model: entry.model,
			thinking: effectiveThinking,
			timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			status: "failed",
			exitCode: result.exitCode,
			...(result.timedOut ? { timedOut: true } : {}),
			errorMessage: failure,
			...(result.durationMs !== undefined
				? { durationMs: result.durationMs }
				: {}),
			...(result.inputTokens !== undefined
				? { inputTokens: result.inputTokens }
				: {}),
			...(result.outputTokens !== undefined
				? { outputTokens: result.outputTokens }
				: {}),
		});
		input.cooldown.markFailure(entry.model, failure);
	}

	const fallbackModels = discoverFallbackModels(
		input.modelRegistry,
		input.pool,
	);
	for (const entry of fallbackModels) {
		const cooling = input.cooldown.isCooling(entry.model);
		if (cooling) {
			attempts.push({
				model: entry.model,
				thinking: "off",
				timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				status: "skipped",
				skippedReason: `cooldown ${cooling}`,
			});
			continue;
		}

		const result = await input.runner({
			cwd: input.cwd,
			prompt,
			model: entry.model,
			thinking: "off",
			tools: input.tools,
			timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			...(input.signal ? { signal: input.signal } : {}),
		});
		const failure = runFailure(result);
		if (!failure) {
			const output = result.finalText || result.stdout;
			const parsed = tryParseJsonOutput(output);
			attempts.push({
				model: entry.model,
				thinking: "off",
				timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				status: "success",
				exitCode: result.exitCode,
				...(result.durationMs !== undefined
					? { durationMs: result.durationMs }
					: {}),
				...(result.inputTokens !== undefined
					? { inputTokens: result.inputTokens }
					: {}),
				...(result.outputTokens !== undefined
					? { outputTokens: result.outputTokens }
					: {}),
			});
			return {
				topic: input.topic,
				attempts,
				finalModel: entry.model,
				ok: true,
				output,
				parsed,
			};
		}

		lastError = failure;
		attempts.push({
			model: entry.model,
			thinking: "off",
			timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			status: "failed",
			exitCode: result.exitCode,
			...(result.timedOut ? { timedOut: true } : {}),
			errorMessage: failure,
			...(result.durationMs !== undefined
				? { durationMs: result.durationMs }
				: {}),
			...(result.inputTokens !== undefined
				? { inputTokens: result.inputTokens }
				: {}),
			...(result.outputTokens !== undefined
				? { outputTokens: result.outputTokens }
				: {}),
		});
		input.cooldown.markFailure(entry.model, failure);
	}

	if (cleanCandidate) {
		return {
			topic: input.topic,
			attempts,
			finalModel: cleanCandidate.model,
			ok: true,
			output: cleanCandidate.output,
			parsed: cleanCandidate.parsed,
		};
	}

	return {
		topic: input.topic,
		attempts,
		ok: false,
		output: "",
		errorMessage: lastError,
	};
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: readonly TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results: TOut[] = [];
	results.length = items.length;
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(concurrency, items.length)) },
		async () => {
			while (true) {
				const index = next;
				next += 1;
				if (index >= items.length) return undefined;
				results[index] = await fn(items[index], index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

async function execText(
	exec: ExecLike,
	cwd: string,
	command: string,
	args: string[],
): Promise<string> {
	const result = await exec(command, args, { cwd, timeout: 20_000 });
	if (result.code !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

async function firstSuccessful(
	callbacks: Array<() => Promise<string>>,
): Promise<string> {
	for (const callback of callbacks) {
		try {
			const result = await callback();
			if (result.trim()) return result.trim();
		} catch {
			// Try next fallback.
		}
	}
	return "";
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function extractLinearIssueIds(...values: Array<string | undefined>): string[] {
	const ids = new Set<string>();
	for (const value of values) {
		for (const match of value?.matchAll(/\b[A-Z][A-Z0-9]{1,10}-\d+\b/g) ?? []) {
			ids.add(match[0]);
		}
	}
	return [...ids];
}

function tokensFrom(text: string): string[] {
	const stopWords = new Set([
		"from",
		"this",
		"that",
		"with",
		"when",
		"then",
		"given",
		"and",
		"the",
		"for",
		"diff",
	]);
	return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])]
		.filter((token) => !stopWords.has(token))
		.slice(0, 80);
}

async function buildLinearRequirementsContext(input: {
	exec: ExecLike;
	cwd: string;
	target?: VetteBetaReviewTarget;
	pr?: GhSnapshot["pr"];
}): Promise<string> {
	const inferredIssueId = await firstSuccessful([
		() => execText(input.exec, input.cwd, "linear", ["issue", "id"]),
	]);
	const issueIds = extractLinearIssueIds(
		input.target?.label,
		input.target?.headRef,
		input.target?.title,
		input.target?.body,
		input.pr?.kind === "pr" ? input.pr.branch : undefined,
		inferredIssueId,
	);

	const issueViews = await Promise.all(
		issueIds.slice(0, 5).map(async (issueId) => {
			const body = await firstSuccessful([
				() =>
					execText(input.exec, input.cwd, "linear", ["issue", "view", issueId]),
			]);
			return body
				? `## ${issueId}\n${body}`
				: `## ${issueId}\n<not available from linear issue view>`;
		}),
	);
	if (issueViews.length > 0) {
		return [
			"Linear requirements:",
			`Issue IDs: ${issueIds.join(", ")}`,
			"",
			truncateText(issueViews.join("\n\n"), 12_000),
		].join("\n");
	}

	const inferredView = await firstSuccessful([
		() => execText(input.exec, input.cwd, "linear", ["issue", "view"]),
	]);
	if (inferredView) {
		return ["Linear requirements:", truncateText(inferredView, 12_000)].join(
			"\n",
		);
	}

	return [
		"Linear requirements:",
		"<none found>",
		"No Linear issue ID was found in the branch, PR metadata, or `linear issue id`, or the Linear CLI was unavailable. The requirements lane should report uncertainty rather than invent requirements.",
	].join("\n");
}

async function buildBehaviorSpecsContext(input: {
	exec: ExecLike;
	cwd: string;
	status: string;
	diff: string;
}): Promise<string> {
	const listed = await firstSuccessful([
		() =>
			execText(input.exec, input.cwd, "git", [
				"ls-files",
				"--",
				"*.feature",
				":(glob)**/*.feature",
				"*.feature.md",
				":(glob)**/*.feature.md",
			]),
	]);
	const paths = [
		...new Set(
			listed
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
	if (paths.length === 0) {
		return [
			"Behavior specs:",
			"<none found>",
			"No .feature or .feature.md files were found, so the behavior-specs lane should not invent scenario expectations.",
		].join("\n");
	}

	const signalTokens = tokensFrom(`${input.status}\n${input.diff}`);
	const specs = await Promise.all(
		paths.slice(0, 50).map(async (path) => {
			const body = await firstSuccessful([
				() => execText(input.exec, input.cwd, "git", ["show", `HEAD:${path}`]),
				() => execText(input.exec, input.cwd, "cat", [path]),
			]);
			const haystack = `${path}\n${body}`.toLowerCase();
			const score = signalTokens.reduce(
				(total, token) => total + (haystack.includes(token) ? 1 : 0),
				0,
			);
			return { path, body, score };
		}),
	);
	const matched = specs
		.filter((spec) => spec.score > 0 && spec.body.trim())
		.sort((left, right) => right.score - left.score)
		.slice(0, 5);
	if (matched.length === 0) {
		return [
			"Behavior specs:",
			`Feature files found: ${paths.slice(0, 20).join(", ")}`,
			"No obvious lexical match was found against the changed files or diff. The behavior-specs lane should report uncertainty unless it can justify a relevant scenario match.",
		].join("\n");
	}

	return [
		"Behavior specs:",
		`Matched feature files: ${matched.map((spec) => `${spec.path} (score ${spec.score})`).join(", ")}`,
		"",
		truncateText(
			matched.map((spec) => `## ${spec.path}\n${spec.body}`).join("\n\n"),
			12_000,
		),
	].join("\n");
}

type DiffParts = {
	status: string;
	stat: string;
	diff: string;
	rangeLabel: string;
};

async function buildPrDiffParts(input: {
	exec: ExecLike;
	cwd: string;
	prNumber?: number;
}): Promise<DiffParts | undefined> {
	if (!input.prNumber) return undefined;
	const selector = String(input.prNumber);
	const [status, diff] = await Promise.all([
		firstSuccessful([
			() =>
				execText(input.exec, input.cwd, "gh", [
					"pr",
					"diff",
					selector,
					"--name-only",
				]),
		]),
		firstSuccessful([
			() =>
				execText(input.exec, input.cwd, "gh", [
					"pr",
					"diff",
					selector,
					"--patch",
				]),
			() => execText(input.exec, input.cwd, "gh", ["pr", "diff", selector]),
		]),
	]);
	if (!diff.trim()) return undefined;
	return {
		status,
		stat: status
			? `${status.split("\n").filter(Boolean).length} file(s) from gh pr diff`
			: "<not available from gh pr diff>",
		diff,
		rangeLabel: `gh pr diff ${selector}`,
	};
}

export async function buildVetteBetaDiffBundle(input: {
	exec: ExecLike;
	cwd: string;
	snapshot?: GhSnapshot;
	target?: VetteBetaReviewTarget;
}): Promise<string> {
	const pr = input.snapshot?.pr.kind === "pr" ? input.snapshot.pr : undefined;
	const requestedHeadRef = input.target?.headRef ?? "HEAD";
	const baseRef =
		input.target?.baseRef ??
		(pr?.baseRefName ? `origin/${pr.baseRefName}` : "origin/main");
	const headRef = input.target
		? (await firstSuccessful([
				() =>
					execText(input.exec, input.cwd, "git", [
						"rev-parse",
						"--verify",
						`${requestedHeadRef}^{commit}`,
					]),
				() =>
					execText(input.exec, input.cwd, "git", [
						"rev-parse",
						"--verify",
						`origin/${requestedHeadRef}^{commit}`,
					]),
			])) || requestedHeadRef
		: requestedHeadRef;
	const prDiffParts = await buildPrDiffParts({
		exec: input.exec,
		cwd: input.cwd,
		prNumber: input.target?.prNumber,
	});
	const mergeBase = prDiffParts
		? ""
		: await firstSuccessful([
				() =>
					execText(input.exec, input.cwd, "git", [
						"merge-base",
						baseRef,
						headRef,
					]),
				() =>
					execText(input.exec, input.cwd, "git", [
						"merge-base",
						"main",
						headRef,
					]),
				() =>
					execText(input.exec, input.cwd, "git", ["rev-parse", `${headRef}~1`]),
			]);
	const rangeArgs = mergeBase
		? [mergeBase, headRef]
		: [`${headRef}~1`, headRef];
	const gitDiffParts = prDiffParts
		? undefined
		: await Promise.all([
				firstSuccessful([
					() =>
						execText(input.exec, input.cwd, "git", [
							"diff",
							"--name-status",
							...rangeArgs,
						]),
				]),
				firstSuccessful([
					() =>
						execText(input.exec, input.cwd, "git", [
							"diff",
							"--stat",
							...rangeArgs,
						]),
				]),
				firstSuccessful([
					() =>
						execText(input.exec, input.cwd, "git", [
							"diff",
							"--unified=80",
							...rangeArgs,
						]),
				]),
			]);
	const baseParts = gitDiffParts ?? [
		prDiffParts?.status ?? "",
		prDiffParts?.stat ?? "",
		prDiffParts?.diff ?? "",
	];
	const worktreeParts = input.target
		? undefined
		: await Promise.all([
				firstSuccessful([
					() => execText(input.exec, input.cwd, "git", ["status", "--short"]),
				]),
				firstSuccessful([
					() =>
						execText(input.exec, input.cwd, "git", ["diff", "--stat", "HEAD"]),
				]),
				firstSuccessful([
					() =>
						execText(input.exec, input.cwd, "git", [
							"diff",
							"--unified=80",
							"HEAD",
						]),
				]),
			]);
	const [status, stat, diff] = worktreeParts?.[2]?.trim()
		? [
				[baseParts[0], worktreeParts[0]].filter(Boolean).join("\n"),
				[baseParts[1], worktreeParts[1]].filter(Boolean).join("\n"),
				[baseParts[2], worktreeParts[2]].filter(Boolean).join("\n\n"),
			]
		: baseParts;
	const rangeLabel = prDiffParts?.rangeLabel ?? rangeArgs.join("..");
	const [requirementsContext, behaviorSpecsContext] = await Promise.all([
		buildLinearRequirementsContext({
			exec: input.exec,
			cwd: input.cwd,
			...(input.target ? { target: input.target } : {}),
			...(input.snapshot ? { pr: input.snapshot.pr } : {}),
		}),
		buildBehaviorSpecsContext({
			exec: input.exec,
			cwd: input.cwd,
			status,
			diff,
		}),
	]);
	return [
		`Repository: ${input.snapshot?.repo.kind === "repo" ? input.snapshot.repo.repo.fullName : "<unknown>"}`,
		`Target: ${input.target?.label ?? (requestedHeadRef === "HEAD" ? "current worktree" : requestedHeadRef)}`,
		`Branch: ${input.target?.headRef ?? (input.snapshot?.repo.kind === "repo" ? input.snapshot.repo.branch : "<unknown>")}`,
		input.target?.prNumber && input.target.prUrl
			? `PR: #${input.target.prNumber} ${input.target.prUrl}`
			: pr
				? `PR: #${pr.number} ${pr.url}`
				: "PR: <none>",
		`Base: ${baseRef}`,
		`Range: ${rangeLabel}`,
		"",
		"Changed files:",
		status || "<none>",
		"",
		"Diff stat:",
		stat || "<none>",
		"",
		requirementsContext,
		"",
		behaviorSpecsContext,
		"",
		"Diff:",
		truncateText(diff || "<empty diff>", MAX_DIFF_CHARS),
	].join("\n");
}

export async function runVetteBetaReview(input: {
	ctx: ExtensionCommandContext;
	pi: Pick<ExtensionAPI, "exec">;
	config: VetteBetaConfig;
	cooldown: VetteBetaCooldown;
	runner?: PiAgentRunner;
	snapshot?: GhSnapshot;
	target?: VetteBetaReviewTarget;
	reviewMode?: VetteBetaReviewMode;
	topics?: VetteBetaTopic[];
	onBundleReady?: (info: { bundleDurationMs: number }) => void;
	onTopicStart?: (info: {
		topic: VetteBetaTopic;
		index: number;
		total: number;
	}) => void;
	onTopicComplete?: (info: {
		completed: number;
		total: number;
		topic: VetteBetaTopic;
		ok: boolean;
		findingsCount: number;
		durationMs: number;
		inputTokens?: number;
		outputTokens?: number;
		model?: string;
	}) => void;
}): Promise<VetteBetaRunResult> {
	const startedMs = Date.now();
	const startedAt = new Date(startedMs).toISOString();
	const cwd = input.ctx.cwd;
	const signal = input.ctx.signal;
	const modelRegistry = (
		input.ctx as unknown as { modelRegistry?: ModelRegistryLike }
	).modelRegistry;
	const pool = resolveModelPool({
		config: input.config,
		modelRegistry,
	}).entries;
	const bundleStart = Date.now();
	const bundle = await buildVetteBetaDiffBundle({
		exec: input.pi.exec,
		cwd,
		...(input.snapshot ? { snapshot: input.snapshot } : {}),
		...(input.target ? { target: input.target } : {}),
	});
	input.onBundleReady?.({ bundleDurationMs: Date.now() - bundleStart });
	const topics = input.topics ?? VETTE_BETA_TOPICS;
	const timings = await loadTopicTimings();
	const sortedTopics = sortTopicsSlowestFirst(topics, timings);
	let completedCount = 0;
	let updatedTimings = timings;
	const results = await mapWithConcurrencyLimit(
		sortedTopics,
		input.config.vetteBeta.maxParallel,
		async (topic, index) => {
			input.onTopicStart?.({ topic, index, total: sortedTopics.length });
			const topicStart = Date.now();
			const result = await runTopicWithFallback({
				topic,
				bundle,
				cwd,
				tools: input.config.vetteBeta.tools,
				pool,
				cooldown: input.cooldown,
				runner: input.runner ?? spawnPiAgent,
				...(signal ? { signal } : {}),
				topicThinking: input.config.vetteBeta.topicThinking,
				modelRegistry,
			});
			completedCount += 1;
			const topicDurationMs = Date.now() - topicStart;
			const findingsCount = countParsedFindings(result.parsed);
			const successAttempt = result.attempts.find(
				(a) => a.status === "success",
			);
			if (result.ok && result.finalModel) {
				updatedTimings = recordTopicTiming(updatedTimings, topic.id, {
					durationMs: topicDurationMs,
					model: result.finalModel,
					at: new Date().toISOString(),
				});
			}
			input.onTopicComplete?.({
				completed: completedCount,
				total: sortedTopics.length,
				topic,
				ok: result.ok,
				findingsCount,
				durationMs: topicDurationMs,
				inputTokens: successAttempt?.inputTokens,
				outputTokens: successAttempt?.outputTokens,
				model: result.finalModel,
			});
			return result;
		},
	);
	await saveTopicTimings(updatedTimings).catch(() => {});
	const finishedMs = Date.now();
	return {
		poolName: input.config.vetteBeta.modelPool,
		resolvedPool: pool,
		bundle,
		results,
		startedAt,
		finishedAt: new Date(finishedMs).toISOString(),
		durationMs: finishedMs - startedMs,
		reviewMode: input.reviewMode ?? input.target?.reviewMode ?? "comment",
		...(input.target ? { target: input.target } : {}),
	};
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "duration=unknown";
	if (ms < 1000) return `duration=${ms}ms`;
	return `duration=${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(
	inputTokens: number | undefined,
	outputTokens: number | undefined,
): string {
	return `tokens in=${inputTokens?.toLocaleString() ?? "?"} out=${outputTokens?.toLocaleString() ?? "?"}`;
}

function sumAttempts(
	results: VetteBetaTopicResult[],
	field: "inputTokens" | "outputTokens",
): number | undefined {
	let total = 0;
	let seen = false;
	for (const result of results) {
		for (const attempt of result.attempts) {
			const value = attempt[field];
			if (value === undefined) continue;
			total += value;
			seen = true;
		}
	}
	return seen ? total : undefined;
}

function formatAttempt(attempt: VetteBetaAttempt): string {
	const model = formatConnectionModel(attempt.model);
	const metrics = `${formatTokens(attempt.inputTokens, attempt.outputTokens)} ${formatDuration(attempt.durationMs)}`;
	if (attempt.status === "success") return `${model} ✓ (${metrics})`;
	if (attempt.status === "skipped") {
		return `${model} skipped (${attempt.skippedReason ?? "unknown"})`;
	}
	return `${model} failed (${attempt.errorMessage ?? attempt.exitCode ?? "unknown"}; ${metrics})`;
}

export function formatVetteBetaSynthesisPrompt(
	run: VetteBetaRunResult,
): string {
	const ok = run.results.filter((result) => result.ok).length;
	const failed = run.results.length - ok;
	const totalInputTokens = sumAttempts(run.results, "inputTokens");
	const totalOutputTokens = sumAttempts(run.results, "outputTokens");
	const hasPrTarget = Boolean(run.target?.prNumber && run.target.prUrl);
	const isRepairMode = run.reviewMode === "repair";
	const actionInstruction = isRepairMode
		? "This is an owned/self review. Do not post or draft PR review comments as the primary output. Verify candidates, fix confirmed issues directly in the working tree with focused changes, add or update focused tests where practical, and report fixed items plus any unresolved blockers. Do not commit."
		: hasPrTarget
			? `After verification is complete, post verified findings to ${run.target?.prUrl} in one final comment pass. Use the gh CLI via your shell/bash tool to post comments. Prefer exact file/line review comments when possible; fall back to one grouped PR comment for verified findings without reliable line placement.`
			: "No PR target was resolved, so do not post comments. Instead prepare comment-ready markdown with best file/line context and explain that posting requires /vette <pr>.";
	const lines = [
		`Vette beta completed ${run.results.length} lightweight topic agents using model pool '${run.poolName}'.`,
		run.target
			? `Review target: ${run.target.label}`
			: "Review target: current worktree",
		`Timing: started ${run.startedAt}; finished ${run.finishedAt}; ${formatDuration(run.durationMs)}.`,
		`Usage: ${formatTokens(totalInputTokens, totalOutputTokens)} across all topic-agent attempts.`,
		`Succeeded: ${ok}; failed: ${failed}.`,
		`Mode: ${isRepairMode ? "owned/self repair" : "external/comment review"}.`,
		"",
		"Continue the full vette workflow from these topic-agent results; do not stop at a summary.",
		"",
		"Available tools for verification and posting:",
		"- Use your shell/bash tool to run commands: read files, run tests, and execute gh CLI commands.",
		"- Use read/grep/find/ls tools to inspect source files and verify findings against actual code.",
		isRepairMode
			? "- Use your shell/bash tool to run focused test commands and apply fixes."
			: hasPrTarget
				? `- Use \`gh pr comment ${run.target?.prNumber} --body <body>\` to post a general PR comment.`
				: "- No PR target; prepare comment-ready markdown only.",
		hasPrTarget && !isRepairMode
			? `- Use \`gh api repos/{owner}/{repo}/pulls/${run.target?.prNumber}/comments --method POST -f body=<body> -f commit_id=<sha> -f path=<file> -F position:=<line>\` for inline file/line comments, or fall back to \`gh pr comment\` for general comments.`
			: "",
		"- If a tool is unavailable or a command fails, report the specific error rather than declaring the phase blocked.",
		"",
		"Required next phases:",
		"1. Parse and deduplicate all topic findings into stable finding IDs, preserving topic/model provenance.",
		"2. Reject duplicate, low-confidence, and out-of-scope items with short reasons.",
		"3. Verify each remaining actionable finding against actual source files using read/grep tools and focused shell commands. Do not skip verification by claiming tools are unavailable.",
		"4. For reproducible issues, include the exact failing test code and command output in the evidence, then clean up temporary test files unless asked otherwise.",
		`5. ${actionInstruction}`,
		isRepairMode
			? "6. Finish with counts for candidates, duplicates, rejected, verified, fixed, still failing, and blocked items."
			: "6. Finish with counts for candidates, duplicates, rejected, verified, posted/comment-ready, and blocked items.",
		"",
		isRepairMode
			? "Use this repair evidence template for verified findings you fix or leave unresolved:"
			: "Use this comment template for verified findings:",
		"### Verified issue: <short behavior-first title>",
		"**Location:** <path:line or path>",
		"**Source topics:** <topic ids/models>",
		"**Impact:** <what behavior breaks and who is affected>",
		"**Evidence:** <static proof, command result, or failing repro test>",
		"**Fix boundary:** <smallest safe change expected>",
		"",
		"Model pool order:",
		...run.resolvedPool.map(
			(entry) =>
				`${entry.index + 1}. ${formatResolvedModelEntry(entry)} (${entry.availability})`,
		),
		"",
		"Topic results:",
	];
	for (const result of run.results) {
		lines.push(
			`\n## ${result.topic.label} (${result.ok ? "ok" : "failed"})`,
			`Attempts: ${result.attempts.map(formatAttempt).join("; ") || "none"}`,
			result.ok
				? result.output || JSON.stringify(result.parsed ?? {}, null, 2)
				: `Error: ${result.errorMessage ?? "unknown"}`,
		);
	}
	return lines.join("\n");
}
