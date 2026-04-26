# Model Clients

## Responsibility
This folder owns provider-backed and mock model clients, schema-validation support, and the factory
logic that chooses a model backend from environment/runtime configuration.

The extracted subsystems now own:
- `src/models/schema/` for canonical schema-name contracts plus structured-output normalization and
  validation below the stable `schemaValidation.ts` entrypoint
- `src/models/openai/` for OpenAI-specific structured-output schema envelopes below the stable
  `openaiModelClient.ts` entrypoint
- `src/models/codex/` for Codex CLI auth/status inspection, model resolution, and structured-output
  execution below the stable `codexModelClient.ts` entrypoint
- `src/models/mock/` for deterministic mock planner, synthesis, and intent-response builders below
  the stable `mockModelClient.ts` entrypoint

## Primary Files
- Backend factory and shared contracts: `backendConfig.ts`, `createModelClient.ts`,
  `schemaValidation.ts`, `types.ts`, plus the extracted `src/models/schema/` validation subsystem.
- Provider implementations: `mockModelClient.ts`, `ollamaModelClient.ts`, `openaiModelClient.ts`,
  `codexModelClient.ts`, plus the extracted `src/models/openai/`, `src/models/codex/`, and
  `src/models/mock/` helper subsystems.

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
- Ollama-backed runs must resolve logical model aliases to concrete local model tags before making
  provider requests; alias names should never leak directly to the Ollama API.
- Schema validation belongs here, close to provider normalization, not duplicated at call sites.
- `schemaValidation.ts` remains the stable schema-validation entrypoint even when canonical schema
  ownership moves into `src/models/schema/`.
- `openaiModelClient.ts` remains the stable OpenAI entrypoint even when OpenAI request-envelope
  helpers move into `src/models/openai/`.
- `codexModelClient.ts` remains the stable Codex entrypoint even when Codex CLI/auth helpers move
  into `src/models/codex/`.
- `mockModelClient.ts` remains the stable mock-model entrypoint even when canonical mock planner,
  synthesis, and intent builders move into `src/models/mock/`.
- `createModelClient.ts`, `openaiModelClient.ts`, `codexModelClient.ts`, `mockModelClient.ts`, and
  `schemaValidation.ts` are intentionally guarded by the module-size check so the top-level model
  layer stays limited to stable entrypoints and backend selection.
- Mock behavior should remain explicit and deterministic for repo tests.
- Mock planner behavior should exercise action schemas and policy boundaries, not synthesize
  framework/static app scaffolds, page templates, live-preview chains, or other generated project
  workflows. Tests that need build-action shapes should use focused planner fixtures.

## Related Tests
- `tests/models/createModelClient.test.ts`
- `tests/models/codexAuthStore.test.ts`
- `tests/models/codexModelResolution.test.ts`
- `tests/models/mockIntentResponses.test.ts`
- `tests/models/mockModelClient.test.ts`
- `tests/models/mockPlannerResponses.test.ts`
- `tests/models/mockResponseSynthesis.test.ts`
- `tests/models/openaiModelClient.test.ts`
- `tests/models/openaiPricingPolicy.test.ts`
- `tests/models/openaiRequestBuilder.test.ts`
- `tests/models/openaiResponseNormalization.test.ts`
- `tests/models/openaiSchemaEnvelope.test.ts`
- `tests/models/schemaValidationRuntime.test.ts`

## When to Update This README
Update this README when:
- a model backend is added, removed, or renamed
- factory ownership or schema-validation responsibilities move
- ownership moves between `schemaValidation.ts` and `src/models/schema/`
- ownership moves between `openaiModelClient.ts` and `src/models/openai/`
- ownership moves between `codexModelClient.ts` and `src/models/codex/`
- ownership moves between `mockModelClient.ts` and `src/models/mock/`
- provider normalization or mock determinism changes enough to affect the main edit path
- the related-test surface changes because model ownership moved
