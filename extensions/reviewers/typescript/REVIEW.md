---
name: typescript
version: 1
description: Review TypeScript type boundaries, async boundaries, and module contracts.
priority: 30
paths: ["**/*.ts", "**/*.tsx"]
languages: [typescript]
exclude: ["**/*.d.ts"]
---
# Review instructions

Focus on type unsoundness, public and async boundaries, narrowing, module exports, and errors hidden by TypeScript configuration.
