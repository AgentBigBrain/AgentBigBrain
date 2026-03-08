# OpenAI Runtime

## Responsibility
This subsystem owns OpenAI-specific request-envelope contracts, structured-output schema envelopes,
and the provider-only helpers that should not stay mixed into the stable `openaiModelClient.ts`
entrypoint.

The current extracted slice moves canonical OpenAI schema-envelope ownership behind:
- `contracts.ts`
- `pricingPolicy.ts`
- `requestBuilder.ts`
- `responseNormalization.ts`
- `schemaEnvelope.ts`

## Inputs
- logical schema names and structured completion requests from `openaiModelClient.ts`
- canonical model schema names from `src/models/schema/contracts.ts`
- planner action schema expectations from `src/core/plannerActionSchema.ts`

## Outputs
- provider-safe `response_format` envelopes for OpenAI chat completions
- shared OpenAI pricing and response-envelope contracts
- canonical OpenAI alias-resolution and token-pricing helpers
- deterministic strict-schema transformations for known structured model schemas

## Invariants
- `openaiModelClient.ts` remains the stable thin entrypoint unless a dedicated migration renames it.
- OpenAI strict-schema envelopes here must preserve current provider behavior; extraction changes
  ownership, not product semantics.
- OpenAI alias resolution and pricing helpers here must preserve current usage-accounting behavior;
  extraction changes ownership, not product semantics.
- Unknown schema names must keep falling back to `json_object` instead of emitting invalid provider
  contracts.
- Planner schema branches here must stay aligned with `src/core/plannerActionSchema.ts`.

## Related Tests
- `tests/models/openaiModelClient.test.ts`
- `tests/models/openaiPricingPolicy.test.ts`
- `tests/models/openaiRequestBuilder.test.ts`
- `tests/models/openaiResponseNormalization.test.ts`
- `tests/models/openaiSchemaEnvelope.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/models/openai/`
- OpenAI request-envelope, alias-resolution, or schema-envelope ownership moves
- strict-schema transformation semantics change materially
- the stable `openaiModelClient.ts` entrypoint changes role
- the related-test surface changes because OpenAI runtime ownership moved
