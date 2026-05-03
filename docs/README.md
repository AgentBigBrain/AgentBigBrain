# AgentBigBrain Docs

This directory is the public documentation map for AgentBigBrain. Start here when you want the
shortest path from the product idea to the operator details.

## Start here

- [Architecture overview](./ARCHITECTURE_OVERVIEW.md): short visual model of meaning, authority,
  execution, proof, memory, and projection.
- [Concepts glossary](./CONCEPTS.md): plain-English definitions for the terms used across the
  runtime and docs.
- [Full architecture reference](./ARCHITECTURE.md): detailed subsystem map and invariants.
- [Setup](./SETUP.md): environment variables, model backends, media backends, Telegram, Discord,
  federation, and local runtime wiring.
- [Command examples](./COMMAND_EXAMPLES.md): practical CLI and interface examples.
- [Runtime error and env map](./ERROR_CODE_ENV_MAP.md): reason codes, block codes, and related
  configuration.

## Core concepts

AgentBigBrain is built around a small set of runtime ideas:

- semantic routing
- typed action authority
- governed execution
- profile memory and episodic memory
- Stage 6.86 continuity
- Markdown instruction skills
- Obsidian and JSON projection
- execution receipts
- model-unavailable fail-closed behavior

Use [CONCEPTS.md](./CONCEPTS.md) when a term appears in the README or architecture reference before
the implementation detail matters.

## Operator references

- Use [SETUP.md](./SETUP.md) when configuring local backends, interface providers, auth, or media
  understanding.
- Use [COMMAND_EXAMPLES.md](./COMMAND_EXAMPLES.md) when testing common tasks through CLI,
  Telegram, Discord, memory review, pulse, or Obsidian tooling.
- Use [ERROR_CODE_ENV_MAP.md](./ERROR_CODE_ENV_MAP.md) when a run blocks, fails closed, or needs an
  environment toggle.

## Maintainer references

- Use [ARCHITECTURE.md](./ARCHITECTURE.md) before changing runtime ownership boundaries.
- Use [../CHANGELOG.md](../CHANGELOG.md) for release-facing changes.
- Use [../CONTRIBUTING.md](../CONTRIBUTING.md) and [../SECURITY.md](../SECURITY.md) before opening
  or reviewing changes.
