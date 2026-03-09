# Agent Instruction Source of Truth

These files are the canonical shared instructions for:

- `AGENTS.md`
- `CLAUDE.md`
- `.codex/skills/agentbigbrain/SKILL.md`
- `.cursor/rules/agentbigbrain.mdc`

Those tool-specific files should stay thin and point here. Update the shared guidance in this
folder, not in the wrappers.

Apply these sections in order:

1. `docs/agent-instructions/project-overview.md`
2. `docs/agent-instructions/getting-started.md`
3. `docs/agent-instructions/ai-first-maintainability.md`
4. `docs/agent-instructions/architecture-boundaries.md`
5. `docs/agent-instructions/deterministic-safety-rules.md`
6. `docs/agent-instructions/user-experience-and-capability-principles.md`
7. `docs/agent-instructions/operational-gates.md`
8. `docs/agent-instructions/documentation-rules.md`
9. `docs/agent-instructions/versioning-rules.md`
10. `docs/agent-instructions/commit-rules.md`
11. `docs/agent-instructions/testing-rules.md`
12. `docs/agent-instructions/integrity-rules.md`
13. `docs/agent-instructions/definition-of-done.md`

Tool-specific wrappers may keep only the minimum front matter or title required by that tool.
