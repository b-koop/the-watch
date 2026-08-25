import { execFileSync } from "node:child_process";
import type { GhSnapshot } from "./types.ts";
import { renderPrStatus, renderServiceStatus } from "./render.ts";

export type CmuxDescriptionProvider = () => string | undefined;

export function buildCmuxWorkspaceDescription(
	snapshot: GhSnapshot,
	details?: string,
): string {
	const lines = [
		renderServiceStatus(snapshot.service),
		renderPrStatus(snapshot.pr),
	];
	if (snapshot.repo.kind === "repo") {
		lines.push(
			`In workspace: ${snapshot.repo.repo.fullName} · ${snapshot.repo.branch}`,
		);
	}
	if (details) lines.push(details);
	return lines.join("\n");
}

export function setCmuxWorkspaceDescription(description: string): void {
	if (!process.env.CMUX_WORKSPACE_ID) return;
	try {
		execFileSync(
			"cmux",
			[
				"workspace-action",
				"--action",
				"set-description",
				"--description",
				description,
			],
			{ stdio: "ignore", timeout: 1_000 },
		);
	} catch {
		// cmux is optional; an unavailable session must not affect status refresh.
	}
}
