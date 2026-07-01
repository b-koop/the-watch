import type {
	GhStatusError,
	GitHubServiceStatus,
	GitHubStatusIncident,
	GitHubStatusIndicator,
} from "./types.ts";
import type { Result } from "./types.ts";

export const GITHUB_STATUS_SUMMARY_URL =
	"https://www.githubstatus.com/api/v2/summary.json";
const RELEVANT_COMPONENTS = new Set([
	"Git Operations",
	"API Requests",
	"Pull Requests",
	"Actions",
	"Copilot",
]);

type FetchLike = (
	input: string,
	init?: { signal?: AbortSignal },
) => Promise<Response>;

type StatuspageSummary = {
	page?: { updated_at?: string };
	status?: { indicator?: string; description?: string };
	components?: Array<{ name?: string; status?: string; updated_at?: string }>;
	incidents?: Array<Record<string, unknown>>;
	scheduled_maintenances?: Array<Record<string, unknown>>;
};

export function unknownServiceStatus(
	message = "GitHub service status unknown.",
	stale = false,
): GitHubServiceStatus {
	return {
		indicator: "unknown",
		description: message,
		components: [],
		incidents: [],
		scheduledMaintenances: [],
		stale,
	};
}

export function normalizeIndicator(
	indicator: string | undefined,
): GitHubStatusIndicator {
	if (
		indicator === "none" ||
		indicator === "minor" ||
		indicator === "major" ||
		indicator === "critical"
	) {
		return indicator;
	}
	if (indicator === "maintenance") return "maintenance";
	return "unknown";
}

function normalizeIncident(raw: Record<string, unknown>): GitHubStatusIncident {
	return {
		...(typeof raw.id === "string" ? { id: raw.id } : {}),
		name: typeof raw.name === "string" ? raw.name : "Untitled GitHub incident",
		...(typeof raw.status === "string" ? { status: raw.status } : {}),
		...(typeof raw.impact === "string" ? { impact: raw.impact } : {}),
		...(typeof raw.shortlink === "string" ? { shortlink: raw.shortlink } : {}),
		...(typeof raw.updated_at === "string"
			? { updatedAt: raw.updated_at }
			: {}),
	};
}

export function normalizeGitHubStatusSummary(
	raw: StatuspageSummary,
	stale = false,
): GitHubServiceStatus {
	const components = (raw.components ?? [])
		.filter(
			(component) =>
				typeof component.name === "string" &&
				typeof component.status === "string",
		)
		.map((component) => ({
			name: component.name as string,
			status: component.status as string,
			...(typeof component.updated_at === "string"
				? { updatedAt: component.updated_at }
				: {}),
		}))
		.filter(
			(component) =>
				RELEVANT_COMPONENTS.has(component.name) ||
				component.status !== "operational",
		);

	return {
		indicator: normalizeIndicator(raw.status?.indicator),
		description:
			raw.status?.description ?? "GitHub service status unavailable.",
		...(raw.page?.updated_at ? { updatedAt: raw.page.updated_at } : {}),
		components,
		incidents: (raw.incidents ?? []).map(normalizeIncident),
		scheduledMaintenances: (raw.scheduled_maintenances ?? []).map(
			normalizeIncident,
		),
		stale,
	};
}

export async function fetchGitHubServiceStatus(
	options: {
		fetchImpl?: FetchLike;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<Result<GitHubServiceStatus>> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 10_000,
	);
	const abortFromParent = () => controller.abort();
	options.signal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const response = await fetchImpl(GITHUB_STATUS_SUMMARY_URL, {
			signal: controller.signal,
		});
		if (!response.ok) {
			return {
				ok: false,
				error: {
					kind: "fetch_failed",
					message: `GitHub Status returned HTTP ${response.status}.`,
				},
			};
		}

		const raw = (await response.json()) as StatuspageSummary;
		return { ok: true, value: normalizeGitHubStatusSummary(raw) };
	} catch (error) {
		const aborted = controller.signal.aborted;
		const ghError: GhStatusError = {
			kind: aborted ? "fetch_timeout" : "fetch_failed",
			message: aborted
				? "Timed out fetching GitHub Status."
				: error instanceof Error
					? error.message
					: "Failed to fetch GitHub Status.",
		};
		return { ok: false, error: ghError };
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromParent);
	}
}
