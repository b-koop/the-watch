import { describe, expect, it } from "vitest";
import {
	buildVetteBetaCommandStatus,
	draftPrPrompt,
	parseVetteArgs,
	resolveVetteReviewMode,
	inferLocalOwnership,
	reviewCommentTemplateContract,
} from "../extensions/pr-vette.ts";
import { VETTE_BETA_TOPICS } from "../extensions/vette-beta.ts";

describe("comment-only vette arguments", () => {
	it("recognizes posting, no-watch, and dry-run flags", () => {
		expect(
			parseVetteArgs("123 --comments-only --post-comments --no-watch"),
		).toMatchObject({
			selector: "123",
			commentsOnly: true,
			wantsPosting: true,
			wantsWatch: false,
		});
		expect(parseVetteArgs("123 --comments-only --no-post")).toMatchObject({
			commentsOnly: true,
			wantsPosting: false,
			noPost: true,
		});
	});

	it("forces external comments even when ownership would select repair", () => {
		expect(
			resolveVetteReviewMode({ targetMode: "repair", commentsOnly: true }),
		).toBe("comment");
		expect(() =>
			resolveVetteReviewMode({ isSelfReview: true, commentsOnly: true }),
		).toThrow("cannot be combined");
	});
});

describe("buildVetteBetaCommandStatus", () => {
	it("shows self vette as visible repair work while topic agents run", () => {
		expect(
			buildVetteBetaCommandStatus({
				targetLabel: "current branch self-review",
				reviewMode: "repair",
				queued: false,
			}),
		).toMatchObject({
			command: "vette",
			target: "current branch self-review",
			mode: "owned/self repair",
			phase: "working",
			progress: `0/${VETTE_BETA_TOPICS.length}`,
		});
	});

	it("shows doc vette as local findings while topic agents run", () => {
		expect(
			buildVetteBetaCommandStatus({
				targetLabel: "current worktree",
				reviewMode: "doc",
				queued: false,
			}),
		).toMatchObject({
			command: "vette",
			target: "current worktree",
			mode: "local doc findings",
			phase: "working",
			progress: `0/${VETTE_BETA_TOPICS.length}`,
		});
	});
});

describe("reviewCommentTemplateContract", () => {
	it("keeps verified issue evidence collapsed behind concise summaries", () => {
		const contract = reviewCommentTemplateContract();

		expect(contract).toContain("<details>");
		expect(contract).toContain(
			"<summary>Verified issue: <one sentence stating what breaks and why></summary>",
		);
		expect(contract).toContain(
			"Summary text must be one sentence, behavior-first",
		);
		expect(contract).toContain(
			"always leave one blank line after the closing `</summary>` tag",
		);
		expect(contract).toContain("**Evidence:**");
		expect(contract).toContain("</details>");
	});

	it("splits verified-but-untestable findings onto files before grouping unanchored items", () => {
		const contract = reviewCommentTemplateContract();

		expect(contract).toContain(
			"For file/line-level verified-but-untestable findings, post one comment per finding",
		);
		expect(contract).toContain(
			"Verified findings without focused repro tests: <one short sentence summarizing the shared risk without overstating severity>.",
		);
		expect(contract).toContain(
			"These PR-wide items were verified but were not practical to demonstrate with focused unit/regression tests or anchor to a useful changed file.",
		);
		expect(contract).toContain(
			"If every verified-but-untestable finding was posted as a file/line-level comment",
		);
	});

	it("preserves minimal naming suggestion comments outside the details template", () => {
		const contract = reviewCommentTemplateContract();

		expect(contract).toContain("do not use the verified issue template");
		expect(contract).toContain("```suggest");
	});

	it("requires scan labels at the top of every comment template", () => {
		const contract = reviewCommentTemplateContract();

		expect(contract).toContain("🔴 **Blocker**");
		expect(contract).toContain("🟡 **Recommended**");
		expect(contract).toContain("🔵 **Note**");
		expect(contract.indexOf("🔴 **Blocker**")).toBeLessThan(
			contract.indexOf("<details>"),
		);
	});
});

describe("draftPrPrompt", () => {
	it("opens a draft PR before vetting so human review runs in parallel", () => {
		const prompt = draftPrPrompt(
			{
				branch: "feature/x",
				baseBranch: "main",
				baseRef: "origin/main",
				localIdentity: "Dev User <dev@example.com>",
				dirtyStatus: "",
				remoteUrl: "git@github.com:o/r.git",
			},
			"no open PR for branch",
			"",
			{ wantsPosting: false, wantsWatch: true },
		);

		expect(prompt).toContain(
			"working on (1/4): pushing branch and creating draft PR",
		);
		expect(prompt).toContain("gh pr create --draft");
		expect(prompt).toContain("gh pr ready");
		expect(prompt.indexOf("pushing branch and creating draft PR")).toBeLessThan(
			prompt.indexOf("vetting branch while draft PR"),
		);
		expect(prompt).toContain("marking PR ready for review");
		expect(prompt).toContain("retry the exact command up to 3 total attempts");
		expect(prompt).toContain("current /vette beta workflow");
		expect(prompt).toContain("covering all 11 sections");
		expect(prompt).toContain("1. Correctness (correctness)");
		expect(prompt).toContain("3. Test quality (test-quality)");
		expect(prompt).toContain("11. Feature behavior specs (behavior-specs)");
	});

	it("includes standard Fallow audit instructions in draft PR vetting", () => {
		const prompt = draftPrPrompt(
			{
				branch: "feature/x",
				baseBranch: "main",
				baseRef: "origin/main",
				localIdentity: "Dev User <dev@example.com>",
				dirtyStatus: "",
				remoteUrl: "git@github.com:o/r.git",
			},
			"no open PR for branch",
			"",
			{ wantsPosting: false, wantsWatch: true },
		);

		expect(prompt).toContain("Required Fallow audit leg");
		expect(prompt).toContain(
			"pnpx fallow audit --base origin/main --gate new-only",
		);
		expect(prompt).toContain("advisory candidates, not verified findings");
		expect(prompt).toContain("Run the Fallow command once per vette pass");
		expect(prompt).toContain(
			"Fallow may exit with status 1 when it successfully found audit items",
		);
		expect(prompt).toContain("exit 1 with usable findings/output");
		expect(prompt).toContain(
			"do not rerun it solely because the exit code is 1",
		);
	});

	it("audits against the resolved base branch rather than origin/main", () => {
		const prompt = draftPrPrompt(
			{
				branch: "feature/x",
				baseBranch: "develop",
				baseRef: "origin/develop",
				localIdentity: "Dev User <dev@example.com>",
				dirtyStatus: "",
				remoteUrl: "git@github.com:o/r.git",
			},
			"no open PR for branch",
			"",
			{ wantsPosting: false, wantsWatch: true },
		);

		expect(prompt).toContain(
			"pnpx fallow audit --base origin/develop --gate new-only",
		);
		expect(prompt).not.toContain("--base origin/main");
	});

	it("carries local model mode into draft PR vetting", () => {
		const prompt = draftPrPrompt(
			{
				branch: "feature/x",
				baseBranch: "main",
				baseRef: "origin/main",
				localIdentity: "Dev User <dev@example.com>",
				dirtyStatus: "",
				remoteUrl: "git@github.com:o/r.git",
			},
			"no open PR for branch",
			"--local",
			{ wantsPosting: false, wantsWatch: true, forceLocal: true },
		);

		expect(prompt).toContain("Local model mode (--local)");
		expect(prompt).toContain("Do not use remote/cloud model fallbacks");
	});
});

describe("inferLocalOwnership", () => {
	it("treats the local branch as owned when a local author has contributed a non-merge commit", () => {
		expect(
			inferLocalOwnership({
				localUserEmail: "dev@example.com",
				localUserName: "Dev User",
				commits: [
					{
						authorEmail: "dev@example.com",
						authorName: "Dev User",
						message: "Add the PR guard",
					},
				],
			}),
		).toEqual({ isOwner: true, ownership: "local" });
	});

	it("treats matching author evidence on merge commits as external", () => {
		expect(
			inferLocalOwnership({
				localUserEmail: "dev@example.com",
				localUserName: "Dev User",
				commits: [
					{
						authorEmail: "dev@example.com",
						authorName: "Dev User",
						message: "Merge branch 'main' into feature",
						parents: ["base", "feature"],
					},
				],
			}),
		).toEqual({ isOwner: false, ownership: "external" });
	});

	it("treats name-only author matches as external when the email differs", () => {
		expect(
			inferLocalOwnership({
				localUserEmail: "dev@example.com",
				localUserName: "Dev User",
				commits: [
					{
						authorEmail: "other@example.com",
						authorName: "Dev User",
						message: "Add the PR guard",
					},
				],
			}),
		).toEqual({ isOwner: false, ownership: "external" });
	});

	it("treats branches as external when no local email is configured, even with a name match", () => {
		expect(
			inferLocalOwnership({
				localUserName: "Dev User",
				commits: [
					{
						authorEmail: "dev@example.com",
						authorName: "Dev User",
						message: "Add the PR guard",
					},
				],
			}),
		).toEqual({ isOwner: false, ownership: "external" });
	});

	it("treats branches without local commit evidence as external", () => {
		expect(
			inferLocalOwnership({
				localUserEmail: "dev@example.com",
				localUserName: "Dev User",
				commits: [
					{
						authorEmail: "teammate@example.com",
						authorName: "Teammate",
						message: "Add the PR guard",
					},
				],
			}),
		).toEqual({ isOwner: false, ownership: "external" });
	});
});
