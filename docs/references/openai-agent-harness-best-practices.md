# OpenAI Agent Harness Best Practices

Updated: 2026-02-13

## Sources
- OpenAI Engineering article: https://openai.com/index/harness-engineering-leveraging-codex-in-an-agent-first-world/
- Codex guide (project instructions and AGENTS discovery): https://developers.openai.com/codex/guides/agentic-coding
- Codex guide (non-interactive mode and automation): https://developers.openai.com/codex/guides/non-interactive-mode
- Codex guide (skills): https://developers.openai.com/codex/guides/skills

## Extracted Practices
- Keep `AGENTS.md` concise and map-like; move durable detail into versioned docs.
- Treat plans as first-class repo artifacts with active/completed lifecycle.
- Enforce critical invariants mechanically (checks/lints) instead of relying on memory.
- Make verification explicit and scriptable for autonomous runs.
- Prefer progressive disclosure: small entry points that link to deeper docs.

## Repo Mapping
- `AGENTS.md` is now the entry map for agent context.
- `docs/exec-plans/` captures execution plans and outcomes.
- `bin/check-agent-harness.mjs` enforces structural harness requirements.
- `.agents/skills/spec-driven-execution/SKILL.md` codifies repeatable agent behavior.
