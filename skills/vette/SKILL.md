---
name: vette
description: Review a pull request or branch diff for defects. Fans out per-topic reviewer lanes (correctness, security, async/state, contracts, error handling, tests, requirements, naming) over the changed files only, verifies every finding against real code, and posts the survivors as inline GitHub comments. Use for "vette this PR", "review PR 123", "review my branch", or a diff-scoped code review. Not for whole-codebase risk sweeps.
argument-hint: "[pr|branch|url] [--no-post] [--comments-only] [self]"
allowed-tools: Read, Grep, Glob, Bash, Workflow, Edit, Write
---

# Vette

Diff-scoped pull request review. The review itself runs as a deterministic
workflow; this skill resolves the target, launches it, and acts on the result.

**Scope discipline:** review only what the diff changed. A finding that does not
name a changed file is discarded before it ever reaches you.

## Phase 1 — Prepare

Workflow scripts have no filesystem access, so the diff bundle and reviewer
selection are built first, in Bash:

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/vette-prepare.ts" [selector] [--mode comment|repair|doc] [--regression] [--model haiku|sonnet|opus|fable]
```

`${CLAUDE_PLUGIN_ROOT}` resolves to this plugin's directory, so the command works
from any repository. If it is unset you are running from a checkout of the repo
itself — use `scripts/vette-prepare.ts` directly. Run it from the repository
being reviewed; it reads that repo's git state, not the plugin's.

`selector` is a PR number, branch, or URL. Omit it to review the current
worktree. The script prints a JSON manifest and exits non-zero if there is
nothing to review.

The manifest carries the diff inline as `bundleText`, not just a path. Every lane
prompt opens with that same block verbatim, so the lanes share one cacheable
prefix — typically ~98% of each prompt — and the diff is billed at full rate once
instead of once per lane. Pass the manifest straight through; do not trim
`bundleText` out of it, and do not rewrite lane prompts to read the bundle from
disk (a file read arrives as a tool result and shares no prefix).

The manifest also assigns each lane a model tier, and carries `verifyModel` and
`synthesisModel` for the other two stages. Nothing inherits the session model:
the fan-out is where a run's tokens go, and an Opus session would bill every
lane at 5x Haiku's rate for work that does not need it. All lanes default to `haiku` for lower-cost execution, and `--model <tier>` overrides
all three when a run needs more firepower. Pass explicit manifest tiers through as
they come; do not substitute your own.

Two failures are deliberate and must **not** be worked around:

- **Empty diff** — it refuses rather than review nothing. Reviewing an empty
  diff is what produced hallucinated findings before the gate existed.
- **No matching reviewer** — nothing in the change is in scope for any lane.

Report either plainly and stop.

## Phase 2 — Run the workflow

Pass the manifest through verbatim:

```
Workflow({ name: "watch:vette-lanes", args: <the parsed manifest object> })
```

Pass `args` as a real JSON object, not a stringified one.

The workflow's registered name depends on how this is installed: `watch:vette-lanes`
when installed as a plugin, plain `vette-lanes` when loaded from a project's own
`.claude/workflows/`. Try the namespaced name first and fall back to the bare one
if it does not resolve.

It runs one lane on its own first to write the shared prefix into cache, then
fans the remaining lanes out against it. That trades one lane's latency for a
large drop in billed input.

It returns `{ confirmed, comments, droppedUngrounded, laneStats, clean }`.
`comments` is already shaped for the posting boundary. `clean: true` means every
finding was either ungrounded or refuted during verification — that is a
successful review, not a failure.

The workflow runs one agent per lane plus one verifier per finding, so a real PR
will exceed the usual 15-agent guideline. That is deliberate: lane coverage is
the point, and each verifier is what keeps plausible-but-wrong findings out.

## Phase 3 — Act

The mode comes from the manifest. `manifest.mode` is `repair` when the PR is
yours (inferred from local commit evidence) and `comment` otherwise; explicit
flags override it.

| Mode | Trigger | What you do |
| --- | --- | --- |
| **comment** | default, someone else's PR | Post the verified comments. |
| **dry run** | `--no-post` / `--dry-run` | Render locally, post nothing. |
| **repair** | `self`, or an owned PR | Fix the confirmed findings in the working tree. |
| **comments-only** | `--comments-only` (CI) | Post comments and nothing else. |

See [references/modes.md](references/modes.md) for the contract each mode must
hold to, and [references/comment-contract.md](references/comment-contract.md)
for the comment payload schema.

### Posting

The poster is the only sanctioned path to GitHub. It validates the entire array
before the first network call, then falls back exact line → file → general
placement per comment:

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/post-vette-comments.ts" --pr <n> --stdin <<'JSON'
[ ...the comments array... ]
JSON
```

Never call `gh api` yourself to post a finding, and never hand-write the
Markdown — the renderer owns formatting.

For a dry run, swap `--pr <n> --stdin` for `--dry-run --stdin`; it renders the
exact Markdown that would be posted and makes no network call.

### Repairing

Apply the smallest change that fixes each confirmed finding, and add or update a
focused test where one is practical. Do not commit, do not push, and do not post
comments in this mode. Report what you fixed and what you could not.

## Reporting

Close with counts: lanes run, findings raised, dropped as ungrounded, refuted
during verification, verified, and posted or fixed. If `droppedUngrounded` is
high relative to findings raised, say so — it means the lanes are drifting off
the diff and the run deserves a second look.
