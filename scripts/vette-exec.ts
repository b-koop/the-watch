import { execFile } from "node:child_process";

export type VetteExecOptions = {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
};

export type VetteExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

/**
 * Plain-Node stand-in for pi's `ExtensionAPI["exec"]`.
 *
 * The vette engine takes its command runner as a parameter, so the only thing
 * standing between `buildVetteBetaDiffBundle` and a non-pi runtime is this
 * shim. Resolves rather than rejects on a non-zero exit, because callers
 * inspect `code` themselves.
 */
export function nodeExec(
	command: string,
	args: string[],
	options: VetteExecOptions = {},
): Promise<VetteExecResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd ?? process.cwd(),
				...(options.timeout ? { timeout: options.timeout } : {}),
				...(options.signal ? { signal: options.signal } : {}),
				maxBuffer: 64 * 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				const failure = error as (Error & { code?: number; killed?: boolean }) | null;
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
					killed: Boolean(failure?.killed),
				});
			},
		);
	});
}
