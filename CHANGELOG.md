# Changelog

This file records release-relevant changes to AgentBigBrain in a concise, operator-facing format.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version headings
stay aligned with `package.json`.

## [Unreleased]

### Added

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

### Fixed

### Security

## [0.1.0] - 2026-03-04

### Added
- Initial public baseline for the governed AgentBigBrain runtime.
- Multi-interface execution support across CLI, Telegram, Discord, and federation entrypoints.
- Governed execution, recovery, memory, and evidence infrastructure as the starting release
  contract.
