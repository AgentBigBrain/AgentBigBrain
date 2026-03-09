# Changelog

All notable changes to AgentBigBrain are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OpenAI compatibility and live-smoke coverage for `gpt-4.1-mini`, `gpt-4.1`, `gpt-5`, `gpt-5.1`,
  `gpt-5.2`, and `gpt-5.3-codex`.

### Changed
- OpenAI operator guidance now recommends `OPENAI_TRANSPORT_MODE=auto` and
  `OPENAI_TIMEOUT_MS=300000` for autonomous and live-smoke runs.
- GPT-5-family Responses requests now apply explicit lower-latency reasoning settings so autonomous
  loops complete more reliably without manual transport tuning.

### Fixed
- OpenAI live-smoke evidence now documents the verified GPT-4.1 through GPT-5.3 model range in the
  setup and subsystem docs.

### Security

---

## [0.1.0] — 2026-03-04

### Added

- **Governance-first runtime** — 7-governor council with supermajority voting, hard constraints, and tamper-evident execution receipts.
- **Five memory systems** — Profile memory (encrypted, approval-gated), governance memory (append-only ledger), semantic memory (ONNX embeddings), workflow learning, and entity graph.
- **Multi-interface support** — CLI (single task, autonomous loop, daemon), Telegram bot, Discord bot, and agent-to-agent federation via authenticated HTTP.
- **Hard constraint engine** — Deterministic pre-governance safety checks for sandbox enforcement, immutable file protection, code scanning, cost ceilings, and identity/privacy guards.
- **Execution receipt chain** — Blockchain-style hash chain with output digests, vote digests, and cryptographic integrity verification.
- **Satellite clone model** — Governed bounded parallelism with spawn limits, merge governance, and attribution tracking.
- **Shell execution engine** — Process sandboxing with output buffering, timeout enforcement, and dangerous-command detection.
- **Zero-dependency core** — 2 runtime dependencies (`ws`, `onnxruntime-node`); all other functionality built on Node.js built-ins.
- **Community files** — `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `AGENTS.md`, `CLAUDE.md`.
- **AI agent instruction files** — Consistent rules for Cursor, Claude Code, and OpenAI Codex contributors.
- **118 test files** and **59 evidence scripts** covering the full maturity model.

---

## Release Process

> **Note:** `package.json` currently sets `"private": true`. No automated release pipeline exists yet.

To cut a release manually:

1. Ensure clean state:
   ```bash
   npm run check:versioning
   npm run build
   npm test
   npm run check:docs
   ```
2. Confirm the current version when needed:
   ```bash
   npm run version:current
   ```
3. Update the version in `package.json`.
4. Move items from `[Unreleased]` into a new version section in this file.
   Keep the new release heading aligned with `package.json`.
5. Commit with a [Conventional Commit](https://www.conventionalcommits.org/) message:
   ```
   chore(release): v0.2.0
   ```
6. Tag and push:
   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```
7. Create a GitHub Release from the tag using the changelog entry as release notes.

For the repo-wide versioning policy, see [VERSIONING.md](./VERSIONING.md).
