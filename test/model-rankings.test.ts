import { describe, expect, it } from "vitest";

// Re-export the private parseCosts via a test-only import trick:
// we test the public formatRankings + the sort order instead.
import {
	formatRankings,
	type ModelRanking,
	type RankingsTable,
} from "../extensions/model-rankings.ts";

function makeModel(overrides: Partial<ModelRanking>): ModelRanking {
	return {
		id: "1",
		name: "test-model",
		vendor: "test",
		score: 50,
		confidenceLower: 40,
		confidenceUpper: 60,
		trend: "stable",
		costInput: 1,
		costOutput: 5,
		costNote: "$1/$5 per MTok",
		usesReasoningEffort: false,
		...overrides,
	};
}

describe("formatRankings", () => {
	it("renders a table sorted by score descending", () => {
		const table: RankingsTable = {
			fetchedAt: new Date().toISOString(),
			models: [
				makeModel({ name: "best", score: 90, costOutput: 25 }),
				makeModel({ name: "mid", score: 70, costOutput: 5 }),
				makeModel({ name: "cheap", score: 50, costOutput: 1 }),
			],
		};
		const output = formatRankings(table);
		expect(output).toContain("best");
		expect(output).toContain("mid");
		expect(output).toContain("cheap");

		const bestIdx = output.indexOf("best");
		const midIdx = output.indexOf("mid");
		const cheapIdx = output.indexOf("cheap");
		expect(bestIdx).toBeLessThan(midIdx);
		expect(midIdx).toBeLessThan(cheapIdx);
	});

	it("shows n/a for models without pricing", () => {
		const table: RankingsTable = {
			fetchedAt: new Date().toISOString(),
			models: [makeModel({ costInput: null, costOutput: null })],
		};
		expect(formatRankings(table)).toContain("n/a");
	});
});
