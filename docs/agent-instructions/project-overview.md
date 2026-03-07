# Project Overview

AgentBigBrain is a governance-first TypeScript runtime for autonomous AI agents. Every action
follows the loop: Plan -> Constrain -> Govern -> Execute -> Receipt -> Reflect.

Key architecture facts for contributors:

- The repository is AI-first for maintainability: folder READMEs, `docs/ai/` discovery artifacts,
  and thin stable entrypoints should make the correct edit surface discoverable without guesswork.
- Governance has two paths: fast-path actions are evaluated by the security governor only;
  escalation-path actions go to the full 7-governor council (ethics, logic, resource, security,
  continuity, utility, compliance) with supermajority voting. A separate code-review governor runs
  as a preflight gate for `create_skill` actions only.
- Hard constraints run before governance: deterministic, non-LLM safety checks that cannot be
  bypassed.
- Execution receipts are appended after execution: each approved action produces a tamper-evident
  receipt with output and vote digests, hash-chained to the prior receipt.
- Clones are not sub-agents: they are governed satellite identities with role overlays, spawn
  limits, and merge governance. They do not get independent orchestrator instances.
- Runtime dependencies stay minimal: `ws` and `onnxruntime-node`. Everything else should use Node.js
  built-ins unless there is a strong reason otherwise.
