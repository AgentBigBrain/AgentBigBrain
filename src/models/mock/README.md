# Mock Runtime

## Responsibility
This subsystem owns deterministic mock-model prompt parsing plus the canonical planner, response
synthesis, and intent-interpretation builders that should not stay mixed into the stable
`mockModelClient.ts` entrypoint.

The current extracted slice moves mock ownership behind:
- `contracts.ts`
- `languageUnderstanding.ts`
- `plannerResponses.ts`
- `responseSynthesis.ts`
- `intentResponses.ts`

The stable `mockModelClient.ts` entrypoint remains for compatibility, but canonical mock response
behavior now lives here.

## Inputs
- structured completion requests routed through `mockModelClient.ts`
- planner action contracts from `src/core/types.ts`
- wrapped current-request text extracted from interface conversation payloads
- schema-runtime normalization from `src/models/schema/validation.ts`

## Outputs
- deterministic planner action proposals for local development and CI
- deterministic mock chat responses for response-synthesis tests
- deterministic pulse-intent interpretations for interface tests
- shared mock prompt parsing and action-type helpers

## Invariants
- `mockModelClient.ts` remains the stable thin entrypoint unless a dedicated migration renames it.
- Mock behavior here must remain explicit, deterministic, and fail-closed for repo tests.
- Extraction here changes ownership, not product semantics.
- Wrapped conversation input must continue to prefer the active user request over stale context.

## Related Tests
- `tests/models/mockModelClient.test.ts`
- `tests/models/mockPlannerResponses.test.ts`
- `tests/models/mockResponseSynthesis.test.ts`
- `tests/models/mockIntentResponses.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/models/mock/`
- canonical mock planner, synthesis, or intent ownership moves
- the stable `mockModelClient.ts` entrypoint changes role
- deterministic mock behavior changes materially
- the related-test surface changes because mock runtime ownership moved
