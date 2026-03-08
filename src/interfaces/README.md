# Interfaces Layer

## Responsibility
This folder owns transport/runtime ingress, conversation lifecycle handling, interface-facing
classification or routing logic, and the stable composition entrypoint for user-facing result
rendering.

The extracted `src/interfaces/userFacing/` subsystem owns canonical wording surfaces, while
`src/interfaces/conversationRuntime/` owns canonical session persistence plus the extracted Agent
Pulse scheduling helpers, queue/ack lifecycle primitives, queue-worker execution, and pulse-state
mutation helpers. It also now owns the canonical `/chat`, free-form queue-routing, slash-command
dispatch, and stale-session recovery helpers below the stable ingress coordinator, plus the
canonical conversation-manager contract and autonomous execution-input helpers below the stable
manager entrypoint. It also now owns canonical session-shape normalization, session merge policy,
timezone detection, user-style fingerprinting, local-time resolution helpers, and canonical Agent
Pulse scheduler contracts plus legacy/dynamic evaluation routing below the stable session/pulse
entrypoints. It also now owns canonical ack/final-delivery contracts, preview helpers, and
delivery persistence below the stable `conversationDeliveryLifecycle.ts` entrypoint.
`src/interfaces/transportRuntime/` now owns canonical outbound Discord/Telegram delivery,
autonomous progress-delivery bridging, shared transport-facing reject policy, and
notifier-construction helpers below the stable gateway entrypoints. It also now owns shared
Discord socket hello/identify, socket attach/reconnect, dispatch-routing, and Telegram poll-loop
helpers. It also now owns provider-specific inbound payload parsing/validation and notifier/send-edit
wrapper helpers. It also now owns the shared accepted-inbound conversation dispatch path used by
both gateways after provider-specific parse/validation succeeds. This top-level folder owns the
transport and lifecycle path that consumes both subsystems.

## Primary Files
- Transport entrypoints and runtime wiring: `discordAdapter.ts`, `discordApiUrl.ts`,
  `discordGateway.ts`, `discordRateLimit.ts`, `interfaceRuntime.ts`, `runtimeConfig.ts`,
  `telegramAdapter.ts`, `telegramGateway.ts`, plus the extracted
  `src/interfaces/transportRuntime/` delivery subsystem.
- Conversation lifecycle and session flow: `ackStateMachine.ts`, `conversationCommandPolicy.ts`,
  `conversationDeliveryLifecycle.ts`, `conversationDraftStatusPolicy.ts`,
  `conversationExecutionInputPolicy.ts`, `conversationIngressLifecycle.ts`,
  `conversationManager.ts`, `conversationManagerHelpers.ts`,
  `conversationSessionMutations.ts`, `conversationWorkerLifecycle.ts`, `routingMap.ts`,
  `sessionStore.ts`, plus the extracted `src/interfaces/conversationRuntime/` persistence and
  pulse/helper plus delivery subsystem.
- Prompting, routing, and lexical classification: `checkpointReviewRouting.ts`,
  `contextualFollowupLexicalClassifier.ts`, `conversationClassifierEvents.ts`,
  `diagnosticsPromptPolicy.ts`, `followUpClassifier.ts`, `invocationHints.ts`,
  `invocationPolicy.ts`, `liveBuildVerificationPromptPolicy.ts`, `trustLexicalClassifier.ts`.
- Pulse, federation, and entity-graph runtime support: `agentPulseScheduler.ts`,
  `entityGraphRuntime.ts`, `federatedClient.ts`, `federatedServer.ts`, `federationRuntime.ts`,
  `pulseEmissionLifecycle.ts`, `pulseUxRuntime.ts`, `stage6_86UxRendering.ts`, with canonical
  pulse selection/prompt helpers now owned by `src/interfaces/conversationRuntime/`.
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
- `discordGateway.ts` and `telegramGateway.ts` remain the stable transport entrypoints even when
  outbound delivery helpers or autonomous progress bridges move into
  `src/interfaces/transportRuntime/`.
- `userFacingResult.ts` remains a stable thin entrypoint even when rendering details move deeper.
- `sessionStore.ts` remains the stable session entrypoint even when persistence details move into
  `src/interfaces/conversationRuntime/`.
- `agentPulseScheduler.ts` remains the stable pulse entrypoint even when provider filtering,
  contextual follow-up, prompt-building details, or scheduler contract/evaluation ownership move
  into `src/interfaces/conversationRuntime/`.
- `conversationManager.ts` remains the stable conversation manager entrypoint even when queue or
  ack lifecycle helpers, worker execution, pulse-state mutation, or canonical manager contracts
  move into
  `src/interfaces/conversationRuntime/`.
- `conversationDeliveryLifecycle.ts` remains the stable delivery entrypoint even when ack/final-
  delivery contract, preview, or persistence ownership moves into
  `src/interfaces/conversationRuntime/`.
- `conversationIngressLifecycle.ts` remains the stable ingress coordinator even when routing,
  invocation, command dispatch, stale-session recovery, proposal, or follow-up resolution moves into
  `src/interfaces/conversationRuntime/`.
- `sessionStore.ts`, `agentPulseScheduler.ts`, `conversationManager.ts`,
  `conversationDeliveryLifecycle.ts`, `discordGateway.ts`, and `telegramGateway.ts` are
  intentionally guarded by the module-size check so the top-level interface layer stays focused on
  stable coordination surfaces.
- Telegram and Discord adapters should share the same truthfulness and stop-summary contracts.
- Conversation lifecycle behavior should remain discoverable here rather than spread into unrelated
  transport helpers.

## Related Tests
- `tests/interfaces/userFacingResult.test.ts`
- `tests/interfaces/autonomousMessagePolicy.test.ts`
- `tests/interfaces/conversationCommandPolicy.test.ts`
- `tests/interfaces/conversationDeliveryLifecycle.test.ts`
- `tests/interfaces/sessionPersistence.test.ts`
- `tests/interfaces/transportRuntime.test.ts`
- `tests/interfaces/conversationWorkerRuntime.test.ts`
- `tests/interfaces/pulseState.test.ts`
- `scripts/evidence/interfaceAdvancedLiveSmoke.ts`

## When to Update This README
Update this README when:
- a top-level interface file is added, removed, or renamed
- ownership moves between transport lifecycle code, `src/interfaces/userFacing/`, and
  `src/interfaces/conversationRuntime/`
- ownership moves between the top-level gateways and `src/interfaces/transportRuntime/`
- autonomous progress or final-delivery bridge ownership moves between the top-level gateways and
  `src/interfaces/transportRuntime/`
- transport-facing rejection or retry policy ownership moves between the top-level gateways and
  `src/interfaces/transportRuntime/`
- connect/reconnect or Telegram poll-loop ownership moves between the top-level gateways and
  `src/interfaces/transportRuntime/`
- provider-specific inbound parse/validation or notifier wrapper ownership moves between the
  top-level gateways and `src/interfaces/transportRuntime/`
- accepted inbound conversation dispatch ownership moves between the top-level gateways and
  `src/interfaces/transportRuntime/`
- Telegram or Discord runtime wiring changes materially
- the related-test surface changes because interface responsibilities moved
