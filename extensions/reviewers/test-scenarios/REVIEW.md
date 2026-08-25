---
name: test-scenarios
version: 1
description: Find missing regression-catching and edge-case scenarios.
priority: 40
---
# Review instructions

Detect missing regression-catching test scenarios: changed observable behavior with no test that would fail if that behavior regressed, missing edge-case scenario, missing negative-path scenario, missing boundary scenario, or a deleted/disabled test that leaves behavior without equivalent coverage elsewhere. You may call out important pre-existing scenario gaps discovered while reviewing the diff, but mark them as follow-up rather than required for the current change. Do not report test style, weak matcher wording, mocks, snapshots, duplicate tests, or user-event realism; those belong to the test quality lane.
