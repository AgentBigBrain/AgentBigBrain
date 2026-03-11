## Responsibility
This subsystem owns the canonical manifest, lifecycle, verification, and inventory contracts for
governed runtime skills.

## Primary Files
- `contracts.ts`
- `skillInspection.ts`
- `skillLifecycle.ts`
- `skillManifest.ts`
- `skillRegistryStore.ts`
- `skillSuggestionPolicy.ts`
- `skillVerification.ts`
- `skillVerificationContracts.ts`
- `workflowSkillBridge.ts`

## Inputs
- create/run skill actions from `src/organs/executionRuntime/skillRuntime.ts`
- repeated-workflow summaries from `src/core/workflowLearningRuntime/`
- text and voice discovery requests from the interface runtime

## Outputs
- canonical skill manifests with lifecycle, verification, side-effect, and user-facing summary metadata
- deterministic skill inventory entries for `/skills`, `command skills`, and natural-language discovery
- workflow-linked preferred-skill and suggestion summaries used by planner/orchestrator surfaces

## Invariants
- Skill manifests are stored next to runtime artifacts under `runtime/skills`.
- Inventory surfaces only show active skills.
- Verification state is explicit and never implied from file presence alone.
- The registry may suggest or prefer skills, but it never bypasses planner, governor, or executor checks.

## Related Tests
- `tests/organs/skillRegistry.test.ts`
- `tests/organs/skillWorkflowBridge.test.ts`
- `tests/organs/executor.test.ts`

## When to Update This README
- Update this README when manifest fields, verification semantics, inventory behavior, or the stable
  skill-runtime entrypoints change.
