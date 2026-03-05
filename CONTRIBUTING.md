# Contributing to AgentBigBrain

Thank you for your interest in contributing! This guide will help you get started.

> **⚠️ Security issues:** Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md) for private reporting channels.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Development Environment](#development-environment)
- [Project Structure](#project-structure)
- [Branching & Commits](#branching--commits)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [AI-Assisted Development](#ai-assisted-development)

---

## Quick Start

```bash
git clone https://github.com/AgentBigBrain/AgentBigBrain.git
cd AgentBigBrain
npm install
npm run build
npm test
npm run check:docs
```

All three checks must pass before submitting a PR.

---

## Development Environment

### Prerequisites

- **Node.js** with `node:sqlite` and global `fetch` support
- **npm** (this project uses `package-lock.json`)

### Running the Agent

```bash
# Single governed task
npm run dev -- "summarize current repo status"

# Bounded autonomous loop
npm run dev -- --autonomous "stabilize runtime wiring"

# Telegram/Discord interface
npm run dev:interface

# Federation server (requires env config — see README)
npm run dev:federation
```

---

## Project Structure

Tests mirror the `src/` directory structure:

```
src/
├── core/           → tests/core/
├── governors/      → tests/governors/
├── organs/         → tests/organs/
├── models/         → tests/models/
├── interfaces/     → tests/interfaces/
└── tools/          → tests/tools/
```

For detailed architecture, see [ARCHITECTURE.md](docs/ARCHITECTURE.md) and the architecture section of the [README](README.md).

---

## Branching & Commits

### Branch Naming

Use short-lived branches from `main`:

| Prefix | Use for |
|---|---|
| `feat/<description>` | New features |
| `fix/<description>` | Bug fixes |
| `docs/<description>` | Documentation only |
| `refactor/<description>` | Code restructuring |
| `test/<description>` | Test additions/changes |
| `chore/<description>` | Maintenance, tooling, CI |

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(interface): add contextual follow-up override support
fix(federation): enforce bounded body size validation
docs(readme): clarify daemon mode safety latches
refactor(core): extract shell policy helpers from hardConstraints
test(governors): add supermajority threshold boundary tests
```

---

## How to Contribute

### 🐛 Bug Reports

Open a [GitHub issue](https://github.com/AgentBigBrain/AgentBigBrain/issues/new) with:

- Clear title describing the problem
- Exact commands executed and their output
- Expected vs. actual behavior
- Minimal steps to reproduce
- Environment details (OS, Node.js version)
- Relevant logs (redact any secrets)

**Tip:** Note whether the issue reproduces with `BRAIN_MODEL_BACKEND=mock`.

### 💡 Feature Requests

Open a [GitHub issue](https://github.com/AgentBigBrain/AgentBigBrain/issues/new) with:

- Problem statement — what are you trying to solve?
- Proposed behavior
- Which layer of the architecture it affects (`core`, `governors`, `organs`, `models`, `interfaces`)
- Any compatibility or migration concerns

### 🔧 Code Contributions

1. Fork the repository and create a branch from `main`.
2. Read [AGENTS.md](AGENTS.md) for architecture boundaries, safety rules, and operational gates.
3. Write your code following the [coding standards](#coding-standards) below.
4. Add or update tests in the corresponding `tests/` subdirectory.
5. Ensure all checks pass:
   ```bash
   npm run build
   npm test
   npm run check:docs
   ```
6. Submit a pull request following the [PR process](#pull-request-process).

---

## Pull Request Process

### Before Submitting

- [ ] Code compiles — `npm run build`
- [ ] Tests pass — `npm test`
- [ ] Doc checks pass — `npm run check:docs`
- [ ] Tests cover changed behavior
- [ ] Documentation updated for public behavior changes (`README.md`, `docs/ARCHITECTURE.md`)
- [ ] No secrets, credentials, or personal data included
- [ ] Commit messages follow Conventional Commits

### PR Description Template

```markdown
## What

[One-line summary of what this PR does]

## Why

[Problem this solves or motivation for the change]

## How

[Brief description of the approach taken]

## Testing

[What tests were added/modified, how to verify]
```

### Review Process

- All PRs require maintainer review before merge.
- CI must pass (build, test, doc checks).
- Reviewers may request changes — address feedback and re-request review.

---

## Coding Standards

### Architecture Rules

See [AGENTS.md](AGENTS.md) for the full list. Key rules:

- Domain types go in `src/core/types.ts`
- Hard constraints stay in `src/core/hardConstraints.ts` — deterministic, no LLM calls
- Governors are single-lens and decoupled from executor details
- Model calls go through `src/models/` behind `ModelClient`
- All actions flow through orchestrator-governed execution

### JSDoc Pattern

Every function in `src/` must include the project's standard JSDoc block:

```typescript
/**
 * [One-line summary of what the function does.]
 *
 * **Why it exists:**
 * [Design rationale — not a restatement of the code.]
 *
 * **What it talks to:**
 * - Uses `DependencyName` (import `DependencyName`) from `./module`.
 *
 * @param paramName - Description of the parameter.
 * @returns Description of the return value.
 */
```

Every file in `src/` must begin with a `@fileoverview` comment.

### Testing

- Tests go under `tests/`, mirroring the `src/` directory structure.
- Use mocks only for external dependencies (model providers, network). Never mock core control flow.
- Test names should be descriptive and self-documenting.

---

## AI-Assisted Development

This repository includes instruction files for popular AI coding tools:

| Tool | File |
|---|---|
| GitHub Copilot / General | [AGENTS.md](AGENTS.md) |
| Claude Code | [CLAUDE.md](CLAUDE.md) |
| Cursor | [.cursor/rules/agentbigbrain.mdc](.cursor/rules/agentbigbrain.mdc) |
| OpenAI Codex | [.codex/skills/agentbigbrain/SKILL.md](.codex/skills/agentbigbrain/SKILL.md) |

These files provide your AI assistant with architecture context, safety rules, operational gates, and the JSDoc pattern used throughout the codebase. They are kept in sync — if you update one, update all four.

