import { describe, expect, it, vi } from "vitest";
import {
	baseBranchCandidates,
	resolveBaseBranch,
	resolveBaseRef,
} from "../extensions/base-branch.ts";

type GitFixture = {
	/** Branches that exist as `origin/<name>`. */
	remote?: string[];
	/** Branches that exist only locally. */
	local?: string[];
	/** What `origin/HEAD` advertises, if anything. */
	originHead?: string;
	/** Commits on the head that are not on the given ref. */
	distances?: Record<string, number>;
	headBranch?: string;
};

function fakeGit(fixture: GitFixture) {
	const remote = new Set(fixture.remote ?? []);
	const local = new Set(fixture.local ?? []);
	return vi.fn(async (args: string[]) => {
		const joined = args.join(" ");
		if (joined === "symbolic-ref refs/remotes/origin/HEAD --short") {
			if (!fixture.originHead) throw new Error("no origin/HEAD");
			return `origin/${fixture.originHead}`;
		}
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
			return fixture.headBranch ?? "feature/demo";
		}
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			const ref = String(args[3]).replace(/\^\{commit\}$/, "");
			if (ref === "HEAD") return "headsha";
			const bare = ref.replace(/^origin\//, "");
			const exists = ref.startsWith("origin/") ? remote.has(bare) : local.has(bare);
			if (!exists) throw new Error(`unknown ref ${ref}`);
			return `sha-${ref}`;
		}
		if (args[0] === "merge-base") return `mb-${args[1]}`;
		if (args[0] === "rev-list" && args[1] === "--count") {
			const ref = String(args[2]).replace(/^mb-/, "").split("..")[0];
			const distance = fixture.distances?.[ref];
			if (distance === undefined) throw new Error(`no distance for ${ref}`);
			return String(distance);
		}
		throw new Error(`unexpected git ${joined}`);
	});
}

describe("baseBranchCandidates", () => {
	it("checks dev-style branches before the repository default", () => {
		expect(baseBranchCandidates("main", "feature/x")).toEqual([
			"dev",
			"develop",
			"development",
			"main",
			"master",
			"trunk",
		]);
	});

	it("keeps a non-standard default branch ahead of the trunk names", () => {
		expect(baseBranchCandidates("integration", "feature/x")).toEqual([
			"dev",
			"develop",
			"development",
			"integration",
			"main",
			"master",
			"trunk",
		]);
	});

	it("never offers the head branch as its own base", () => {
		expect(baseBranchCandidates("main", "develop")).not.toContain("develop");
		expect(baseBranchCandidates("main", "origin/main")).not.toContain("main");
	});
});

describe("resolveBaseBranch", () => {
	it("picks the closest fork point instead of the default branch", async () => {
		const base = await resolveBaseBranch(
			fakeGit({
				originHead: "main",
				remote: ["main", "develop"],
				// The branch is 3 commits off develop, which is itself 40 off main.
				distances: { "origin/develop": 3, "origin/main": 43 },
			}),
		);
		expect(base).toMatchObject({
			branch: "develop",
			ref: "origin/develop",
			distance: 3,
			reason: "fork-point",
		});
	});

	it("prefers dev over main when both are equally distant", async () => {
		const base = await resolveBaseBranch(
			fakeGit({
				originHead: "main",
				remote: ["main", "dev"],
				distances: { "origin/dev": 2, "origin/main": 2 },
			}),
		);
		expect(base.ref).toBe("origin/dev");
	});

	it("stays on main when the branch really was cut from main", async () => {
		const base = await resolveBaseBranch(
			fakeGit({
				originHead: "main",
				remote: ["main", "develop"],
				distances: { "origin/main": 1, "origin/develop": 12 },
			}),
		);
		expect(base.ref).toBe("origin/main");
	});

	it("falls back to a local branch when the remote ref is missing", async () => {
		const base = await resolveBaseBranch(
			fakeGit({
				local: ["develop"],
				distances: { develop: 4 },
			}),
		);
		expect(base).toMatchObject({ branch: "develop", ref: "develop" });
	});

	it("does not choose the head branch as its own base", async () => {
		const base = await resolveBaseBranch(
			fakeGit({
				originHead: "main",
				headBranch: "develop",
				remote: ["main", "develop"],
				distances: { "origin/main": 9, "origin/develop": 0 },
			}),
			"develop",
		);
		expect(base.ref).toBe("origin/main");
	});

	it("falls back to origin/HEAD when no candidate resolves", async () => {
		const base = await resolveBaseBranch(fakeGit({ originHead: "trunk-x" }));
		expect(base).toMatchObject({
			branch: "trunk-x",
			ref: "origin/trunk-x",
			reason: "origin-head",
		});
	});

	it("falls back to origin/main when git tells us nothing", async () => {
		const git = vi.fn(async () => {
			throw new Error("not a git repository");
		});
		expect(await resolveBaseRef(git)).toBe("origin/main");
	});
});
