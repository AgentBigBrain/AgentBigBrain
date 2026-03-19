# Schema Runtime

## Responsibility
This subsystem owns canonical structured-output schema names, model-boundary normalization, and
deterministic validation for provider and mock model clients.

The current extracted slice moves schema ownership behind:
- `contracts.ts`
- `jsonSchemas.ts`
- `validation.ts`

The stable `schemaValidation.ts` entrypoint remains for compatibility, but canonical schema
validation logic now lives here.

## Inputs
- raw structured model payloads returned by provider-backed and mock model clients
- planner action payloads normalized through `src/core/plannerActionSchema.ts`
- schema-name strings emitted by planner, orchestrator, governor, reflection, and interface flows

## Outputs
- canonical known-schema contracts for structured model requests
- JSON Schema payloads for backends that accept schema files directly
- normalized planner output payloads at the model boundary
- deterministic validation failures for malformed provider or mock responses

## Invariants
- `schemaValidation.ts` remains the stable thin entrypoint unless the repo deliberately renames that
  surface in a dedicated migration.
- Validation here must remain fail-closed and deterministic.
- Schema normalization here must preserve existing provider/mock behavior; extraction changes
  ownership, not product semantics.
- Planner action normalization here must stay aligned with `src/core/plannerActionSchema.ts`.

## Related Tests
- `tests/models/schemaValidationRuntime.test.ts`
- `tests/models/openaiModelClient.test.ts`
- `tests/models/mockModelClient.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/models/schema/`
- schema-name ownership moves between this subsystem and another model layer file
- model-boundary validation or normalization semantics change materially
- the stable `schemaValidation.ts` entrypoint changes role
- the related-test surface changes because schema ownership moved
