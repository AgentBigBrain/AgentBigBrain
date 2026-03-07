# Interfaces Layer

## Responsibility
This folder owns transport/runtime ingress, conversation lifecycle handling, interface-facing
classification or routing logic, and the stable composition entrypoint for user-facing result
rendering.

The extracted `src/interfaces/userFacing/` subsystem owns canonical wording surfaces, while this
top-level folder owns the transport and lifecycle path that consumes them.

## Primary Files
- Transport entrypoints and runtime wiring: `discordAdapter.ts`, `discordApiUrl.ts`,
  `discordGateway.ts`, `discordRateLimit.ts`, `interfaceRuntime.ts`, `runtimeConfig.ts`,
  `telegramAdapter.ts`, `telegramGateway.ts`.
- Conversation lifecycle and session flow: `ackStateMachine.ts`, `conversationCommandPolicy.ts`,
  `conversationDeliveryLifecycle.ts`, `conversationDraftStatusPolicy.ts`,
  `conversationExecutionInputPolicy.ts`, `conversationIngressLifecycle.ts`,
  `conversationManager.ts`, `conversationManagerHelpers.ts`,
  `conversationSessionMutations.ts`, `conversationWorkerLifecycle.ts`, `routingMap.ts`,
  `sessionStore.ts`.
- Prompting, routing, and lexical classification: `checkpointReviewRouting.ts`,
  `contextualFollowupLexicalClassifier.ts`, `conversationClassifierEvents.ts`,
  `diagnosticsPromptPolicy.ts`, `followUpClassifier.ts`, `invocationHints.ts`,
  `invocationPolicy.ts`, `liveBuildVerificationPromptPolicy.ts`, `trustLexicalClassifier.ts`.
- Pulse, federation, and entity-graph runtime support: `agentPulseScheduler.ts`,
  `entityGraphRuntime.ts`, `federatedClient.ts`, `federatedServer.ts`, `federationRuntime.ts`,
  `pulseEmissionLifecycle.ts`, `pulseUxRuntime.ts`, `stage6_86UxRendering.ts`.
- Stable user-facing composition entrypoint: `userFacingResult.ts`.

## Inputs
- governed task results, autonomous summaries, and runtime stop reasons
- transport events from Telegram, Discord, and local interface runtime wiring
- conversation/session state, routing hints, and lexical classification signals
- runtime config and policy signals from `src/core/` and `src/organs/`

## Outputs
- user-visible transport progress and terminal summaries
- conversation routing decisions, prompt classification, and invocation hints
- transport-facing delivery behavior and session mutations
- canonical user-facing result composition through `userFacingResult.ts`

## Invariants
- Transport lifecycle logic should stay at this top level; wording logic should stay in
  `src/interfaces/userFacing/`.
- `userFacingResult.ts` remains a stable thin entrypoint even when rendering details move deeper.
- Telegram and Discord adapters should share the same truthfulness and stop-summary contracts.
- Conversation lifecycle behavior should remain discoverable here rather than spread into unrelated
  transport helpers.

## Related Tests
- `tests/interfaces/userFacingResult.test.ts`
- `tests/interfaces/autonomousMessagePolicy.test.ts`
- `tests/interfaces/conversationCommandPolicy.test.ts`
- `scripts/evidence/interfaceAdvancedLiveSmoke.ts`

## When to Update This README
Update this README when:
- a top-level interface file is added, removed, or renamed
- ownership moves between transport lifecycle code and `src/interfaces/userFacing/`
- Telegram or Discord runtime wiring changes materially
- the related-test surface changes because interface responsibilities moved
