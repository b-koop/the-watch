# Comment payload contract

`${CLAUDE_PLUGIN_ROOT}/scripts/post-vette-comments.ts` validates the **entire** array before it makes
the first network call. One malformed item means nothing is posted. Unknown
fields are rejected outright, so do not invent any.

## Schema

Root must be a JSON array. Each item:

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | Behavior-first. Do not restate the severity in it. |
| `severity` | yes | `blocker` \| `recommended` \| `note` |
| `codeSummary` | yes | What the changed code does. |
| `what` | yes | The incorrect behavior. |
| `why` | yes | The user or business impact. |
| `file` | no | Path from the changed-file set. Required if `line` is set. |
| `line` | no | Positive integer. Omit entirely rather than sending `0`. |
| `evidence` | no | Verification detail, command output, long logs. |
| `testCode` | no | Complete source of a regression test, if one was written. |
| `fixBoundary` | no | The smallest intended change. |

## Rendering

The shared renderer owns all formatting. It emits a stable severity label
(🔴 **Blocker**, 🟡 **Recommended**, 🔵 **Note**), a `<details>` block with the
title as its summary, then `## Code summary`, `## What`, `## Why`, and the
optional `## Evidence`, `## Regression test`, `## Fix boundary` sections.

Consequences for you:

- Never hand-write this Markdown. Emit JSON and let the renderer produce it.
- Put long logs in `evidence`, not in `what` or `why`.
- Put test source in `testCode`, never inline in `evidence` — only `testCode`
  gets the fenced `## Regression test` section.

## Placement

Each comment is placed by falling back in order, and every fallback is recorded:

- `file` + `line` → inline line comment → file-level → general PR comment
- `file` only → file-level → general
- neither → general

Prefer anchoring each finding to its specific file so reviewers can resolve them
independently. Group findings into one general comment only when they genuinely
cannot be tied to a changed file.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | all comments posted (or validated, under `--dry-run`) |
| 2 | invalid arguments |
| 3 | invalid comment payload — nothing was posted |
| 4 | PR metadata lookup failed |
| 5 | one or more comments failed to post |

A non-zero exit is a real failure. Report it; do not retry by switching to a
different posting method.
