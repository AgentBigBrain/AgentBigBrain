# OpenAI Runtime

## Responsibility
This subsystem owns OpenAI-specific request-envelope contracts, structured-output schema envelopes,
transport selection, model-family compatibility policy, and the provider-only helpers that should
not stay mixed into the stable `openaiModelClient.ts` entrypoint.

The current extracted slice moves canonical OpenAI schema-envelope ownership behind:
- `contracts.ts`
- `modelProfiles.ts`
- `pricingPolicy.ts`
- `requestBuilder.ts`
- `responseNormalization.ts`
- `chatRequestBuilder.ts`
- `responsesRequestBuilder.ts`
- `chatResponseNormalization.ts`
- `responsesResponseNormalization.ts`
- `transportContracts.ts`
- `schemaEnvelope.ts`
- `clientRuntime.ts`

## Inputs
- logical schema names and structured completion requests from `openaiModelClient.ts`
- canonical model schema names from `src/models/schema/contracts.ts`
- planner action schema expectations from `src/core/plannerActionSchema.ts`
- env transport policy and compatibility overrides from `src/models/createModelClient.ts`

## Outputs
- provider-safe `response_format` / `text.format` envelopes for OpenAI structured outputs
- deterministic model-family profile and transport selection
- shared OpenAI pricing and response-envelope contracts
- canonical OpenAI alias-resolution and token-pricing helpers
- transport-specific response normalization into one structured-validation path
- deterministic strict-schema transformations for known structured model schemas

## Operator Notes
This runtime now targets the practical OpenAI model range most operators are likely to use in this
repo:

- `gpt-4.1-mini`
- `gpt-4.1`
- `gpt-5`
- `gpt-5.1`
- `gpt-5.2`
- `gpt-5.3-codex`

Recommended default routing for broad coverage:

- `small_fast=gpt-4.1-mini`
- `small_policy=gpt-4.1-mini`
- `medium_general=gpt-4.1`
- `medium_policy=gpt-4.1-mini`
- `large_reasoning=gpt-5.3-codex`

Recommended transport and timeout settings:

- `OPENAI_TRANSPORT_MODE=auto`
- `OPENAI_TIMEOUT_MS=300000` for autonomous or live-smoke runs

## Compatibility Matrix
The compatibility policy is model-family aware rather than model-name-only.

| Model family | Preferred transport | Notes |
| --- | --- | --- |
| `gpt-4.1*` | `chat_completions` | Best default for the current structured-output path in this repo. |
| `gpt-5` | `responses` | Uses explicit low-latency reasoning effort to avoid slow default behavior in long autonomous runs. |
| `gpt-5.1` / `gpt-5.2` | `responses` | Uses lighter reasoning settings for faster autonomous turn completion. |
| `gpt-5.3-codex` | `responses` | Supported in the same compatibility layer and live-smoke matrix. |
| unknown models | `auto` or fail-closed | Controlled by `OPENAI_COMPATIBILITY_STRICT`. |

Structured-output fallback rules:

- The runtime tries the preferred transport first.
- Compatibility fallback is limited to one deterministic retry.
- Strict schema may degrade to `json_object` once when the provider rejects strict structured
  output.
- The runtime does not do open-ended transport or parameter guessing.

## Invariants
- `openaiModelClient.ts` remains the stable thin entrypoint unless a dedicated migration renames it.
- OpenAI transport selection must stay deterministic and model-family-aware.
- Chat Completions and Responses paths must normalize back into the same schema-validation contract.
- OpenAI alias resolution and pricing helpers here must preserve current usage-accounting behavior;
  extraction changes ownership, not product semantics.
- Unknown schema names must keep falling back to `json_object` instead of emitting invalid provider
  contracts.
- Compatibility fallback is bounded to one deterministic retry; it must not become an unbounded
  transport or parameter probe loop.
- Planner schema branches here must stay aligned with `src/core/plannerActionSchema.ts`.

## Related Tests
- `tests/models/openaiModelClient.test.ts`
- `tests/models/openaiPricingPolicy.test.ts`
- `tests/models/openaiRequestBuilder.test.ts`
- `tests/models/openaiResponseNormalization.test.ts`
- `tests/models/openaiResponsesRequestBuilder.test.ts`
- `tests/models/openaiResponsesResponseNormalization.test.ts`
- `tests/models/openaiSchemaEnvelope.test.ts`
- `tests/models/openaiTransportSelection.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/models/openai/`
- OpenAI request-envelope, response-normalization, transport-selection, or alias-resolution
  ownership moves
- strict-schema transformation semantics change materially
- supported OpenAI model-family guidance or verified operator coverage changes
- the stable `openaiModelClient.ts` entrypoint changes role
- the related-test surface changes because OpenAI runtime ownership moved
