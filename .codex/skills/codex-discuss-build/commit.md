# codex-commit

Use this skill when the user asks to commit task changes.

## Goal
Create atomic, path-scoped commits that include only files relevant to the task.

## Workflow
1. Inspect current changes with `git status` and `git diff --name-only`.
2. Confirm the exact files touched by this task.
3. Commit with explicit path arguments.
4. Report commit hash, message, and file list.

## Command patterns
Tracked files:

```bash
git commit -m "fix(scope): message" -- path/to/file1 path/to/file2
```

If new files are involved:

```bash
git restore --staged :/
git add "path/to/file1" "path/to/file2"
git commit -m "feat(scope): message" -- path/to/file1 path/to/file2
```

## Guardrails
- Never use `git add .` for this workflow.
- Do not amend or rebase unless the user explicitly asks.
- Do not commit unrelated local changes.
