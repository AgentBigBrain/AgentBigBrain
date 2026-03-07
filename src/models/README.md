# Model Clients

## Responsibility
This folder owns provider-backed and mock model clients, schema-validation support, and the factory
logic that chooses a model backend from environment/runtime configuration.

## Primary Files
- Backend factory and shared contracts: `createModelClient.ts`, `schemaValidation.ts`, `types.ts`.
- Provider implementations: `mockModelClient.ts`, `ollamaModelClient.ts`, `openaiModelClient.ts`.

## Inputs
- model-backend configuration and provider credentials from `src/core/config.ts`
- schema definitions and runtime prompts from planner, orchestrator, and interface layers
- test doubles and mock routing expectations

## Outputs
- `ModelClient` implementations and schema-safe provider responses
- backend selection and provider-specific telemetry/accounting data
- deterministic mock behavior for tests and smoke harnesses

## Invariants
- Provider-specific logic should stay behind the `ModelClient` contract.
- Schema validation belongs here, close to provider normalization, not duplicated at call sites.
- Mock behavior should remain explicit and deterministic for repo tests.

## Related Tests
- `tests/models/createModelClient.test.ts`
- `tests/models/mockModelClient.test.ts`
- `tests/models/openaiModelClient.test.ts`

## When to Update This README
Update this README when:
- a model backend is added, removed, or renamed
- factory ownership or schema-validation responsibilities move
- provider normalization or mock determinism changes enough to affect the main edit path
- the related-test surface changes because model ownership moved
