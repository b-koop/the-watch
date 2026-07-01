import { describe, expect, it } from "vitest";
import {
	classifyBotActivity,
	extractCursorBugBotSignal,
} from "../extensions/gh-status/bugbot.ts";

function cursorLink(payload: unknown): string {
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
		"base64url",
	);
	return `https://cursor.com/agents?link=${encoded}`;
}

describe("extractCursorBugBotSignal", () => {
	it("decodes Cursor BUGBOT_FIX_IN_WEB links without exposing opaque keys", () => {
		const signal = extractCursorBugBotSignal(
			cursorLink({
				version: 1,
				type: "BUGBOT_FIX_IN_WEB",
				data: {
					repoOwner: "g2i-ai",
					repoName: "gheeggle",
					prNumber: 11951,
					branch: "feature/x",
					commitSha: "abc123",
					redisKey: "secret",
					encryptionKey: "secret",
				},
			}),
		);

		expect(signal).toEqual({
			type: "BUGBOT_FIX_IN_WEB",
			repoOwner: "g2i-ai",
			repoName: "gheeggle",
			prNumber: 11951,
			branch: "feature/x",
			commitSha: "abc123",
		});
		expect(JSON.stringify(signal)).not.toContain("secret");
	});
});

describe("classifyBotActivity", () => {
	it("classifies Copilot logins as copilot bot alerts", () => {
		expect(
			classifyBotActivity({ login: "github-copilot[bot]" }, "body"),
		).toMatchObject({ isBot: true, botKind: "copilot" });
	});

	it("classifies Cursor BugBot links as cursor-bugbot", () => {
		expect(
			classifyBotActivity(
				{ login: "cursor[bot]" },
				cursorLink({
					type: "BUGBOT_FIX_IN_WEB",
					data: { repoOwner: "o", repoName: "r", prNumber: 1 },
				}),
			),
		).toMatchObject({ isBot: true, botKind: "cursor-bugbot" });
	});

	it("does not classify normal human authors as bots", () => {
		expect(
			classifyBotActivity({ login: "octocat", type: "User" }, "looks good"),
		).toEqual({ isBot: false });
	});
});
