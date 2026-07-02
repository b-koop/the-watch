# The Watch

Reusable local Pi package that guards pull requests with PR-aware `/vette`,
`/pr`, `/watch`, and GitHub status commands.

## Install or test

From this directory:

```bash
pi -e .
```

Or install as a local package:

```bash
pi install /Users/benjaminkoop/code/pi/the-watch
```

## Commands

### `/vette [pr|branch|url]`

Runs the beta diff review by default: lightweight topic agents review the
current worktree, selected PR, or selected branch, then the parent session
deduplicates candidate findings and verifies actionable items. External PRs post
verified review comments. Owned PRs and `/vette self` run in repair mode: they do
not post or draft review comments as the primary output, and instead fix
confirmed issues directly in the working tree. Launch status and `/vette models`
both state each selected provider connection and model ID, then flag missing
model selectors when Pi can validate them. The result message reports start time,
finish time, elapsed duration, aggregate input/output tokens, and per-topic
attempt metrics when Pi exposes token usage.

`/vette self` vets the current branch against the merge base/current merge point
and fixes confirmed items without requiring a PR selector.

### `/vette old [pr|branch|url|scope] [--scope] [--post-comments]`

Runs the legacy PR/scope workflow. It resolves a GitHub pull request with one
bundled `gh pr view`, infers owner mode from local non-merge commit authors on a
locally available branch, then dispatches the right agent workflow. If no
matching local commit evidence is available, `/vette old` defaults to
external-review mode. If the selector is not a PR number or URL and cannot be
resolved as a PR, `/vette old` treats it as a broader scope such as a service,
module, package, directory, route group, job, or subsystem. Use `--scope` to
force scope mode; `/vette old --scope` audits the current worktree.

- **Owner PR**: repair mode. It does not draft/post comments; it asks the agent
  to run vette/pr-review style investigation and repair confirmed findings with
  TDD-focused subagents.
- **External PR**: review mode. It asks the agent to verify findings locally,
  then post verified items in one final posting pass using stable markdown
  templates. Test-reproducible findings are posted at the most precise target
  available: file/line when possible, file-level when line placement is not
  possible, or a general PR comment as fallback. When a finding can be reproduced
  with a focused unit/regression test, the agent builds the failing repro test
  and includes that test code in the associated templated comment body.
  Name-check comments for test names and identifier/variable naming use GitHub
  `suggest` blocks when a full-line replacement is available, so reviewers can
  apply non-functional naming changes directly from the PR UI.
  Verified-but-untestable items are grouped into one final templated PR comment
  with file/line context wherever possible.
- **Scope bug-discovery mode**: audits the requested scope, validates candidate
  bugs with evidence, builds focused failing repro tests where practical, and
  writes local Markdown bug-ticket drafts under `/tmp/pi-vette-bug-drafts/<scope>/`.
  It does not create tracker tickets, GitHub issues, PR comments, commits, or
  production-code fixes.

All modes require the agent to build suggestions from three read-only lanes in
parallel before acting: `vette`, naming/test-name checks, and
`thermo-nuclear-code-quality-review`. The merged suggestion set keeps lane
provenance such as `[vette]`, `[name-check]`, or `[thermo-nuclear]`.

PR runs also write a local temporary findings artifact under the PR branch name,
for example `/tmp/pi-vette-findings/<branch>/pr-123-findings.md`. Scope runs
write findings and bug-ticket drafts under `/tmp/pi-vette-bug-drafts/<scope>/`.
These artifacts record every candidate finding from every lane, including
verified, rejected, duplicate, out-of-scope, test-reproduced, untestable, and
blocked items, so later runs can reference the full review history.

`/vette beta` remains as a compatibility alias for the default `/vette` beta
review. `/vette beta <pr-or-branch>` and `/vette beta models` behave the same as
`/vette <pr-or-branch>` and `/vette models`.

Default topic roles and thinking levels:

| Section | Thinking | Role |
| --- | --- | --- |
| Correctness | `medium` | Detect behavior regressions only. |
| Tests | `low` | Detect missing assertions and false confidence. |
| Error handling | `medium` | Detect unhandled failure paths. |
| Security/data | `high` | Detect auth, data, and validation risk. |
| Contracts | `medium` | Detect public compatibility changes. |
| Async/state | `high` | Detect race, lifecycle, and stale-state risk. |
| Naming | `off` | Apply deterministic lint/rules only. |
| Maintainability | `medium` | Detect review-worthy complexity, not style. |
| Requirements/Linear | `medium` | Compare Linear requirements against the diff and flag gaps or ambiguity. |
| Feature behavior specs | `medium` | Compare matching Gherkin/feature-file scenarios against changed behavior. |

The requirements lane looks up the branch or PR's Linear issue when available and
includes the ticket context in the review bundle. If no Linear issue can be found,
it reports uncertainty instead of inventing requirements.

The feature behavior specs lane looks for tracked `.feature` and `.feature.md`
files, includes the best lexical matches for the changed files and diff, and asks
the lane to flag scenario drift, missing behavior coverage, or ambiguous matches.
If no feature file matches, it reports uncertainty rather than inventing behavior.

`Security/data` and `Async/state` require two clean lightweight model results before
accepting an empty finding set; if the first model reports no findings, beta runs
the next cheap fallback model to look for possible risks before declaring the
topic clean.

Vette beta reads optional user config from `~/.pi/agent/the-watch.json`:

```json
{
  "modelPools": {
    "light": [
      {
        "model": "cursor/gemini-3-flash",
        "thinking": "off",
        "timeoutMs": 180000
      },
      {
        "model": "cursor/gpt-5-mini",
        "thinking": "off",
        "timeoutMs": 180000
      },
      {
        "model": "cursor/default",
        "thinking": "off",
        "timeoutMs": 180000
      },
      {
        "model": "ollama/ornith:9b",
        "thinking": "off",
        "timeoutMs": 600000
      }
    ]
  },
  "vetteBeta": {
    "modelPool": "light",
    "maxParallel": 8,
    "tools": ["read", "grep", "find", "ls"],
    "topicThinking": {
      "correctness": "medium",
      "tests": "low",
      "error-handling": "medium",
      "security-data": "high",
      "contracts": "medium",
      "async-state": "high",
      "naming": "off",
      "maintainability": "medium",
      "requirements": "medium",
      "behavior-specs": "medium"
    }
  }
}
```

Ordering is array order: each topic tries the first model, falls back to later
models on provider/model/transient failure, and briefly cools down failed
providers/models so later topic agents skip options that are likely down. Models
without explicit `timeoutMs` default to 3 minutes, except local selectors such as
`ollama/*`, `lmstudio/*`, or `local/*`, which default to 10 minutes.

### `/pr [pr|branch|url] [--post-comments] [--no-watch]`

Vettes the current branch, creates a PR when one does not already exist, then
watches the PR. The selector is optional: without a PR number, branch, or URL,
`/pr` first tries the current branch's existing PR; if none is found, it
prepares the current branch for PR creation.

- validates the working branch and target base before creating or checking a PR,
- runs parallel vette, name-check, and thermo-nuclear suggestion lanes before PR
  creation when needed,
- fixes confirmed owner-side branch issues with focused TDD/code subagents before
  creating the PR,
- creates the PR with `gh pr create` when no existing PR was resolved,
- validates target branch, title, body, and PR template expectations,
- runs the same PR-aware `/vette` behavior internally, including automatic
  posting of verified external-PR findings after a PR exists,
- resolves related merge conflicts,
- monitors the shared PR snapshot for checks, comments, bot feedback, review
  state, PR merge state, and branch changes,
- closes the watch item immediately when the PR reaches the merged state,
- fixes related failures with focused TDD/code subagents,
- retries unrelated flaky CI once when safe,
- performs one immediate PR snapshot refresh, then reports visible status and
  15-minute watch timing while working.

The extension also publishes a footer status such as:

```text
/pr PR #123 working (1/1) prepare/watch next 14m
```

When the agent finishes, the status returns to idle. If the PR is already merged
or the watch run ends with a merged-state report, the footer shows the PR as
merged instead.

### `/watch [start|status|stop|now]`

Monitors the current branch's open GitHub PR for blocking issues and queues one
investigation turn when new work appears. The subcommand autocompletes after
`/watch`.

- `/watch` or `/watch start` starts monitoring, performs an immediate sweep of
  current blockers, then checks on a timer.
- `/watch status` shows whether watch mode is running and which PR it is
  monitoring.
- `/watch stop` stops monitoring and clears the watch footer status.
- `/watch now` runs an immediate check and restarts the wait for the next
  automatic check.
Watch mode detects merge conflicts, failed checks, human comments/reviews, and
BugBot activity. It prioritizes merge conflicts, human feedback, pipeline
failures, then BugBot items. New findings are recorded in the session and routed
to the agent with TDD-focused fix instructions.

### GitHub status commands and tools

The package also shows GitHub service health and current-branch PR status in the
footer and exposes the migrated GitHub status commands:

- `/gh-status-refresh` refreshes GitHub service and PR status.
- `/gh-pr` shows current branch PR diagnostics.
- `/gh-status-debug` shows debug status without forcing a refresh.

Assistant tools exposed by the package:

- `github_status_refresh`
- `github_pr_diagnostics`
- `github_status_debug`

## Requirements

- GitHub CLI (`gh`) authenticated with `gh auth login` for PR modes.
- Run inside a git checkout on a named branch. `/pr` can create a PR for the
  current branch when no existing PR is found. `/vette` can review an existing PR
  or audit a broader scope for local bug-ticket drafts.
- Pi with extension support.

## Safety defaults

- `/vette` external-review mode automatically posts only verified findings to the
  PR after verification and cleanup are complete; unverified suggestions are
  recorded in the local findings artifact but not posted.
- `/vette` scope mode never posts or creates tracker tickets; it writes local bug
  draft Markdown files only.
- Owner PR repairs protect pre-existing dirty worktree changes.
- Focused subagents are required for non-trivial TDD, CI, review, and
  merge-conflict work.
