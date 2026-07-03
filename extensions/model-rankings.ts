import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RANKINGS_DIR = join(homedir(), ".pi", "agent");
const RANKINGS_PATH = join(RANKINGS_DIR, "model-rankings.json");
const LOCK_PATH = join(RANKINGS_DIR, "model-rankings.lock");
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
const LOCK_STALE_MS = 5 * 60_000; // lock expires after 5 min (crashed process)
const FETCH_TIMEOUT_MS = 15_000;

const SCORES_URL = "https://aistupidlevel.info/dashboard/scores";
const MODELS_URL = "https://aistupidlevel.info/api/models";

// ── Types ──

export type ModelRanking = {
	id: string;
	name: string;
	vendor: string;
	score: number;
	confidenceLower: number;
	confidenceUpper: number;
	trend: string;
	costInput: number | null; // $ per 1M input tokens
	costOutput: number | null; // $ per 1M output tokens
	costNote: string;
	usesReasoningEffort: boolean;
};

export type RankingsTable = {
	fetchedAt: string;
	models: ModelRanking[];
};

// ── Cost parsing ──

const COST_PATTERN =
	/\$([0-9.]+)\s*\/\s*\$([0-9.]+)\s*(?:per\s+)?(?:M\s*Tok|MTok)/i;

function parseCosts(notes: string): {
	input: number | null;
	output: number | null;
	raw: string;
} {
	const match = notes.match(COST_PATTERN);
	if (!match) return { input: null, output: null, raw: notes };
	return {
		input: Number.parseFloat(match[1]),
		output: Number.parseFloat(match[2]),
		raw: match[0],
	};
}

// ── Lockfile (cross-instance debounce) ──

function acquireLock(): boolean {
	mkdirSync(RANKINGS_DIR, { recursive: true });
	if (existsSync(LOCK_PATH)) {
		try {
			const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
			if (age < LOCK_STALE_MS) return false; // another instance is updating
			unlinkSync(LOCK_PATH); // stale lock from a crashed process
		} catch {
			return false;
		}
	}
	try {
		const fd = openSync(LOCK_PATH, "wx");
		writeSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function releaseLock(): void {
	try {
		unlinkSync(LOCK_PATH);
	} catch {}
}

// ── Fetch helpers ──

type ScoresResponse = {
	success: boolean;
	data: Array<{
		id: string;
		name: string;
		provider: string;
		currentScore: number;
		score: number;
		trend: string;
		confidenceLower: number;
		confidenceUpper: number;
		usesReasoningEffort: boolean;
	}>;
};

type ModelDetail = {
	id: number;
	name: string;
	vendor: string;
	notes: string;
	usesReasoningEffort: boolean;
};

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { Accept: "application/json" },
	});
	if (!res.ok) throw new Error(`${url} returned ${res.status}`);
	return (await res.json()) as T;
}

// ── Core: fetch, merge, rank ──

async function fetchRankings(): Promise<RankingsTable> {
	const [scoresRes, modelsRes] = await Promise.all([
		fetchJson<ScoresResponse>(SCORES_URL),
		fetchJson<ModelDetail[]>(MODELS_URL),
	]);

	const modelMap = new Map(modelsRes.map((m) => [String(m.id), m]));
	const scores = scoresRes.data ?? scoresRes;

	const models: ModelRanking[] = (scores as ScoresResponse["data"]).map((s) => {
		const detail = modelMap.get(s.id);
		const costs = parseCosts(detail?.notes ?? "");
		return {
			id: s.id,
			name: s.name,
			vendor: s.provider ?? detail?.vendor ?? "unknown",
			score: s.currentScore,
			confidenceLower: s.confidenceLower ?? 0,
			confidenceUpper: s.confidenceUpper ?? 100,
			trend: s.trend ?? "stable",
			costInput: costs.input,
			costOutput: costs.output,
			costNote: costs.raw,
			usesReasoningEffort: s.usesReasoningEffort ?? false,
		};
	});

	// Sort: accuracy first (descending), then cheapest output cost
	models.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const aCost = a.costOutput ?? Number.MAX_SAFE_INTEGER;
		const bCost = b.costOutput ?? Number.MAX_SAFE_INTEGER;
		return aCost - bCost;
	});

	return { fetchedAt: new Date().toISOString(), models };
}

// ── Persistence ──

export async function loadRankings(): Promise<RankingsTable | null> {
	if (!existsSync(RANKINGS_PATH)) return null;
	try {
		return JSON.parse(await readFile(RANKINGS_PATH, "utf8")) as RankingsTable;
	} catch {
		return null;
	}
}

async function saveRankings(table: RankingsTable): Promise<void> {
	mkdirSync(RANKINGS_DIR, { recursive: true });
	await writeFile(RANKINGS_PATH, JSON.stringify(table, null, 2) + "\n");
}

function isStale(table: RankingsTable | null): boolean {
	if (!table) return true;
	const age = Date.now() - new Date(table.fetchedAt).getTime();
	return age >= REFRESH_INTERVAL_MS;
}

// ── Public API ──

/**
 * Returns the current rankings table, refreshing from aistupidlevel.info
 * if stale (>6h). Only one Pi instance refreshes at a time (lockfile).
 * Never throws — returns cached data on fetch failure, null if nothing cached.
 */
export async function getRankings(): Promise<RankingsTable | null> {
	const cached = await loadRankings();
	if (!isStale(cached)) return cached;

	if (!acquireLock()) return cached; // another instance is refreshing
	try {
		const fresh = await fetchRankings();
		await saveRankings(fresh);
		return fresh;
	} catch {
		return cached; // network failure — serve stale
	} finally {
		releaseLock();
	}
}

/**
 * Force a refresh regardless of staleness (still respects the lock).
 */
export async function forceRefreshRankings(): Promise<RankingsTable | null> {
	if (!acquireLock()) return loadRankings();
	try {
		const fresh = await fetchRankings();
		await saveRankings(fresh);
		return fresh;
	} catch {
		return loadRankings();
	} finally {
		releaseLock();
	}
}

/**
 * Format the rankings table as a concise summary for display.
 */
export function formatRankings(table: RankingsTable): string {
	const age = Date.now() - new Date(table.fetchedAt).getTime();
	const ageH = (age / 3_600_000).toFixed(1);
	const lines: string[] = [
		`Model rankings (fetched ${ageH}h ago from aistupidlevel.info)`,
		`Sorted by: accuracy (score) ↓, then cost ↑`,
		"",
		"  #  Score  Cost (in/out MTok)  Trend   Model",
		" ──  ─────  ──────────────────  ──────  ─────",
	];
	for (let i = 0; i < table.models.length; i++) {
		const m = table.models[i];
		const rank = String(i + 1).padStart(3);
		const score = String(m.score).padStart(5);
		const cost =
			m.costInput != null && m.costOutput != null
				? `$${m.costInput}/$${m.costOutput}`
				: "n/a";
		const trend = m.trend.padEnd(6);
		lines.push(`${rank}  ${score}  ${cost.padEnd(18)}  ${trend}  ${m.name}`);
	}
	return lines.join("\n");
}
