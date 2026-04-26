# Constraint Runtime

## Responsibility
This subsystem owns the extracted deterministic hard-constraint families that feed the stable
`src/core/hardConstraints.ts` entrypoint.

It groups action-family evaluators by concern so safety edits do not require loading one large
mixed file.

Primary files:
- `contracts.ts`
- `decisionHelpers.ts`
- `pathConstraints.ts`
- `skillConstraints.ts`
- `skillMarkdownPolicy.ts`
- `processConstraints.ts`
- `loopbackConstraints.ts`
- `browserConstraints.ts`
- `continuityConstraints.ts`

## Inputs
- `BrainConfig` policy values
- `GovernanceProposal` action params
- deterministic param/path/shell policy helpers from `src/core/`

## Outputs
- typed `ConstraintViolation[]` results for each action family
- stable immutable-touch detection for self-modify proposals

## Invariants
- `src/core/hardConstraints.ts` stays the stable top-level entrypoint.
- Constraint helpers here remain fail-closed and deterministic; richer interpretation belongs in
  higher layers, not in hard constraints.
- Shared path/shell helper policies stay owned by `hardConstraintPathPolicy.ts`,
  `hardConstraintShellPolicy.ts`, and `hardConstraintCommunicationPolicy.ts`.
- New action-family safety rules should land here instead of expanding `hardConstraints.ts` inline.

## Related Tests
- `tests/core/hardConstraints.test.ts`
- `tests/core/hardConstraintPathPolicy.test.ts`
- `tests/core/stage2Safety.test.ts`

## When to Update This README
Update this README when:
- a new hard-constraint action family is extracted into this subsystem
- ownership moves between this subsystem and the older `hardConstraint*Policy.ts` helpers
- the stable boundary between this subsystem and `hardConstraints.ts` changes
