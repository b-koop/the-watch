#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
	postReviewComments,
	parseReviewComments,
	renderReviewComment,
	type ReviewCommentPostMetadata,
} from "../extensions/review-comments.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PostVetteErrorCode =
	| "INVALID_ARGUMENTS"
	| "INVALID_COMMENT_PAYLOAD"
	| "PR_METADATA_QUERY_FAILED"
	| "PR_METADATA_INVALID"
	| "COMMENT_POST_FAILED";

export class PostVetteError extends Error {
	readonly code: PostVetteErrorCode;

	constructor(code: PostVetteErrorCode, message: string) {
		super(message);
		this.name = "PostVetteError";
		this.code = code;
	}
}

type CliArgs = {
	selector?: string;
	json?: string;
	file?: string;
	stdin: boolean;
	dryRun: boolean;
};

export function parsePostCommentArgs(argv: string[]): CliArgs {
	const result: CliArgs = { stdin: false, dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--pr" || token === "--selector") result.selector = argv[++i];
		else if (token === "--json") result.json = argv[++i];
		else if (token === "--file") result.file = argv[++i];
		else if (token === "--stdin") result.stdin = true;
		else if (token === "--dry-run" || token === "--validate")
			result.dryRun = true;
		else if (token.startsWith("--"))
			throw new Error(`Unknown option: ${token}`);
		else if (!result.selector) result.selector = token;
		else throw new Error("Only one pull-request selector is allowed");
	}
	if (
		[result.json, result.file].filter(Boolean).length + (result.stdin ? 1 : 0) >
		1
	)
		throw new Error("Choose exactly one of --json, --file, or --stdin");
	if (!result.json && !result.file && !result.stdin)
		throw new Error("Provide comment JSON with --json, --file, or --stdin");
	if (!result.dryRun && !result.selector)
		throw new Error(
			"Provide a pull-request selector unless using --dry-run/--validate",
		);
	return result;
}

async function readPayload(args: CliArgs): Promise<string> {
	if (args.json !== undefined) return args.json;
	if (args.file) return readFile(args.file, "utf8");
	return new Promise((resolve, reject) => {
		let value = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			value += chunk;
		});
		process.stdin.on("end", () => resolve(value));
		process.stdin.on("error", reject);
	});
}

type PullRequestMetadataJson = {
	number?: number;
	headRefOid?: string;
	headRepository?: { nameWithOwner?: string };
};

export function parsePullRequestMetadata(
	input: string,
	repository: string,
): ReviewCommentPostMetadata {
	let value: Pick<PullRequestMetadataJson, "number" | "headRefOid">;
	try {
		value = JSON.parse(input) as typeof value;
	} catch (error) {
		throw new PostVetteError(
			"PR_METADATA_INVALID",
			`invalid PR metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!value.number || !value.headRefOid || !repository)
		throw new PostVetteError(
			"PR_METADATA_INVALID",
			"PR metadata did not include number, head commit, and base repository",
		);
	return {
		pullRequest: value.number,
		commitId: value.headRefOid,
		repository,
	};
}

function repositoryFromSelector(selector: string): string | undefined {
	try {
		const url = new URL(selector);
		if (url.hostname !== "github.com") return undefined;
		const [owner, repo] = url.pathname.split("/").filter(Boolean);
		return owner && repo ? `${owner}/${repo.replace(/\.git$/, "")}` : undefined;
	} catch {
		const match = selector.match(/^([^/\s]+\/[^#\s]+)#\d+$/);
		return match?.[1];
	}
}

async function resolveMetadata(
	selector: string,
): Promise<ReviewCommentPostMetadata> {
	let prResult: { stdout: string };
	try {
		prResult = await execFileAsync("gh", [
			"pr",
			"view",
			selector,
			"--json",
			"number,headRefOid",
		]);
	} catch (error) {
		const detail = error as { stderr?: string; message?: string };
		throw new PostVetteError(
			"PR_METADATA_QUERY_FAILED",
			`could not read pull request '${selector}': ${(detail.stderr || detail.message || String(error)).trim()}`,
		);
	}

	let repository = repositoryFromSelector(selector);
	if (!repository) {
		try {
			const repoResult = await execFileAsync("gh", [
				"repo",
				"view",
				"--json",
				"nameWithOwner",
			]);
			repository = (
				JSON.parse(String(repoResult.stdout)) as { nameWithOwner?: string }
			).nameWithOwner;
		} catch (error) {
			throw new PostVetteError(
				"PR_METADATA_QUERY_FAILED",
				`could not determine the base repository for '${selector}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return parsePullRequestMetadata(String(prResult.stdout), repository ?? "");
}

export async function runPostVetteComments(
	argv = process.argv.slice(2),
): Promise<number> {
	try {
		const args = parsePostCommentArgs(argv);
		let comments;
		try {
			comments = parseReviewComments(await readPayload(args));
		} catch (error) {
			throw new PostVetteError(
				"INVALID_COMMENT_PAYLOAD",
				error instanceof Error ? error.message : String(error),
			);
		}
		if (args.dryRun) {
			process.stdout.write(
				JSON.stringify(
					{
						valid: true,
						count: comments.length,
						comments: comments.map(renderReviewComment),
					},
					null,
					2,
				) + "\n",
			);
			return 0;
		}
		if (!args.selector)
			throw new Error("A pull-request selector is required for posting");
		const metadata = await resolveMetadata(args.selector);
		const results = await postReviewComments(comments, metadata);
		process.stdout.write(JSON.stringify({ metadata, results }, null, 2) + "\n");
		if (!results.every((result) => result.ok)) {
			process.stderr.write(
				"post-vette-comments failed [COMMENT_POST_FAILED]: one or more comments could not be posted\n",
			);
			return 5;
		}
		return 0;
	} catch (error) {
		const code =
			error instanceof PostVetteError ? error.code : "INVALID_ARGUMENTS";
		process.stderr.write(
			`post-vette-comments failed [${code}]: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		if (code === "INVALID_COMMENT_PAYLOAD") return 3;
		if (code === "PR_METADATA_QUERY_FAILED" || code === "PR_METADATA_INVALID")
			return 4;
		return 2;
	}
}

if (process.argv[1]?.endsWith("post-vette-comments.ts"))
	process.exitCode = await runPostVetteComments();
