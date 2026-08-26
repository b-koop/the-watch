# Mode contracts

All modes run the same review. They differ only in what happens to the verified
findings afterwards.

## comment (default)

Someone else's PR. Post the verified comments through
`${CLAUDE_PLUGIN_ROOT}/scripts/post-vette-comments.ts` and report the counts.

Do not edit source, commit, push, or submit a review decision. Ordinary
inline/general comments only — a review decision (approve / request changes) is
never vette's call.

## dry run — `--no-post` / `--dry-run`

Same review, no network write. Run the poster with `--dry-run --stdin` to render
exactly what would have been posted, and present that.

Useful for checking lane quality before letting it comment on a real PR.

## repair — `self`, or an owned PR

Your own PR, inferred from local commit evidence. Fix the confirmed findings
directly in the working tree:

- Apply the smallest change that fixes each finding.
- Add or update a focused test where one is practical.
- **Do not commit. Do not push. Do not post comments.**
- Report what you fixed, and anything you could not fix and why.

Repairs happen in your own turn, not in workflow agents — parallel agents
editing one working tree conflict with each other.

`--comments-only` and `self` are mutually exclusive. If both are given, stop and
say so rather than guessing which one was meant.

## comments-only — CI

Non-negotiable safety contract for unattended runs. This mode may post ordinary
inline or general PR comments and do nothing else. It must never:

- edit source files
- create or modify tests
- commit or push
- approve, request changes, or submit any review decision

A clean review is a success. Exit 0 and post nothing. Only a configuration,
review, or posting failure should fail the job.

In CI this is enforced at the harness level too, via `--permission-mode dontAsk`
plus an explicit tool allowlist — the prompt contract alone is the weaker
guarantee, so do not rely on it by itself.
