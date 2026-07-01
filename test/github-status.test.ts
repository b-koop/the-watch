import { describe, expect, it, vi } from "vitest";
import {
	fetchGitHubServiceStatus,
	normalizeGitHubStatusSummary,
	unknownServiceStatus,
} from "../extensions/gh-status/github-status.ts";

describe("normalizeGitHubStatusSummary", () => {
	it("normalizes aggregate status and relevant components", () => {
		const status = normalizeGitHubStatusSummary({
			page: { updated_at: "2026-05-27T12:00:00Z" },
			status: { indicator: "minor", description: "Minor service outage" },
			components: [
				{
					name: "Actions",
					status: "degraded_performance",
					updated_at: "2026-05-27T12:00:00Z",
				},
				{ name: "Pages", status: "operational" },
			],
			incidents: [
				{ id: "abc", name: "Actions degraded", status: "investigating" },
			],
			scheduled_maintenances: [{ name: "Maintenance", status: "scheduled" }],
		});

		expect(status.indicator).toBe("minor");
		expect(status.components).toEqual([
			{
				name: "Actions",
				status: "degraded_performance",
				updatedAt: "2026-05-27T12:00:00Z",
			},
		]);
		expect(status.incidents[0]?.name).toBe("Actions degraded");
		expect(status.scheduledMaintenances[0]?.name).toBe("Maintenance");
	});
});

describe("unknownServiceStatus", () => {
	it("represents fetch failures as unknown instead of outage", () => {
		expect(unknownServiceStatus("network failed")).toMatchObject({
			indicator: "unknown",
			description: "network failed",
		});
	});
});

describe("fetchGitHubServiceStatus", () => {
	it("fetches and normalizes GitHub Status summary JSON", async () => {
		const fetchImpl = vi.fn(
			async () =>
				({
					ok: true,
					json: async () => ({
						status: {
							indicator: "none",
							description: "All Systems Operational",
						},
						components: [],
					}),
				}) as Response,
		);

		await expect(
			fetchGitHubServiceStatus({ fetchImpl }),
		).resolves.toMatchObject({
			ok: true,
			value: { indicator: "none", description: "All Systems Operational" },
		});
	});

	it("returns fetch_failed when Statuspage returns a non-OK response", async () => {
		const fetchImpl = vi.fn(
			async () =>
				({ ok: false, status: 500, json: async () => ({}) }) as Response,
		);

		await expect(
			fetchGitHubServiceStatus({ fetchImpl }),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "fetch_failed" },
		});
	});

	it("returns fetch_timeout when the request aborts", async () => {
		const fetchImpl = vi.fn(
			(_input: string, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		);

		await expect(
			fetchGitHubServiceStatus({ fetchImpl, timeoutMs: 1 }),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "fetch_timeout" },
		});
	});
});
