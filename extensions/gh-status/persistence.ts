import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SeenMarks } from "./types.ts";

export const GH_STATUS_SEEN_CUSTOM_TYPE = "gh-status-seen";

type CustomEntryLike = {
	type?: string;
	customType?: string;
	data?: unknown;
};

function isSeenMarks(value: unknown): value is SeenMarks {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SeenMarks>;
	return (
		candidate.version === 1 &&
		Array.isArray(candidate.keys) &&
		candidate.keys.every((key) => typeof key === "string")
	);
}

export function restoreSeenMarks(
	ctx: Pick<ExtensionContext, "sessionManager">,
): Set<string> {
	const seen = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch() as CustomEntryLike[]) {
		if (
			entry.type !== "custom" ||
			entry.customType !== GH_STATUS_SEEN_CUSTOM_TYPE ||
			!isSeenMarks(entry.data)
		) {
			continue;
		}
		for (const key of entry.data.keys) seen.add(key);
	}
	return seen;
}

export function markSeen(
	pi: Pick<ExtensionAPI, "appendEntry">,
	seen: Set<string>,
	keys: string[],
	now = new Date(),
): void {
	const newKeys = keys.filter((key) => !seen.has(key));
	if (newKeys.length === 0) return;

	for (const key of newKeys) seen.add(key);
	pi.appendEntry<SeenMarks>(GH_STATUS_SEEN_CUSTOM_TYPE, {
		version: 1,
		keys: newKeys,
		updatedAt: now.toISOString(),
	});
}
