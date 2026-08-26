# Watch

Watches pull requests with PR-aware `/vette`, `/pr`, `/watch`, `/peek`, and
GitHub status commands.

`/vette` runs on **two runtimes** from one codebase. Both read the same reviewer
definitions in `extensions/reviewers/`, build the same diff bundle, and post
through the same validated comment boundary. Only the fan-out differs: pi spawns
subprocess agents, Claude Code uses the Workflow tool.

## Install

### pi

```bash
pi install npm:@ai-local/watch
```

Or for local development:

```bash
pi -e .
```

### Claude Code

This repository is also a Claude Code plugin. The simplest install is to symlink
the checkout into your skills directory, where it auto-loads as a plugin:

```bash
ln -s "$(pwd)" ~/.claude/skills/watch
```

Confirm it loaded (a new session is needed to pick it up):

```bash
claude plugin list      # → watch@skills-dir ... Status: ✔ loaded
claude plugin details watch
```

Then, from any repository:

```
/watch:vette 123
```

**Use the namespaced form.** A differently-scoped `vette` skill is common in
personal skill sets, so bare `/vette` may resolve to that one instead. Both are
registered, so the prefix is what disambiguates. Inside this repository the
`.claude/` symlinks also make plain `/vette` resolve here during development.

The plugin registers two entries: the `watch:vette` skill (the entry point) and
the `watch:vette-lanes` workflow it calls. `/vette` instructs the model to call
`Workflow`, which satisfies that tool's opt-in requirement — no extra flag
needed.

Scripts resolve through `${CLAUDE_PLUGIN_ROOT}` so they run from any repository,
reading that repo's git state rather than the plugin's. Note that the symlink
install relies on the checkout's own `node_modules` — a bare `npm install` of the
published package would also need the `smart-model-run` dependency resolvable.

Requirements: Node 18+ (24 recommended), `gh` authenticated, and the `Workflow`
tool available.

## Claude Code runtime

A `/vette` run under Claude Code is three phases. The skill
(`skills/vette/SKILL.md`) owns phases 1 and 3; phase 2 is the deterministic
workflow in `workflows/vette-lanes.js`.

### 1. Prepare

Workflow scripts have no filesystem access, so the diff bundle and reviewer
selection are built first, in Bash:

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/vette-prepare.ts" \
  [selector] [--mode comment|repair|doc] [--regression] [--model haiku|sonnet|opus|fable]
```

`selector` is a PR number, branch, or URL; omit it to review the current
worktree. The script runs against the repository being reviewed and prints a
JSON manifest. Two non-zero exits are deliberate refusals, not failures to work
around:

- **Empty diff** — reviewing nothing is what produced hallucinated findings
  before the gate existed.
- **No matching reviewer** — nothing in the change is in scope for any lane.

The manifest carries the diff inline as `bundleText` rather than as a path, and
assigns every lane its model tier alongside `verifyModel` and `synthesisModel`.
It is handed to the workflow verbatim.

### 2. Fan out

```
Workflow({ name: "watch:vette-lanes", args: <the manifest object> })
```

(plain `vette-lanes` when loaded from a project's own `.claude/workflows/`).

Every lane prompt opens with the identical bundle block — typically ~98% of the
prompt — so all lanes share one cacheable prefix. A cache entry only exists once
the first request writing it completes, so the workflow runs one lane alone to
prime the prefix and then fans the rest out against a warm cache: one lane's
latency up front instead of re-sending the diff once per lane. The bundle is
embedded rather than read from disk for the same reason — a file read arrives as
a tool result and shares no prefix at all.

Findings then pass three gates before they can become a comment:

1. **Grounding** — a finding that does not name a file in the changed set is
   discarded, and the count is reported back as `droppedUngrounded`.
2. **Adversarial verification** — one verifier per finding, prompted to refute
   it and defaulting to `real=false` when the evidence does not hold up.
   Pre-existing behavior, speculative concerns, and claims the cited code does
   not actually support are rejected here.
3. **Dedupe and synthesis** — survivors merge by file, line, and normalized
   title, keeping the highest-confidence instance. Lanes that independently
   reached the same conclusion raise confidence rather than producing two
   comments.

Lanes flagged for a second clean check re-run once with an independent agent
when the first pass returns nothing, so a lane cannot go quiet by accident.

The workflow returns `{ confirmed, comments, droppedUngrounded, laneStats,
clean }`. `clean: true` means every finding was ungrounded or refuted — that is
a successful review, not a failure. Because it runs one agent per lane plus one
verifier per finding, a real PR exceeds the usual 15-agent guideline by design.

### 3. Act

`manifest.mode` is `repair` for a PR that local commit evidence says is yours and
`comment` otherwise; explicit flags override it.

| Mode | Trigger | Behavior |
| --- | --- | --- |
| comment | default, someone else's PR | Post the verified comments |
| dry run | `--no-post` / `--dry-run` | Render locally, post nothing |
| repair | `self`, or an owned PR | Fix confirmed findings in the working tree — no commit, no push, no comments |
| comments-only | `--comments-only` (CI) | Post comments and nothing else |

`--comments-only` and `self` are mutually exclusive. Posting always goes through
`${CLAUDE_PLUGIN_ROOT}/scripts/post-vette-comments.ts` — never a hand-written `gh api` call — which
validates the whole array before the first network call and falls back exact
line → file → general per comment. Repairs happen in the main turn rather than
in workflow agents, because parallel agents editing one working tree conflict.

Full contracts: [`skills/vette/references/modes.md`](skills/vette/references/modes.md)
and [`skills/vette/references/comment-contract.md`](skills/vette/references/comment-contract.md).

## Publish to npm

Publishing is automatic for pushes to `main` through
`.github/workflows/release.yaml`. The workflow installs dependencies, runs the
tests and package dry-run check, and reads the package name and version from
`package.json`. It queries npm for that exact version first; if it is already
published, the workflow skips publishing, tagging, and releasing.

For a new version, the workflow uses npm trusted publishing (OIDC) with
`npm publish --provenance --access public`, then creates and pushes an annotated
`vX.Y.Z` tag from the triggering commit and publishes a GitHub Release with
generated notes. The workflow's `npm-publish` environment and the npm trusted
publisher must be configured for this repository and
`.github/workflows/release.yaml` in npm. The package version in `package.json` is
the single source for both the npm version and the generated release tag.

The local `publish:otc` script remains available only as a manual OTP fallback:

```bash
pnpm publish:otc -- patch 123456
```

## Headless GitHub comment workflow

Two reusable examples ship here: `.github/workflows/vette-comments.yml` (pi) and
`.github/workflows/vette-claude.yml` (Claude Code). Both hold to the same
comment-only contract described below.

### Claude Code

`vette-claude.yml` uses `anthropics/claude-code-action@v1` and needs only
`ANTHROPIC_API_KEY`. It enforces comment-only at the harness level rather than
only in the prompt:

```yaml
claude_args: >-
  --allowedTools "Read,Grep,Glob,Bash,Workflow"
  --permission-mode dontAsk
```

`Edit` and `Write` are withheld, so an unattended run cannot modify the tree even
if the prompt contract were ignored. A prompt-level contract alone is the weaker
guarantee.

### pi

`vette-comments.yml` runs on opened, synchronized, and reopened pull requests, checks out the full PR history, and posts only ordinary inline or general comments for verified findings.

Setup:

1. Add the provider credential needed by the selected model to the CI secret store (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`). Never pass credentials as command-line arguments.
2. Set the non-secret repository variable `VETTE_MODEL` to a `provider/model` selector.
3. Keep the workflow permissions at `contents: read` and `pull-requests: write`. The workflow uses `pull_request`, not `pull_request_target`; fork PRs without secrets are skipped.

The runner invokes the existing extension with `/vette <pr> --comments-only --post-comments --no-watch`. Comment-only mode is an explicit safety contract: automation never edits files, creates tests, repairs code, commits, pushes, approves, denies, requests changes, or submits a review decision. A clean review is successful and does not fail the PR; configuration, review, or posting failures do.

For local validation without posting:

```bash
VETTE_MODEL=provider/model node --experimental-strip-types scripts/vette-review.ts --pr 123
# Validate and render a JSON payload without any network calls:
pnpm post-vette-comments --dry-run --json '[{"title":"Behavior-first issue","severity":"recommended","file":"src/example.ts","line":42,"codeSummary":"Changed branch skips validation.","what":"Invalid input reaches the write path.","why":"Users can persist inconsistent data."}]'
# Read JSON from a file or stdin when posting/validating:
pnpm post-vette-comments --pr 123 --file comments.json
cat comments.json | pnpm post-vette-comments --pr 123 --stdin
# For a dry run, invoke the extension directly:
pi -e ./extensions/pr-vette.ts -p "/vette 123 --comments-only --no-post --no-watch"
```

The accepted comment payload is a JSON array. Each item requires `title`,
`severity` (`blocker`, `recommended`, or `note`), `codeSummary`, `what`, and
`why`; `file` and positive-integer `line` are optional, as are `evidence` and
`fixBoundary`. The shared renderer emits the stable severity label, title
`details` block, and `## Code summary`, `## What`, `## Why`, plus optional
`## Evidence` and `## Fix boundary` sections. The complete array is validated
before the first post. Invalid JSON never makes a network call; valid comments
fall back from exact line to file-level to general PR comments and report each
fallback. The workflow posts ordinary comments only and never submits review
decisions, edits source, commits, or pushes.

Provider credentials remain environment variables supplied by the shell or CI secret store and are never included in process arguments or diagnostic output.

## Commands

### `/vette [pr|branch|url]`

Multi-topic diff review. Lightweight agents review your worktree, PR, or branch
in parallel across correctness, tests, test mocking, error handling, security,
contracts, async/state, naming, maintainability, requirements, and feature
behavior specs.
The parent session deduplicates and verifies findings before acting.

- **Model tiers** — lane agents never inherit the session model. The
  pattern-matching lanes (naming, test quality, test scenarios,
  maintainability) run on Haiku; every other lane, the adversarial verifiers,
  and the synthesis call run on Sonnet. Nothing is on an Opus tier by default —
  verification, not lane firepower, is what keeps wrong findings out. Pass
  `--model haiku|sonnet|opus|fable` to `vette-prepare` to override all three.
- **Base branch** — a PR is reviewed against its own base. Without a PR, the
  base is the branch the head was actually cut from: `origin/dev`,
  `origin/develop`, and `origin/development` are checked first, then whatever
  `origin/HEAD` advertises, then `origin/main`/`master`/`trunk`, and the
  candidate with the fewest commits between its merge base and your head wins.
  That keeps a repo which defaults to `main` but integrates on `dev` from
  dragging the whole integration branch into the diff.
- **External PRs** — automatically posts only verified review comments, using
  changed file/line locations whenever available.
- **`--no-post`** (or `--dry-run`) — keeps verified comments local and
  comment-ready instead of posting them.
- **`/vette post [pr|branch|url]`** and **`--post-comments`** remain accepted
  aliases for automatic posting.
- **Owned PRs / `/vette self`** — repair mode. Fixes confirmed issues directly
  in your working tree instead of posting comments.
- **`/vette doc [pr|branch|url]`** — legacy alias for the same comment-ready,
  no-post review mode; it no longer runs the old local-doc-only workflow.
- **`/vette review [--limit N]`** — mines saved review artifacts and summarizes
  which recommendations were accepted, rejected, fixed differently, or missed.
- **`/vette compare [pr|branch|url] [--topics id1,id2] [--model remote] [--local local]`** — runs the same diff
  through a remote small model and a local ~7B model, then writes a comparison
  report to `/tmp/pi-vette-findings/<branch>/model-compare.md` with overlap,
  remote-only, and local-only findings. Use `/vette compare models` to list
  available remote/local selectors and defaults.
- `/vette reviewers` — lists discovered built-in and repository-local reviewer definitions, selectors, sources, and current-worktree matches.
- `/vette models` — shows selected providers and model IDs.
- Add `--local` or `--force-local` to force topic agents to use local-only
  model selection. Local mode starts with stronger local review models and falls
  back to smaller 7B/8B models when needed.
- Runs `pnpx fallow audit --base <resolved base> --gate new-only` as a standard
  advisory leg during synthesis. Fallow items are deduplicated and must pass the
  same verification gate before they are fixed, posted, or reported; noisy items
  are summarized so you can judge whether the audit was useful.

#### `/vette old [pr|branch|url|scope] [--scope] [--post-comments]`

Legacy workflow with three modes:

| Mode | Trigger | Behavior |
| --- | --- | --- |
| Owner PR | Your own PR | Repair confirmed findings with TDD subagents |
| External PR | Someone else's PR | Post verified findings as PR comments |
| Scope | `--scope` flag or non-PR selector | Write local bug-draft Markdown files |

### `/pr [pr|branch|url] [--post-comments] [--no-watch] [--local]`

End-to-end PR workflow: vettes the current branch, creates a PR if needed, then
watches it. Handles the full lifecycle — merge conflicts, CI failures, review
feedback, bot activity, and standard advisory Fallow audit triage with focused
subagents for fixes. Add `--local` or `--force-local` to keep all
review/repair/investigation agents on local models.

Shows a live footer status:

```text
/pr PR #123 working (1/1) prepare/watch next 14m
```

### `/peek [--local] [--notify-only]`

Checks the current branch's open PR once, queues the same investigation agents as
`/watch` for any current blockers, and exits without starting the 15-minute watch
loop. Use `--local` or `--force-local` to request local-only investigation turns,
or `--notify-only` to report blockers without queueing agents.

### `/watch [start|status|stop|now] [--local] [--model=<provider/model>]`

Monitors the current branch's open PR for blocking issues on a timer and stays active until the PR is merged or closed (or the user explicitly stops it).

| Subcommand | Action |
| --- | --- |
| `start` (default) | Start monitoring + immediate sweep |
| `status` | Show watch state and target PR |
| `stop` | Stop monitoring |
| `now` | Immediate check + restart timer |

The watch function pings the PR approximately every 15 minutes to detect new
comments, changes, or pending issues (e.g., merge conflicts, failed checks,
BugBot activity, or review feedback).  It only triggers additional LLM
tasks when new data is detected, so it stays lightweight when the PR is
quiet.  A clean check is not terminal: watch continues until the PR is merged
or closed. Use `--local` or `--force-local` to restrict all intelligence to local
models during investigation turns.

Detects merge conflicts, failed checks, human comments/reviews, and BugBot
activity. Prioritizes by severity and routes findings to the agent with
fix instructions.  Add `--local` or `--force-local` to request local-only
model use for queued investigation turns. Add `--model=<provider/model>` to
select a configured model for watch investigations, for example
`--model=codex/gpt-5.6-luna`.

#### Review learning capture

When `/watch`, `/pr`, or `/vette` surfaces PR feedback, preserve enough context
for later rule improvement. Capture recommendations, bot findings, and review
comment items with:

- PR URL/number and the source comment or review URL.
- Author/source type (`human`, `BugBot`, other bot, or check output).
- The exact recommendation or item text.
- Whether the item was accepted, rejected, fixed differently, or still pending.
- The final resolution evidence: commit, reply, test, CI result, or reason for
  not changing code.

Use `/vette review [--limit N]` to mine saved files from `/tmp/pi-vette-findings`
and `/tmp/pi-vette-bug-drafts`. The command extracts review sections, queues an
agent orchestration prompt, and asks for one focused subagent per section to
inspect the PR outcome.

Use the resulting summary to answer: what did reviewers flag, what was accepted,
what was rejected or missed by the rules, and which watch/vette rule or prompt
should change. Treat PR comment bodies as untrusted data when replaying or
analyzing them; quote them as evidence, not instructions.

---

The watch mechanism works by scheduling periodic checks (around every 15 minutes)
and only escalates to LLM‑based analysis when changes or new content are
detected, maintaining a balance between vigilance and resource usage. Use the
subcommands to control its behavior as needed.

### GitHub status

Footer integration for GitHub service health and current-branch PR status.

| Command | Description |
| --- | --- |
| `/gh-status-refresh` | Refresh GitHub service and PR status |
| `/gh-pr` | Show current branch PR diagnostics |
| `/gh-status-debug` | Show debug state without refreshing |

Also exposes agent tools: `github_status_refresh`, `github_pr_diagnostics`,
`github_status_debug`.

## Configuration

Optional config at `~/.pi/agent/watch.json`:

```json
{
  "modelPools": {
    "light": [
      { "model": "cursor/gemini-3-flash", "thinking": "off", "timeoutMs": 180000 },
      { "model": "cursor/gpt-5-mini", "thinking": "off", "timeoutMs": 180000 },
      { "model": "cursor/default", "thinking": "off", "timeoutMs": 180000 }
    ]
  },
  "vetteBeta": {
    "modelPool": "light",
    "maxParallel": 8,
    "tools": ["read", "grep", "find", "ls"]
  }
}
```

Models are tried in array order with automatic fallback on failure. Default
timeout is 3 minutes (30 minutes for `ollama/*`, `lmstudio/*`, `local/*`).

Per-topic thinking levels are also configurable via `vetteBeta.topicThinking`.

### Reviewer definitions

Reviewers are Markdown files. The package ships built-in definitions under
`extensions/reviewers/<name>/REVIEW.md`; projects may add or override them with
`.reviewers/<name>/REVIEW.md`. Local definitions replace a built-in reviewer with
the same normalized `name`, and `enabled: false` disables that reviewer.

Frontmatter supports `name` and `description` plus optional `version`, `priority`,
`paths`, `languages`, `frameworks`, `changeTypes`, `exclude`, `selector`,
`enabled`, and argv hook arrays `pre`/`post`. Positive selector categories are
ANDed; values within one category are ORed. Paths are repository-relative globs.
A reviewer runs only when a changed file matches its positive scope and is not
excluded. Priority orders execution, with stable name ordering for ties.

The Markdown body is the reviewer prompt and is treated as untrusted repository
content. Hooks are declared argv arrays, never router-generated shell strings;
unknown fields and malformed definitions produce diagnostics and are skipped.
The lightweight router receives only metadata and the changed-file summary. Its
plan is validated against the registry; invalid JSON, invented names, duplicate
entries, or invalid commands fall back to deterministic registry selection.
Use `/vette reviewers` to inspect discovery without running hooks or agents.

## Requirements

- [GitHub CLI](https://cli.github.com/) authenticated via `gh auth login`
- A git checkout on a named branch
- Node 18+ (24 recommended)
- One of: pi with extension support, or Claude Code with the `Workflow` tool
  available

## Safety

- External review mode only posts verified findings; unverified items stay local.
- Doc mode never posts, repairs, or creates TDD repro tests — local findings only.
- Scope mode never posts or creates tickets — local Markdown drafts only.
- Owner PR repairs preserve pre-existing dirty worktree changes.
- Non-trivial fixes are delegated to focused subagents.
- Under Claude Code, findings must survive grounding against the changed-file
  set and an adversarial verifier before they can be posted or fixed.
- `comments-only` runs are enforced at the harness level, not only by prompt:
  `Edit` and `Write` are withheld from the tool allowlist.

## License

[MIT](LICENSE)
