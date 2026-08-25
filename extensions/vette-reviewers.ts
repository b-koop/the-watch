import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

export type ReviewerChangeType =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| string;
export type ReviewerHook = string[];
export type ReviewerDefinition = {
	name: string;
	version: number;
	description: string;
	priority: number;
	paths: string[];
	languages: string[];
	frameworks: string[];
	changeTypes: ReviewerChangeType[];
	exclude: string[];
	pre: ReviewerHook[];
	post: ReviewerHook[];
	selector?: string;
	enabled: boolean;
	body: string;
	source: "builtin" | string;
	sourcePath: string;
};
export type ReviewerDiagnostic = {
	sourcePath: string;
	message: string;
	severity: "warning" | "error";
};
export type ChangedFileSummary = {
	paths: string[];
	statuses: Record<string, ReviewerChangeType>;
	additions: string[];
	modifications: string[];
	deletions: string[];
	renames: string[];
	extensions: string[];
	languages: string[];
	frameworks: string[];
	configFiles: string[];
};
export type SelectedReviewer = ReviewerDefinition & { matchReason: string };
export type ReviewerCatalog = {
	discovered: ReviewerDefinition[];
	selected: SelectedReviewer[];
	skipped: Array<{ name: string; reason: string }>;
	diagnostics: ReviewerDiagnostic[];
	summary: ChangedFileSummary;
};

const KNOWN_FIELDS = new Set([
	"name",
	"version",
	"description",
	"priority",
	"paths",
	"languages",
	"frameworks",
	"changeTypes",
	"exclude",
	"pre",
	"post",
	"selector",
	"enabled",
]);
const LANGUAGES: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".json": "json",
	".md": "markdown",
	".py": "python",
	".go": "go",
	".rs": "rust",
};

function scalar(value: string): unknown {
	const v = value.trim();
	if (v === "true") return true;
	if (v === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	if (v.startsWith("[") && v.endsWith("]")) {
		try {
			return JSON.parse(v.replace(/'/g, '"'));
		} catch {
			return v
				.slice(1, -1)
				.split(",")
				.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
				.filter(Boolean);
		}
	}
	if (v.startsWith("{") && v.endsWith("}")) {
		try {
			return JSON.parse(v.replace(/'/g, '"'));
		} catch {
			return undefined;
		}
	}
	return v.replace(/^['"]|['"]$/g, "");
}

function parseHook(value: string): ReviewerHook[] | undefined {
	const parsed = scalar(value);
	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(x) => Array.isArray(x) && x.every((y) => typeof y === "string"),
		)
	)
		return undefined;
	return parsed as ReviewerHook[];
}

export function parseReviewerMarkdown(
	markdown: string,
	sourcePath = "<memory>",
): { definition?: ReviewerDefinition; diagnostics: ReviewerDiagnostic[] } {
	const diagnostics: ReviewerDiagnostic[] = [];
	const match = markdown.match(
		/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/,
	);
	if (!match)
		return {
			diagnostics: [
				{
					sourcePath,
					severity: "error",
					message: "missing frontmatter delimiters",
				},
			],
		};
	const data: Record<string, unknown> = {};
	for (const line of match[1].split(/\r?\n/)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon < 1) {
			diagnostics.push({
				sourcePath,
				severity: "error",
				message: `malformed frontmatter line: ${line}`,
			});
			continue;
		}
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!KNOWN_FIELDS.has(key)) {
			diagnostics.push({
				sourcePath,
				severity: "warning",
				message: `unknown frontmatter field '${key}' ignored`,
			});
			continue;
		}
		const parsed =
			key === "pre" || key === "post" ? parseHook(value) : scalar(value);
		if (parsed === undefined) {
			diagnostics.push({
				sourcePath,
				severity: "error",
				message: `invalid value for '${key}'`,
			});
			continue;
		}
		data[key] = parsed;
	}
	const required = ["name", "description"];
	for (const key of required)
		if (typeof data[key] !== "string" || !(data[key] as string).trim())
			diagnostics.push({
				sourcePath,
				severity: "error",
				message: `missing required field '${key}'`,
			});
	if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
	const list = (key: string) =>
		Array.isArray(data[key]) && data[key].every((x) => typeof x === "string")
			? (data[key] as string[])
			: [];
	const definition: ReviewerDefinition = {
		name: String(data.name).trim().toLowerCase(),
		version: typeof data.version === "number" ? data.version : 1,
		description: String(data.description),
		priority: typeof data.priority === "number" ? data.priority : 0,
		paths: list("paths"),
		languages: list("languages").map((x) => x.toLowerCase()),
		frameworks: list("frameworks").map((x) => x.toLowerCase()),
		changeTypes: list("changeTypes").map((x) => x.toLowerCase()),
		exclude: list("exclude"),
		pre: (data.pre as ReviewerHook[] | undefined) ?? [],
		post: (data.post as ReviewerHook[] | undefined) ?? [],
		...(typeof data.selector === "string" ? { selector: data.selector } : {}),
		enabled: data.enabled !== false,
		body: match[2].trim(),
		source: "builtin",
		sourcePath,
	};
	return { definition, diagnostics };
}

function globToRegExp(glob: string): RegExp {
	let pattern = glob.replace(/\\/g, "/").replace(/[.+^${}()|[\]]/g, "\\$&");
	pattern = pattern
		.replace(/\*\*\//g, "§§DIR§§")
		.replace(/\*\*/g, "§§")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/§§DIR§§/g, "(?:.*/)?")
		.replace(/§§/g, ".*");
	return new RegExp(`^${pattern}$`, "i");
}
function matches(values: string[], path: string): boolean {
	return values.length === 0 || values.some((p) => globToRegExp(p).test(path));
}

export function summarizeChangedFiles(
	paths: string[],
	statuses: Record<string, ReviewerChangeType> = {},
): ChangedFileSummary {
	const normalized = [
		...new Set(paths.map((p) => p.replace(/^\.\//, "").replace(/\\/g, "/"))),
	];
	const status = (p: string) => statuses[p] ?? "modified";
	const additions = normalized.filter((p) => status(p) === "added");
	const modifications = normalized.filter((p) => status(p) === "modified");
	const deletions = normalized.filter((p) => status(p) === "deleted");
	const renames = normalized.filter((p) => status(p) === "renamed");
	const extensions = [
		...new Set(normalized.map((p) => extname(p).toLowerCase()).filter(Boolean)),
	];
	const languages = [
		...new Set(extensions.map((x) => LANGUAGES[x]).filter(Boolean)),
	];
	const configFiles = normalized.filter((p) =>
		/(^|\/)(package\.json|tsconfig[^/]*\.json|vite\.config\.|vitest\.config\.|eslint|prettier|\.github\/)/i.test(
			p,
		),
	);
	const frameworks = configFiles.some((p) => /package\.json/i.test(p))
		? ["node", "typescript", "javascript"].filter(
				(x) => languages.includes(x) || x === "node",
			)
		: [];
	return {
		paths: normalized.sort(),
		statuses: statusMap(normalized, statuses),
		additions,
		modifications,
		deletions,
		renames,
		extensions,
		languages,
		frameworks,
		configFiles,
	};
}
function statusMap(
	paths: string[],
	statuses: Record<string, ReviewerChangeType>,
) {
	return Object.fromEntries(paths.map((p) => [p, statuses[p] ?? "modified"]));
}

export function selectReviewers(
	definitions: ReviewerDefinition[],
	summary: ChangedFileSummary,
): ReviewerCatalog {
	const selected: SelectedReviewer[] = [],
		skipped: Array<{ name: string; reason: string }> = [];
	for (const reviewer of [...definitions].sort(
		(a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
	)) {
		if (!reviewer.enabled) {
			skipped.push({ name: reviewer.name, reason: "disabled by definition" });
			continue;
		}
		const candidates = summary.paths.filter(
			(path) =>
				matches(reviewer.paths, path) &&
				(reviewer.exclude.length === 0 || !matches(reviewer.exclude, path)),
		);
		const scoped = candidates.filter((path) => {
			const typeOk =
				reviewer.changeTypes.length === 0 ||
				reviewer.changeTypes.includes(summary.statuses[path] ?? "modified");
			const langOk =
				reviewer.languages.length === 0 ||
				reviewer.languages.includes(
					LANGUAGES[extname(path).toLowerCase()] ?? "",
				);
			const frameworkOk =
				reviewer.frameworks.length === 0 ||
				reviewer.frameworks.some((f) => summary.frameworks.includes(f));
			return typeOk && langOk && frameworkOk;
		});
		if (scoped.length)
			selected.push({
				...reviewer,
				matchReason: `${scoped.length} changed file(s): ${scoped.slice(0, 5).join(", ")}`,
			});
		else
			skipped.push({
				name: reviewer.name,
				reason: "no changed file matched selectors",
			});
	}
	return {
		discovered: definitions,
		selected,
		skipped,
		diagnostics: [],
		summary,
	};
}

async function loadDefinitions(
	dir: string,
	source: "builtin" | string,
	diagnostics: ReviewerDiagnostic[],
): Promise<ReviewerDefinition[]> {
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const result: ReviewerDefinition[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const path = join(dir, entry.name, "REVIEW.md");
		if (!existsSync(path)) {
			diagnostics.push({
				sourcePath: join(dir, entry.name),
				severity: "warning",
				message: "expected REVIEW.md not found",
			});
			continue;
		}
		try {
			const parsed = parseReviewerMarkdown(await readFile(path, "utf8"), path);
			diagnostics.push(...parsed.diagnostics);
			if (parsed.definition)
				result.push({ ...parsed.definition, source, sourcePath: path });
		} catch (error) {
			diagnostics.push({
				sourcePath: path,
				severity: "error",
				message: String(error),
			});
		}
	}
	return result;
}

export async function discoverReviewers(
	cwd: string,
	changedPaths: string[] = [],
	statuses: Record<string, ReviewerChangeType> = {},
): Promise<ReviewerCatalog> {
	const diagnostics: ReviewerDiagnostic[] = [];
	const builtinDir = new URL("./reviewers/", import.meta.url).pathname;
	const builtins = await loadDefinitions(builtinDir, "builtin", diagnostics);
	const localDir = join(resolve(cwd), ".reviewers");
	const locals = await loadDefinitions(localDir, localDir, diagnostics);
	const merged = new Map<string, ReviewerDefinition>();
	for (const definition of builtins) merged.set(definition.name, definition);
	for (const definition of locals) merged.set(definition.name, definition);
	const catalog = selectReviewers(
		[...merged.values()],
		summarizeChangedFiles(changedPaths, statuses),
	);
	return { ...catalog, diagnostics };
}

export type ReviewerRunPlan = {
	selected: string[];
	skipped: Array<{ name: string; reason: string }>;
	order: string[];
	hooks: Record<string, { pre: ReviewerHook[]; post: ReviewerHook[] }>;
	fallback: boolean;
	diagnostics: string[];
};

export function deterministicReviewerPlan(
	catalog: ReviewerCatalog,
): ReviewerRunPlan {
	const selected = catalog.selected.map((reviewer) => reviewer.name);
	return {
		selected,
		skipped: catalog.skipped,
		order: selected,
		hooks: Object.fromEntries(
			catalog.selected.map((r) => [r.name, { pre: r.pre, post: r.post }]),
		),
		fallback: true,
		diagnostics: catalog.diagnostics.map(
			(d) => `${d.sourcePath}: ${d.message}`,
		),
	};
}

export function validateReviewerPlan(
	raw: unknown,
	catalog: ReviewerCatalog,
): ReviewerRunPlan {
	const fallback = deterministicReviewerPlan(catalog);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
	const value = raw as Record<string, unknown>;
	if (
		!Array.isArray(value.selected) ||
		!value.selected.every((x) => typeof x === "string")
	)
		return fallback;
	const allowed = new Set(catalog.selected.map((r) => r.name));
	const selected = [...new Set(value.selected as string[])];
	if (selected.some((name) => !allowed.has(name))) return fallback;
	const order =
		Array.isArray(value.order) &&
		value.order.every((x) => typeof x === "string")
			? (value.order as string[])
			: selected;
	if (
		order.length !== selected.length ||
		new Set(order).size !== order.length ||
		order.some((name) => !allowed.has(name))
	)
		return fallback;
	return {
		selected,
		skipped: catalog.skipped,
		order,
		hooks: Object.fromEntries(
			catalog.selected
				.filter((r) => selected.includes(r.name))
				.map((r) => [r.name, { pre: r.pre, post: r.post }]),
		),
		fallback: false,
		diagnostics: [],
	};
}

export type ReviewerHookContext = {
	cwd: string;
	changedFiles: string[];
	diffPath?: string;
	reviewerName: string;
	outputDir: string;
};
export type ReviewerHookResult = {
	command: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	durationMs: number;
	error?: string;
};

export async function runReviewerHook(
	command: ReviewerHook,
	context: ReviewerHookContext,
	options: { timeoutMs?: number; maxOutputChars?: number } = {},
): Promise<ReviewerHookResult> {
	const started = Date.now();
	const maxOutputChars = options.maxOutputChars ?? 100_000;
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (command.length === 0 || command.some((part) => !part.trim()))
		return {
			command,
			exitCode: null,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 0,
			error: "empty hook command",
		};
	const env = {
		...process.env,
		VETTE_REPOSITORY_CWD: context.cwd,
		VETTE_CHANGED_FILES: context.changedFiles.join("\\n"),
		VETTE_DIFF_PATH: context.diffPath ?? "",
		VETTE_REVIEWER_NAME: context.reviewerName,
		VETTE_OUTPUT_DIR: context.outputDir,
	};
	return await new Promise((resolveResult) => {
		const child = spawn(command[0], command.slice(1), {
			cwd: context.cwd,
			env,
			shell: false,
		});
		let stdout = "",
			stderr = "",
			timedOut = false;
		const append = (current: string, value: string) =>
			(current + value).slice(-maxOutputChars);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk.toString());
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk.toString());
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveResult({
				command,
				exitCode: null,
				stdout,
				stderr,
				timedOut,
				durationMs: Date.now() - started,
				error: error.message,
			});
		});
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			resolveResult({
				command,
				exitCode,
				stdout,
				stderr,
				timedOut,
				durationMs: Date.now() - started,
			});
		});
	});
}

export function reviewerPlanInput(
	catalog: ReviewerCatalog,
	mode = "comment",
	target = "current worktree",
): string {
	return JSON.stringify(
		{
			mode,
			target,
			changedFiles: catalog.summary.paths,
			languages: catalog.summary.languages,
			frameworks: catalog.summary.frameworks,
			selected: catalog.selected.map(
				({
					name,
					description,
					priority,
					selector,
					pre,
					post,
					matchReason,
				}) => ({
					name,
					description,
					priority,
					selector,
					pre: pre.length > 0,
					post: post.length > 0,
					matchReason,
				}),
			),
			skipped: catalog.skipped,
		},
		null,
		2,
	);
}
