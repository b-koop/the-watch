import { describe, expect, it, vi } from "vitest";
import {
	buildRunnerInvocation,
	parseRunnerArgs,
	resolveRunnerInputs,
	runVetteReview,
} from "../scripts/vette-review.ts";

const extension = "/repo/extensions/pr-vette.ts";

describe("headless vette runner", () => {
	it("forwards selector and model with the comment-only safety flags", () => {
		const invocation = buildRunnerInvocation({
			selector: "42",
			model: "provider/model",
			cwd: "/repo",
			extension,
		});
		expect(invocation.args).toEqual([
			"--no-session",
			"--no-extensions",
			"-e",
			extension,
			"--model",
			"provider/model",
			"--print",
			"/vette 42 --comments-only --post-comments --no-watch",
		]);
		expect(invocation.args.join(" ")).not.toContain("API_KEY");
	});

	it("inherits credentials through the environment without putting them in argv", async () => {
		const launch = vi.fn((_command, _args, options) => {
			expect(options.env.SECRET_PROVIDER_KEY).toBe("not-argv");
			return {
				on(
					event: "error" | "close",
					callback: ((error: Error) => void) | ((code: number | null) => void),
				) {
					if (event === "close") (callback as (code: number | null) => void)(0);
				},
			};
		});
		await expect(
			runVetteReview({
				selector: "42",
				model: "provider/model",
				cwd: process.cwd(),
				env: { ...process.env, SECRET_PROVIDER_KEY: "not-argv" },
				launch,
			}),
		).resolves.toBe(0);
		expect(launch.mock.calls[0][1]).not.toContain("not-argv");
	});

	it("propagates a failed review process", async () => {
		const launch = vi.fn(() => ({
			on(
				event: "error" | "close",
				callback: ((error: Error) => void) | ((code: number | null) => void),
			) {
				if (event === "close") (callback as (code: number | null) => void)(7);
			},
		}));
		await expect(
			runVetteReview({ selector: "42", cwd: process.cwd(), launch }),
		).resolves.toBe(7);
	});

	it("uses pull_request event context by default", () => {
		const inputs = resolveRunnerInputs({
			cwd: process.cwd(),
			env: { GITHUB_EVENT_PATH: "/does/not/exist", PR_NUMBER: "42" },
		});
		expect(inputs.selector).toBe("42");
	});

	it("rejects unknown runner options", () => {
		expect(() => parseRunnerArgs(["--api-key", "secret"])).toThrow(
			"Unknown option",
		);
	});
});
