import { describe, expect, it } from "vitest";
import {
	buildVetteBetaCommandStatus,
	draftPrPrompt,
	inferLocalOwnership,
	reviewCommentTemplateContract,
} from "../extensions/pr-vette.ts";
import { VETTE_BETA_TOPICS } from "../extensions/vette-beta.ts";

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

	it("groups verified-but-untestable findings into one details panel per finding", () => {
		const contract = reviewCommentTemplateContract();

		expect(contract).toContain(
			"Verified findings without focused repro tests: <one short sentence summarizing the shared risk without overstating severity>.",
		);
		expect(contract).toContain(
			"<summary><one sentence stating what breaks and why for this finding></summary>",
		);
		expect(contract).toContain(
			"Repeat one `<details>` block per verified-but-untestable finding.",
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
	});

	it("carries local model mode into draft PR vetting", () => {
		const prompt = draftPrPrompt(
			{
				branch: "feature/x",
				baseBranch: "main",
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
