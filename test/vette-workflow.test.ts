import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	new URL("../.github/workflows/vette-comments.yml", import.meta.url),
	"utf8",
);
const runner = readFileSync(
	new URL("../scripts/vette-review.ts", import.meta.url),
	"utf8",
);

describe("headless vette workflow", () => {
	it("uses pull_request, least privilege, and PR concurrency", () => {
		expect(workflow).toContain("pull_request:");
		expect(workflow).toContain("types: [opened, synchronize, reopened]");
		expect(workflow).toContain("contents: read");
		expect(workflow).toContain("pull-requests: write");
		expect(workflow).toContain("cancel-in-progress: true");
		expect(workflow).toContain("github.event.pull_request.number");
		expect(workflow).not.toContain("pull_request_target");
	});

	it("passes provider secrets through env and invokes the safety flags", () => {
		expect(workflow).toContain("secrets.ANTHROPIC_API_KEY");
		expect(workflow).toContain("secrets.OPENAI_API_KEY");
		expect(workflow).toContain("secrets.GOOGLE_API_KEY");
		expect(workflow).toContain("vars.VETTE_MODEL");
		expect(runner).toContain("--comments-only");
		expect(runner).toContain("--post-comments");
		expect(runner).toContain("--no-watch");
		expect(workflow).not.toContain("--api-key");
	});
});
