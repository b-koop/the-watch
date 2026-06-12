# Pi PR/Vette Commands

Reusable local Pi package that adds PR-aware `/vette` and `/pr` commands.

## Install or test

From this directory:

```bash
pi -e .
```

Or install as a local package:

```bash
pi install /Users/benjaminkoop/code/pi/pr-review
```

## Commands

### `/vette [pr|branch|url] [--post-comments]`

Resolves a GitHub pull request with `gh pr view`, compares the PR author to the authenticated `gh api user --jq .login`, then dispatches the right agent workflow:

- **Owner PR**: repair mode. It does not draft/post comments; it asks the agent to run vette/pr-review style investigation and repair confirmed findings with TDD-focused subagents.
- **External PR**: review mode. It asks the agent to verify findings locally, then post verified items in one final posting pass using stable markdown templates. Test-reproducible findings are posted at the most precise target available: file/line when possible, file-level when line placement is not possible, or a general PR comment as fallback. When a finding can be reproduced with a focused unit/regression test, the agent builds the failing repro test and includes that test code in the associated templated comment body. Verified-but-untestable items are grouped into one final templated PR comment with file/line context wherever possible.

Both modes require the agent to build suggestions from three read-only lanes in parallel before acting: `vette`, naming/test-name checks, and `thermo-nuclear-code-quality-review`. The merged suggestion set keeps lane provenance such as `[vette]`, `[name-check]`, or `[thermo-nuclear]`.

Each run also writes a local temporary findings artifact under the PR branch name, for example `/tmp/pi-vette-findings/<branch>/pr-123-findings.md`. The artifact records every candidate finding from every lane, including verified, rejected, duplicate, out-of-scope, test-reproduced, untestable, and blocked items, so later runs can reference the full review history.

### `/pr [pr|branch|url] [--post-comments] [--no-watch]`

Prepares and babysits a PR:

- validates target branch, title, body, and PR template expectations,
- runs parallel vette, name-check, and thermo-nuclear suggestion lanes,
- runs the same PR-aware `/vette` behavior internally, including automatic posting of verified external-PR findings,
- resolves related merge conflicts,
- monitors `gh pr checks`, comments, bot feedback, review state, and branch changes,
- fixes related failures with focused TDD/code subagents,
- retries unrelated flaky CI once when safe,
- reports visible status and 15-minute watch timing while working.

The extension also publishes a footer status such as:

```text
/pr PR #123 working (1/1) prepare/watch next 14m
```

When the agent finishes, the status returns to idle.

## Requirements

- GitHub CLI (`gh`) authenticated with `gh auth login`.
- Run inside a git checkout with a PR, or pass a PR number/branch/URL.
- Pi with extension support.

## Safety defaults

- `/vette` external-review mode automatically posts only verified findings to the PR after verification and cleanup are complete; unverified suggestions are recorded in the local findings artifact but not posted.
- Owner PR repairs protect pre-existing dirty worktree changes.
- Focused subagents are required for non-trivial TDD, CI, review, and merge-conflict work.
