import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

export type ReviewCommentSeverity = "blocker" | "recommended" | "note";

export type ReviewCommentInput = {
	title: string;
	severity: ReviewCommentSeverity;
	file?: string;
	line?: number;
	codeSummary: string;
	what: string;
	why: string;
	evidence?: string;
	testCode?: string;
	fixBoundary?: string;
};

export type NormalizedReviewComment = ReviewCommentInput & {
	file?: string;
	line?: number;
};

export type ReviewCommentLocation = "line" | "file" | "general";
export type ReviewCommentPostResult = {
	index: number;
	location: ReviewCommentLocation;
	fallbackReasons: string[];
	ok: boolean;
	url?: string;
	error?: string;
};

export type ReviewCommentPostMetadata = {
	repository: string;
	pullRequest: number;
	commitId: string;
};

export type ReviewCommentExecutor = (
	command: string,
	args: string[],
) => Promise<{ stdout: string; stderr?: string }>;

const severities = new Set<ReviewCommentSeverity>([
	"blocker",
	"recommended",
	"note",
]);
const labels: Record<ReviewCommentSeverity, string> = {
	blocker: "🔴 **Blocker**",
	recommended: "🟡 **Recommended**",
	note: "🔵 **Note**",
};

function nonEmpty(value: unknown, field: string, index: number): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`comment ${index + 1}: ${field} must be a non-empty string`);
	}
	return value.trim();
}

function optionalText(
	value: unknown,
	field: string,
	index: number,
): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return nonEmpty(value, field, index);
}

function normalizeComment(
	value: unknown,
	index: number,
): NormalizedReviewComment {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`comment ${index + 1}: must be an object`);
	}
	const item = value as Record<string, unknown>;
	const allowed = new Set([
		"title",
		"severity",
		"file",
		"line",
		"codeSummary",
		"what",
		"why",
		"evidence",
		"testCode",
		"fixBoundary",
	]);
	for (const key of Object.keys(item))
		if (!allowed.has(key))
			throw new Error(`comment ${index + 1}: unknown field '${key}'`);
	const severity =
		typeof item.severity === "string"
			? item.severity.trim().toLowerCase()
			: item.severity;
	if (
		typeof severity !== "string" ||
		!severities.has(severity as ReviewCommentSeverity)
	) {
		throw new Error(
			`comment ${index + 1}: severity must be blocker, recommended, or note`,
		);
	}
	if (item.file === null)
		throw new Error(`comment ${index + 1}: file must be a string when provided`);
	if (item.line === null)
		throw new Error(
			`comment ${index + 1}: line must be a positive integer when provided`,
		);
	const file = optionalText(item.file, "file", index);
	if (item.line !== undefined) {
		if (!Number.isInteger(item.line) || (item.line as number) < 1) {
			throw new Error(`comment ${index + 1}: line must be a positive integer`);
		}
		if (!file) throw new Error(`comment ${index + 1}: line requires file`);
	}
	return {
		title: nonEmpty(item.title, "title", index),
		severity: severity as ReviewCommentSeverity,
		...(file ? { file } : {}),
		...(item.line === undefined ? {} : { line: item.line as number }),
		codeSummary: nonEmpty(item.codeSummary, "codeSummary", index),
		what: nonEmpty(item.what, "what", index),
		why: nonEmpty(item.why, "why", index),
		...(optionalText(item.evidence, "evidence", index)
			? { evidence: optionalText(item.evidence, "evidence", index) }
			: {}),
		...(optionalText(item.testCode, "testCode", index)
			? { testCode: optionalText(item.testCode, "testCode", index) }
			: {}),
		...(optionalText(item.fixBoundary, "fixBoundary", index)
			? { fixBoundary: optionalText(item.fixBoundary, "fixBoundary", index) }
			: {}),
	};
}

export function parseReviewComments(input: string): NormalizedReviewComment[] {
	if (typeof input !== "string" || input.trim() === "")
		throw new Error("comment payload must be a non-empty JSON string");
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch (error) {
		throw new Error(
			`invalid comment JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Array.isArray(parsed))
		throw new Error("comment payload root must be a JSON array");
	return parsed.map(normalizeComment);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function renderReviewComment(comment: NormalizedReviewComment): string {
	const sections = [
		labels[comment.severity],
		"",
		"<details>",
		`  <summary>${escapeHtml(comment.title)}</summary>`,
		"",
		"## Code summary",
		comment.codeSummary,
		"",
		"## What",
		comment.what,
		"",
		"## Why",
		comment.why,
	];
	if (comment.evidence) sections.push("", "## Evidence", comment.evidence);
	if (comment.testCode)
		sections.push("", "## Regression test", "```", comment.testCode, "```");
	if (comment.fixBoundary)
		sections.push("", "## Fix boundary", comment.fixBoundary);
	sections.push("", "</details>");
	return sections.join("\n");
}

const defaultExecutor: ReviewCommentExecutor = async (command, args) => {
	const execFile = promisify(nodeExecFile);
	const result = await execFile(command, args, { maxBuffer: 10 * 1024 * 1024 });
	return { stdout: String(result.stdout), stderr: String(result.stderr ?? "") };
};

async function postWith(
	executor: ReviewCommentExecutor,
	metadata: ReviewCommentPostMetadata,
	body: string,
	location: ReviewCommentLocation,
	comment: NormalizedReviewComment,
): Promise<string> {
	if (location === "general") {
		const result = await executor("gh", [
			"pr",
			"comment",
			String(metadata.pullRequest),
			"--repo",
			metadata.repository,
			"--body",
			body,
		]);
		return result.stdout.trim();
	}
	const args = [
		"api",
		`repos/${metadata.repository}/pulls/${metadata.pullRequest}/comments`,
		"--method",
		"POST",
		"-f",
		`body=${body}`,
		"-f",
		`commit_id=${metadata.commitId}`,
		"-f",
		`path=${comment.file}`,
	];
	if (location === "line")
		args.push("-F", `line=${comment.line}`, "-f", "side=RIGHT");
	const result = await executor("gh", args);
	try {
		return String(
			(JSON.parse(result.stdout) as { html_url?: string }).html_url ??
				result.stdout,
		).trim();
	} catch {
		return result.stdout.trim();
	}
}

export async function postReviewComments(
	comments: readonly NormalizedReviewComment[],
	metadata: ReviewCommentPostMetadata,
	executor: ReviewCommentExecutor = defaultExecutor,
): Promise<ReviewCommentPostResult[]> {
	const results: ReviewCommentPostResult[] = [];
	for (const [index, comment] of comments.entries()) {
		const body = renderReviewComment(comment);
		const fallbackReasons: string[] = [];
		const locations: ReviewCommentLocation[] =
			comment.file && comment.line
				? ["line", "file", "general"]
				: comment.file
					? ["file", "general"]
					: ["general"];
		let lastError = "";
		for (const location of locations) {
			try {
				const url = await postWith(executor, metadata, body, location, comment);
				results.push({ index, location, fallbackReasons, ok: true, url });
				lastError = "";
				break;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				if (location !== "general")
					fallbackReasons.push(`${location} placement rejected: ${lastError}`);
			}
		}
		if (lastError)
			results.push({
				index,
				location: "general",
				fallbackReasons,
				ok: false,
				error: lastError,
			});
	}
	return results;
}
