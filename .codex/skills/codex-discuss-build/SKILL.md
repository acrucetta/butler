---
name: codex-discuss-build
description: Use when a task is non-trivial and should follow a discuss-first workflow.
---

# codex-discuss-build

Use this skill when a task is non-trivial and should follow a discuss-first workflow.

## Goal
Avoid premature edits. Produce options first, then implement the selected option in verified increments.

## Workflow
1. Restate the task and constraints in one short paragraph.
2. Present 2-3 options with tradeoffs and blast radius.
3. Wait for explicit user selection before editing.
4. Implement in small steps.
5. After each step, run the minimal relevant verification command(s) and report outcomes.
6. Update `docs/*.md` when behavior or decisions change.

## Guardrails
- Do not make broad rewrites when a narrow diff works.
- Prefer existing patterns and utilities in the repo.
- If blocked by ambiguity, ask one focused question with concrete options.
