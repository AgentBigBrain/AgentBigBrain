# Changelog

This file records release-relevant changes to AgentBigBrain in a concise, operator-facing format.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version headings
stay aligned with `package.json`.

## [Unreleased]

### Added
- Added source-labeled media interpretation layers, optional policy-gated document meaning, and a
  Telegram completion matrix smoke that writes review-safe PASS/FAIL/BLOCKED evidence.
- Added governed skill lifecycle actions for updating, approving, rejecting, and deprecating
  runtime skills.

### Changed
- Media memory ingest now prefers structured layer authority over rendered prompt text, keeping raw
  document and model-derived meaning candidate-only for durable profile memory.
- Agent-suggested skills now default to a reviewable pending state until operator approval.

### Fixed
- Obsidian media projection now surfaces interpretation-layer authority and redacts review-safe
  extracted text consistently.

### Security
- Review evidence for the Telegram completion matrix rejects unredacted local paths and
  identifier-shaped values before writing artifacts.

## [0.2.0] - 2026-05-01

### Added
- Added a projection subsystem under `src/core/projections/` with a generic sink boundary, an
  Obsidian vault sink, and a JSON mirror sink for external memory inspection.
- Added canonical runtime-owned media artifact persistence so Telegram uploads can be mirrored as
  evidence artifacts with stable identity, provenance, derived meaning, and optional owned asset
  copies.
- Added operator tooling for manual Obsidian projection rebuilds, guarded review-action apply
  batches, and exact-path Obsidian open helpers.

### Changed
- Rewrote the top-level README and architecture reference to better match the actual runtime
  contracts, operator surfaces, and governance flow in code.
- Expanded the README and architecture reference again to spell out the graph-backed temporal and
  relational profile-memory model, the boundary between profile memory and Stage 6.86 continuity,
  the inbound-versus-outbound federation split, and the role of connector receipts.
- Removed the two decorative images from the top-level README and replaced them with a cleaner
  GitHub-first layout.
- Expanded `docs/SETUP.md` to match the current code paths for inherited media backends,
  modality-specific media routing, graph-backed profile memory, Stage 6.86 continuity, Telegram
  media limits, and cross-platform interface continuity requirements.
- Expanded the README, architecture reference, setup guide, command examples, and the Obsidian
  projection plan to document the new projection layer, media artifact mirror model, review-action
  write-back lane, and operator commands.
- Tightened profile-memory writes so explicit source-lane policy is applied before broad extraction,
  while direct identity and relationship memory remains available.

### Fixed
- Shared runtime wiring now owns the entity graph, Stage 6.86 runtime-state adapter, and
  projection-service fanout together so the external mirror does not miss live continuity state.
- Obsidian rebuilds now preserve operator-authored review-action notes instead of wiping the entire
  mirror subtree during full rebuilds.
- Obsidian entity notes now suppress low-signal lexical artifacts, keep real standalone entities,
  and render richer overview details so clicked notes do not collapse into nearly empty pages.
- Obsidian entity notes now keep duplicate canonical names distinct and label continuity-only
  evidence separately from durable current temporal claims.
- Stage 6.86 entity extraction now strips more conversational glue before durable graph writes, and
  operators can run a bounded low-signal cleanup pass against older entity-graph residue.
- Memory review corrections now validate replacement values by family before creating successor
  truth, and preferred-name validation no longer carries mojibake in its token pattern.

### Security

## [0.1.0] - 2026-03-04

### Added
- Initial public baseline for the governed AgentBigBrain runtime.
- Multi-interface execution support across CLI, Telegram, Discord, and federation entrypoints.
- Governed execution, recovery, memory, and evidence infrastructure as the starting release
  contract.
