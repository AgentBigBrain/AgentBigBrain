# Governors Layer

## Responsibility
This folder owns the runtime governance entrypoints, shared governor contracts, and the
cross-governor routing helpers that sit above the extracted default council subsystem in
`src/governors/defaultCouncil/`.

## Primary Files
- Council entrypoints and routing: `codeReviewGovernor.ts`, `defaultGovernors.ts`,
  `masterGovernor.ts`, `voteGate.ts`.
- Shared contracts and safety vocabulary: `safetyLexicon.ts`, `types.ts`.

## Inputs
- candidate actions and typed runtime metadata from `src/core/types.ts`
- deterministic hard-constraint outcomes and execution-mode routing context
- model-advisory requests and council-specific policy inputs

## Outputs
- governor votes, code-review preflight outcomes, and council decisions
- shared governor contracts used by runtime and tests
- canonical default-council composition through `defaultGovernors.ts`

## Invariants
- `defaultGovernors.ts` is a stable thin entrypoint; detailed council policy belongs in
  `src/governors/defaultCouncil/`.
- Shared governor shapes belong in `types.ts`, not duplicated in each governor file.
- Cross-governor wiring should stay readable at the top level instead of reappearing inside
  unrelated runtime folders.

## Related Tests
- `tests/governors/defaultGovernors.test.ts`
- `tests/governors/defaultCouncil.test.ts`
- `tests/core/orchestrator.test.ts`

## When to Update This README
Update this README when:
- a new top-level governor file is added, removed, or renamed
- governor entrypoint ownership changes between this folder and `defaultCouncil/`
- shared governor contracts or council wiring move materially
- the related-test surface changes because governance ownership moved
