# Versioning

This file explains how version numbers are handled in AgentBigBrain.

## Source Of Truth

Use `package.json` as the single source of truth for the release version.

That means:

- `package.json` tells you the current release number.
- `CHANGELOG.md` keeps unreleased work under `[Unreleased]`.
- The latest released section in `CHANGELOG.md` should match `package.json`.

This keeps day-to-day development simple. You do not have to invent a second place to ask, "What
version are we on?"

If you need the current version, ask the repo instead of reading a hardcoded doc value:

```bash
npm run version:current
```

## When To Bump The Version

Use Semantic Versioning in a practical, operator-facing way.

## How Version Progression Works

Version numbers move in this shape:

```text
MAJOR.MINOR.PATCH
```

For this repo, the progression should read naturally:

- `0.1.0` = first real baseline release
- `0.1.1` = backward-compatible fix release
- `0.2.0` = backward-compatible feature release
- `1.0.0` = first stable major release
- `1.0.1` = stable patch release
- `1.1.0` = stable feature release
- `2.0.0` = next breaking release

## Worked Examples

Starting from the current style of versioning:

- `0.1.0 -> 0.1.1`
  - Example: fix OpenAI transport fallback, repair a Telegram regression, or correct a governed
    runtime bug without breaking existing setup.
- `0.1.0 -> 0.2.0`
  - Example: add a new supported model family, add a new interface, or add a new backward-compatible
    governed capability.
- `0.2.3 -> 0.2.4`
  - Example: tighten a live-smoke harness, fix an evidence bug, or repair docs/scripts that support
    an existing release without changing the public contract.
- `0.2.3 -> 0.3.0`
  - Example: add a meaningful new operator-facing feature while keeping existing commands and config
    working.
- `0.9.4 -> 1.0.0`
  - Example: declare the first stable release where the public commands, config surface, and core
    runtime behavior are ready to be treated as a stable contract.
- `1.4.2 -> 1.4.3`
  - Example: fix a bug with no breaking migration required.
- `1.4.2 -> 1.5.0`
  - Example: add a new feature that existing operators can adopt without changing current setups.
- `1.4.2 -> 2.0.0`
  - Example: rename public config keys, remove supported commands, or change a persisted contract in
    a way that requires migration.

## Pre-1.0 Rule

Until `1.0.0`, use the same practical bump rules described in this file.

In other words:

- do not treat `0.x` as "anything goes"
- still use `patch` for non-breaking fixes
- still use `minor` for meaningful new backward-compatible capability
- reserve `1.0.0` for the point where the project is ready to present a stable public contract

### Patch

Bump the patch version for backward-compatible fixes.

Examples:

- bug fixes
- compatibility fixes
- reliability improvements
- non-breaking governance or execution corrections
- documentation updates that ship as part of another release

### Minor

Bump the minor version for new backward-compatible capability.

Examples:

- new user-facing features
- new interfaces or transport support
- new model-family support that does not break existing setups
- new governed tools or runtime capabilities
- meaningful behavior improvements that expand what the product can do

### Major

Bump the major version for breaking change.

Examples:

- removing or renaming public commands, config keys, or documented runtime behavior
- changing persisted formats, receipts, or evidence contracts in a non-compatible way
- changing interface behavior in a way that breaks existing operators, scripts, or integrations
- tightening defaults or safety rules in a way that requires operator migration

## What Should Not Trigger A Version Bump By Itself

These changes do not need their own version bump unless they are part of a release package:

- local experiments
- unfinished work under `[Unreleased]`
- refactors with no user-visible change
- test-only changes
- docs-only changes
- internal tooling cleanup

## Repo Rules

- New work goes into `CHANGELOG.md` under `[Unreleased]`.
- Keep `[Unreleased]` maintained as a concise operator-facing summary, not a release-day backlog dump.
- Update `[Unreleased]` in the same change when work affects user-visible behavior, setup,
  compatibility guidance, operator recovery behavior, or anything that should appear in release
  notes.
- Do not fill the changelog with internal-only refactors, test-only cleanup, or file-by-file
  implementation notes when they do not change what maintainers or operators need to know.
- Do not bump `package.json` for every merge or every local experiment.
- Do not infer a version bump only from commit type. Choose the bump based on release impact.
- When you cut a release, update `package.json` and create the matching released changelog section
  together.
- The repo check should fail if `package.json` and the latest released changelog version drift apart.

## What Agents Should Update

This keeps AI agents from changing the wrong file at the wrong time.

- Update `package.json` only for an explicit release or version-bump task.
- Update `CHANGELOG.md` `[Unreleased]` when a change affects users, operators, setup, compatibility,
  or release notes.
- Keep `[Unreleased]` in the standard Keep a Changelog shape:
  - `### Added`
  - `### Changed`
  - `### Fixed`
  - `### Security`
- Update `VERSIONING.md` only when version policy or release workflow changes.
- If a change might be breaking but the release intent is unclear, do not auto-bump the version.
  Call out the possible release impact instead.

## Checks

Run:

```bash
npm run check:versioning
```

This verifies:

- `CHANGELOG.md` has an `[Unreleased]` section.
- `CHANGELOG.md` `[Unreleased]` keeps the standard `Added`, `Changed`, `Fixed`, and `Security`
  headings.
- `CHANGELOG.md` has at least one released version section.
- `CHANGELOG.md` does not contain malformed mojibake release-heading delimiters.
- The latest released changelog version matches `package.json`.

## Release Flow

1. Keep ongoing work under `[Unreleased]` in `CHANGELOG.md`.
2. When you are ready to cut a release, choose the new version number.
3. Update `package.json`.
4. Move the relevant `[Unreleased]` notes into a new release heading in `CHANGELOG.md`.
5. Run:

```bash
npm run check:versioning
npm run build
npm test
```

6. Commit and tag the release.

## Why This Approach

It is easy to explain, easy to verify, and hard to let drift silently.

People checking the repo only need one answer to "what version is this?" and maintainers still get
the normal changelog workflow without manual guesswork.
