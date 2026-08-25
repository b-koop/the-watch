#!/usr/bin/env node
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Spawned = {
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: (code: number | null) => void): unknown;
};
export type Launcher = (
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => Spawned;

export type RunnerOptions = {
	selector?: string;
	model?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	launch?: Launcher;
};

export function parseRunnerArgs(argv: string[]): {
	selector?: string;
	model?: string;
} {
	let selector: string | undefined;
	let model: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--model") {
			model = argv[++index];
			if (!model) throw new Error("--model requires a provider/model value");
		} else if (token === "--pr" || token === "--selector") {
			selector = argv[++index];
			if (!selector)
				throw new Error(`${token} requires a pull-request selector`);
		} else if (token.startsWith("--"))
			throw new Error(`Unknown option: ${token}`);
		else if (!selector) selector = token;
		else throw new Error("Only one pull-request selector is allowed");
	}
	if (!model || model.startsWith("-")) {
		if (model !== undefined)
			throw new Error("--model requires a provider/model value");
	}
	if (model !== undefined && !model.includes("/")) {
		throw new Error("--model must use provider/model format");
	}
	return { selector, model };
}

function eventPullRequest(env: NodeJS.ProcessEnv): number | undefined {
	const explicit = env.PR_NUMBER ?? env.GITHUB_PR_NUMBER;
	if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
	const eventPath = env.GITHUB_EVENT_PATH;
	if (!eventPath || !existsSync(eventPath)) return undefined;
	try {
		const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
			pull_request?: { number?: number };
		};
		return event.pull_request?.number;
	} catch {
		return undefined;
	}
}

export function resolveRunnerInputs(options: RunnerOptions = {}): {
	selector: string;
	model?: string;
	cwd: string;
	extension: string;
} {
	const cwd = resolve(options.cwd ?? process.cwd());
	const env = options.env ?? process.env;
	const selector =
		options.selector ??
		(eventPullRequest(env) ? String(eventPullRequest(env)) : undefined);
	if (!selector)
		throw new Error(
			"No pull-request context found; pass a selector or run from a pull_request event",
		);
	if (!/^(\d+|https?:\/\/|[A-Za-z0-9_.-]+(?:[/:#@][^\s]+)?)$/.test(selector)) {
		throw new Error("Invalid pull-request selector");
	}
	const extension = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../extensions/pr-vette.ts",
	);
	if (!existsSync(extension))
		throw new Error(`Review extension not found: ${extension}`);
	return {
		selector,
		model: options.model ?? env.VETTE_MODEL ?? env.VETTE_REVIEW_MODEL,
		cwd,
		extension,
	};
}

export function buildRunnerInvocation(
	inputs: ReturnType<typeof resolveRunnerInputs>,
): { command: string; args: string[] } {
	const args = ["--no-session", "--no-extensions", "-e", inputs.extension];
	if (inputs.model) args.push("--model", inputs.model);
	args.push(
		"--print",
		`/vette ${inputs.selector} --comments-only --post-comments --no-watch`,
	);
	return { command: process.env.PI_BIN ?? "pi", args };
}

export async function runVetteReview(
	options: RunnerOptions = {},
): Promise<number> {
	const inputs = resolveRunnerInputs(options);
	const invocation = buildRunnerInvocation(inputs);
	const launch: Launcher =
		options.launch ??
		((command, args, spawnOptions) =>
			nodeSpawn(command, args, spawnOptions) as Spawned);
	process.stderr.write(
		`Starting comment-only review for PR ${inputs.selector}${inputs.model ? ` with ${inputs.model}` : ""}\n`,
	);
	return new Promise<number>((resolveExit, reject) => {
		const child = launch(invocation.command, invocation.args, {
			cwd: inputs.cwd,
			env: options.env ?? process.env,
			stdio: "inherit",
		});
		child.on("error", (error: Error) =>
			reject(new Error(`Review process failed to start: ${error.message}`)),
		);
		child.on("close", (code: number | null) => resolveExit(code ?? 1));
	});
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	try {
		const parsed = parseRunnerArgs(process.argv.slice(2));
		const exitCode = await runVetteReview(parsed);
		process.exitCode = exitCode;
	} catch (error) {
		process.stderr.write(
			`vette review failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
