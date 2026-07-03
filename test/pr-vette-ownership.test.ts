import { describe, expect, it } from "vitest";
import {
	buildVetteBetaCommandStatus,
	inferLocalOwnership,
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
