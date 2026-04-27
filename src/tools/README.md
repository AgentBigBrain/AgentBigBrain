# Repository Tooling

## Responsibility
This folder owns repository-facing maintenance checks, smoke harnesses, and one-off operational
scripts that are intentionally kept outside the main runtime path.

## Primary Files
- Maintainability and contract checks: `checkFunctionDocs.ts`, `checkLexicalRoutingBoundary.ts`,
  `checkModuleSize.ts`, `checkReasonCodeUniqueness.ts`, `checkSubsystemReadmeSync.ts`,
  `checkTemporalMemoryRegistry.ts`, `checkVersioning.ts`,
  `checkUserFacingStopPhraseDuplication.ts`.
- Projection and operator helpers: `exportObsidianProjection.ts`,
  `applyObsidianReviewActions.ts`, `openObsidianProjection.ts`,
  `pruneLowSignalEntityGraph.ts`.
- Smoke/evidence helpers: `openAiLiveSmokeHarness.ts`, `stage6_85Clones.ts`,
  `stage6_85Latency.ts`, `stage6_85MissionUx.ts`, `stage6_85Observability.ts`,
  `stage6_85Playbooks.ts`, `stage6_85QualityGates.ts`, `stage6_85Recovery.ts`,
  `stage6_85WorkflowReplay.ts`.
- Operational utilities: `parseLog.ts`, `temp_ledger_dump.ts`.

## Inputs
- repository source files, docs, and maintainability contract files
- runtime evidence artifacts and log output
- local package scripts and repo-root execution context

## Outputs
- fail-closed validation results for docs, unused locals/imports, module size, reason codes, and
  README sync
- smoke/evidence reports and operational diagnostics
- manual Obsidian projection rebuilds, guarded review-action apply reports, and exact-path
  Obsidian open helpers
- deterministic Stage 6.86 graph cleanup for low-signal conversational residue

## Invariants
- Repo-maintenance tooling should stay deterministic and runnable from package scripts.
- One-off operational helpers are acceptable here, but they should not silently become runtime
  dependencies.
- `checkModuleSize.ts` and `checkSubsystemReadmeSync.ts` are the canonical contract gates for the
  intentionally kept thin entrypoints and folder-level README discovery surface after the cleanup
  plans.
- `checkLexicalRoutingBoundary.ts` is the advisory guardrail for frozen route-owner files so broad
  regex, token-set, or phrase-array growth stays visible during semantic-routing cleanup.
- `checkTemporalMemoryRegistry.ts` is the canonical CI gate for code-owned profile-memory family
  registry coverage and policy-coherence checks once Phase 2.5 starts promoting truth-governance
  policy out of plan prose. That includes family coverage, inventory/cardinality coherence,
  compatibility-projection posture, approved `contact.*` projection-table coverage, and answer-mode
  fallback requirements for corroboration or support-only families.

## Related Tests
- `tests/tools/checkModuleSize.test.ts`
- `tests/tools/checkLexicalRoutingBoundary.test.ts`
- `tests/tools/checkReasonCodeUniqueness.test.ts`
- `tests/tools/checkSubsystemReadmeSync.test.ts`
- `tests/tools/checkTemporalMemoryRegistry.test.ts`
- `tests/tools/checkUserFacingStopPhraseDuplication.test.ts`
- `tests/tools/checkVersioning.test.ts`
- `tests/tools/obsidianProjectionTools.test.ts`

## When to Update This README
Update this README when:
- a top-level tooling script is added, removed, or renamed
- a new maintainability or AI-first check is introduced
- thin-entrypoint or README-sync enforcement changes enough to alter the main tooling contract
- package-script validation starts enforcing a new repo-wide TypeScript hygiene rule
- smoke/evidence ownership moves into a different tooling folder
- the related-test surface changes because tooling ownership moved
- a new operator-facing projection helper is added, removed, or renamed
- a new operator-facing Stage 6.86 graph cleanup helper is added, removed, or renamed
