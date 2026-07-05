# The Watch

Pi package that guards pull requests with PR-aware `/vette`, `/pr`, `/watch`,
and GitHub status commands.

## Install

```bash
pi install npm:the-watch
```

Or for local development:

```bash
pi -e .
```

## Commands

### `/vette [pr|branch|url]`

Multi-topic diff review. Lightweight agents review your worktree, PR, or branch
in parallel across correctness, tests, error handling, security, contracts,
async/state, naming, maintainability, requirements, and feature behavior specs.
The parent session deduplicates and verifies findings before acting.

- **External PRs** — posts verified review comments to the PR.
- **Owned PRs / `/vette self`** — repair mode. Fixes confirmed issues directly
  in your working tree instead of posting comments.
- **`/vette doc [pr|branch|url]`** — local findings mode. Outputs findings and
  action items locally only; it does not post PR comments, create TDD repro
  tests, or repair code.
- `/vette models` — shows selected providers and model IDs.
- Add `--local` or `--force-local` to force topic agents to use local-only
  model selection. Local mode starts with stronger local review models and falls
  back to smaller 7B/8B models when needed.

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
feedback, and bot activity — with focused subagents for fixes. Add `--local` or
`--force-local` to keep all review/repair/investigation agents on local models.

Shows a live footer status:

```
/pr PR #123 working (1/1) prepare/watch next 14m
```

### `/watch [start|status|stop|now] [--local]`

Monitors the current branch's open PR for blocking issues on a timer.

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
quiet.  Use `--local` or `--force-local` to restrict all intelligence to
local models during investigation turns.

Detects merge conflicts, failed checks, human comments/reviews, and BugBot
activity. Prioritizes by severity and routes findings to the agent with
fix instructions.  Add `--local` or `--force-local` to request local-only
model use for queued investigation turns.

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

Optional config at `~/.pi/agent/the-watch.json`:

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

## Requirements

- [GitHub CLI](https://cli.github.com/) authenticated via `gh auth login`
- A git checkout on a named branch
- Pi with extension support

## Safety

- External review mode only posts verified findings; unverified items stay local.
- Doc mode never posts, repairs, or creates TDD repro tests — local findings only.
- Scope mode never posts or creates tickets — local Markdown drafts only.
- Owner PR repairs preserve pre-existing dirty worktree changes.
- Non-trivial fixes are delegated to focused subagents.

## License

[MIT](LICENSE)
