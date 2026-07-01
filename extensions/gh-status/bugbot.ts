import type { BotKind, CursorBugBotSignal } from "./types.ts";

const CURSOR_BUGBOT_HOST = "cursor.com";
const CURSOR_BUGBOT_TYPE = "BUGBOT_FIX_IN_WEB";

type BotClassification = {
	isBot: boolean;
	botKind?: BotKind;
	botMatcher?: string;
	cursorBugBot?: CursorBugBotSignal;
};

type AuthorLike = {
	login?: string;
	type?: string;
	__typename?: string;
};

type CursorPayload = {
	type?: string;
	data?: {
		repoOwner?: string;
		repoName?: string;
		prNumber?: number;
		branch?: string;
		commitSha?: string;
	};
};

export function decodeBase64UrlJson(value: string): unknown | undefined {
	try {
		const padded = value.padEnd(
			value.length + ((4 - (value.length % 4)) % 4),
			"=",
		);
		const json = Buffer.from(
			padded.replaceAll("-", "+").replaceAll("_", "/"),
			"base64",
		).toString("utf8");
		return JSON.parse(json) as unknown;
	} catch {
		return undefined;
	}
}

export function extractCursorBugBotSignal(
	text: string,
): CursorBugBotSignal | undefined {
	const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];

	for (const rawUrl of urls) {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			continue;
		}

		if (url.hostname !== CURSOR_BUGBOT_HOST || url.pathname !== "/agents")
			continue;

		const link = url.searchParams.get("link");
		if (!link) continue;

		const payload = decodeBase64UrlJson(link) as CursorPayload | undefined;
		if (payload?.type !== CURSOR_BUGBOT_TYPE) continue;

		const data = payload.data;
		if (!data?.repoOwner || !data.repoName || typeof data.prNumber !== "number")
			continue;

		return {
			type: CURSOR_BUGBOT_TYPE,
			repoOwner: data.repoOwner,
			repoName: data.repoName,
			prNumber: data.prNumber,
			...(data.branch ? { branch: data.branch } : {}),
			...(data.commitSha ? { commitSha: data.commitSha } : {}),
		};
	}

	return undefined;
}

export function classifyBotActivity(
	author: AuthorLike | undefined,
	body: string,
): BotClassification {
	const login = author?.login?.toLowerCase() ?? "";
	const type =
		author?.type?.toLowerCase() ?? author?.__typename?.toLowerCase() ?? "";
	const cursorBugBot = extractCursorBugBotSignal(body);

	if (cursorBugBot) {
		return {
			isBot: true,
			botKind: "cursor-bugbot",
			botMatcher: "cursor BUGBOT_FIX_IN_WEB link",
			cursorBugBot,
		};
	}

	if (login.includes("copilot") || login.includes("github-copilot")) {
		return { isBot: true, botKind: "copilot", botMatcher: "copilot login" };
	}

	if (login.includes("bugbot")) {
		return { isBot: true, botKind: "other-bot", botMatcher: "bugbot login" };
	}

	if (login.endsWith("[bot]") || type === "bot" || type === "app") {
		return {
			isBot: true,
			botKind: "github-bot",
			botMatcher: login.endsWith("[bot]")
				? "[bot] login"
				: `${type} author type`,
		};
	}

	return { isBot: false };
}
