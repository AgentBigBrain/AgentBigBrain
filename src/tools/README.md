# Repository Tooling

## Responsibility
This folder owns repository-facing maintenance checks, AI-first sync tooling, smoke harnesses, and
one-off operational scripts that are intentionally kept outside the main runtime path.

## Primary Files
- AI-first and maintainability checks: `checkAiChangeSurfaceSync.ts`,
  `checkFileClassificationCoverage.ts`, `checkFunctionDocs.ts`, `checkModuleSize.ts`,
  `checkReasonCodeUniqueness.ts`, `checkSubsystemReadmeSync.ts`,
  `checkUserFacingStopPhraseDuplication.ts`, `exportAiArchitectureIndex.ts`.
- Smoke/evidence helpers: `openAiLiveSmokeHarness.ts`, `stage6_85Clones.ts`,
  `stage6_85Latency.ts`, `stage6_85MissionUx.ts`, `stage6_85Observability.ts`,
  `stage6_85Playbooks.ts`, `stage6_85QualityGates.ts`, `stage6_85Recovery.ts`,
  `stage6_85WorkflowReplay.ts`.
- Operational utilities: `parseLog.ts`, `temp_ledger_dump.ts`.

## Inputs
- repository source files, docs, and AI-first metadata artifacts
- runtime evidence artifacts and log output
- local package scripts and repo-root execution context

## Outputs
- fail-closed validation results for docs, module size, reason codes, and README sync
- regenerated AI architecture index output
- smoke/evidence reports and operational diagnostics

## Invariants
- Repo-maintenance tooling should stay deterministic and runnable from package scripts.
- AI-first checks belong here, close to the generated artifacts they validate.
- One-off operational helpers are acceptable here, but they should not silently become runtime
  dependencies.

## Related Tests
- `tests/tools/checkAiChangeSurfaceSync.test.ts`
- `tests/tools/checkFileClassificationCoverage.test.ts`
- `tests/tools/checkModuleSize.test.ts`
- `tests/tools/checkReasonCodeUniqueness.test.ts`
- `tests/tools/checkSubsystemReadmeSync.test.ts`
- `tests/tools/checkUserFacingStopPhraseDuplication.test.ts`
- `tests/tools/exportAiArchitectureIndex.test.ts`

## When to Update This README
Update this README when:
- a top-level tooling script is added, removed, or renamed
- a new maintainability or AI-first check is introduced
- smoke/evidence ownership moves into a different tooling folder
- the related-test surface changes because tooling ownership moved
