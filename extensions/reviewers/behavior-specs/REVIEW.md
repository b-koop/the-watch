---
name: behavior-specs
version: 1
description: Detect drift between behavior specifications and changed code.
priority: 35
paths: ["**/*.feature", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---
# Review instructions

Detect behavior-spec drift only: compare matching Gherkin/feature-file scenarios against the diff and changed-code behavior; report behavior that violates scenarios, missing scenario coverage for changed behavior, or ambiguous spec matches that need review.
