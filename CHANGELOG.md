# Changelog

This file records release-relevant changes to AgentBigBrain in a concise, operator-facing format.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version headings
stay aligned with `package.json`.

## [Unreleased]

### Added
- Added the Source Recall Archive contract, test-only storage seam, quoted-evidence retrieval,
  media/conversation capture metadata, projection-safe read models, and a synthetic evidence
  matrix proving recall quality stays separate from memory truth, approvals, safety, and completion
  proof.

### Changed
- Expanded the public README and docs map with clearer positioning, authority-boundary diagrams,
  and concepts references for new readers.
- Profile-memory, semantic-memory, workflow-learning, media-artifact, and projection surfaces can
  now cite Source Recall ids as evidence without granting write, truth, approval, or proof
  authority.

### Fixed

### Security

## [0.3.0] - 2026-05-03

### Added
- Added source-labeled media interpretation layers, optional policy-gated document meaning, and a
  Telegram completion matrix smoke that writes review-safe PASS/FAIL/BLOCKED evidence.
- Added governed skill lifecycle actions for updating, approving, rejecting, and deprecating
  runtime skills.
- Added touched-file lexical-boundary reporting and plan-specific lexical cleanup evidence for the
  remaining route, planner, memory, pulse, and trust surfaces.
- Added profile-memory source-family and ingest-lane policy tests so document/media summaries,
  broad relationship patterns, and broad episode patterns start candidate/support-only by default.
- Added a semantic-language evidence matrix that separates runtime-observed proof from CI-safe
  schema-only coverage for relationship, identity, media, build, skill, workflow, prompt, mission,
  organization, bridge, model-fallback, and compatibility-boundary scenarios.

### Changed
- Media memory ingest now prefers structured layer authority over rendered prompt text, keeping raw
  document and model-derived meaning candidate-only for durable profile memory.
- Agent-suggested skills now default to a reviewable pending state until operator approval.
- Conversation follow-up routing now requires typed session context or an explicit reminder shape
  before contextual cue words can influence status, memory, or workflow continuation.
- Conversation profile-memory writes now route media-only turns through source lanes instead of
  inheriting direct user-text extraction authority.
- Markdown skill guidance now carries selection provenance, advisory authority, and exact matched
  terms before planner consumption.
- Prompt, routing, memory, pulse, graph, and user-facing continuity paths now prefer typed authority
  or receipts over lexical candidate evidence and rendered assistant prose.

### Fixed
- Runtime skill manifests now fail closed when a same-name runtime override is malformed instead
  of silently re-enabling the built-in skill.
- PDF document extraction now applies page and text budgets during extraction and releases parser
  resources after each parse.
- Mission diagnostics now classify skill lifecycle actions as tier-three side effects.
- Obsidian media projection now surfaces interpretation-layer authority and redacts review-safe
  extracted text consistently.
- Unanchored contextual cue wording now preserves ordinary chat instead of falling through to the
  generic local intent model and accidentally becoming execution work.

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
