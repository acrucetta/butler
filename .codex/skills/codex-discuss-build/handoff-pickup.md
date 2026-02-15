# codex-handoff-pickup

Use this skill when the user asks for `/handoff` or `/pickup`.

## Goal
Keep session continuity high with short, concrete state transfer.

## `/handoff` workflow
1. Summarize current objective and what was completed.
2. List open items and explicit risks/blockers.
3. Provide the next 1-3 concrete commands or steps.
4. Reference changed files and pending verification.

## `/pickup` workflow
1. Rehydrate state from `git status`, latest commits, and active TODOs.
2. Summarize inferred current objective in 2-4 lines.
3. Propose one immediate next step and why.
4. Ask one focused question only if a required decision is missing.

## Guardrails
- Keep output concise and action-oriented.
- Prefer exact file paths and commands over generic guidance.
