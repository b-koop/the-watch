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

### `/vette [pr|branch|url|scope] [--scope] [--post-comments]`

Resolves a GitHub pull request with one bundled `gh pr view`, infers owner mode
from local non-merge commit authors on a locally available branch, then
dispatches the right agent workflow. If no matching local commit evidence is
available, `/vette` defaults to external-review mode. If the selector is not a
PR number or URL and cannot be resolved as a PR, `/vette` treats it as a broader
scope such as a service, module, package,
directory, route group, job, or subsystem. Use `--scope` to force scope mode;
`/vette --scope` audits the current worktree.

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
