# Interfaces Layer

## Responsibility
This folder owns transport/runtime ingress, conversation lifecycle handling, interface-facing
classification or routing logic, and the stable composition entrypoint for user-facing result
rendering.

The extracted `src/interfaces/userFacing/` subsystem owns canonical wording surfaces, while
`src/interfaces/mediaRuntime/` owns bounded Telegram media envelopes, media-only input
normalization, and Telegram file-download helpers below the stable transport entrypoints.
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
wrapper helpers. It also now owns Telegram media-enrichment helpers plus the shared accepted-inbound
conversation dispatch path used by both gateways after provider-specific parse/validation succeeds.
This top-level folder owns the transport and lifecycle path that consumes both subsystems.

## Primary Files
- Transport entrypoints and runtime wiring: `discordAdapter.ts`, `discordApiUrl.ts`,
  `discordGateway.ts`, `discordRateLimit.ts`, `interfaceRuntime.ts`, `runtimeConfig.ts`,
  `telegramAdapter.ts`, `telegramGateway.ts`, plus the extracted
  `src/interfaces/mediaRuntime/` ingest subsystem and
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
- bounded media envelopes, media-only fallback input, and Telegram media-download helpers that feed
  the transport and conversation runtimes
- conversation routing decisions, prompt classification, and invocation hints
- transport-facing delivery behavior and session mutations
- canonical user-facing result composition through `userFacingResult.ts`
- user-facing proactive pulse messages that omit internal pulse/debug scaffolding
- active-conversation execution-input hints that can surface one bounded contextual recall when the
  user naturally re-mentions an older unresolved topic or concrete situation
- bounded pulse-grounding inputs so natural proactive follow-ups can reference useful unresolved
  situations without leaking raw memory internals
- private-only `/memory` command responses that let the user inspect, resolve, correct, or forget
  bounded remembered situations without exposing raw encrypted-store internals

## Invariants
- Transport lifecycle logic should stay at this top level; wording logic should stay in
  `src/interfaces/userFacing/`.
- Media-only Telegram messages should remain first-class bounded requests; they must not be dropped
  just because `text` is empty.
- Voice notes may promote explicit `command <name>` transcripts into slash-command behavior, but
  that promotion must stay voice-only and narrow enough to avoid false positives in ordinary
  speech.
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
- Invocation gating should stay fail-closed, but it may accept bounded human vocatives like
  `Hi BigBrain` in addition to direct alias prefixes.
- In private one-to-one Telegram chats, explicit `BigBrain` name-calls may be optional by default;
  group/public chats should still require the alias fail-closed.
- User-facing proactive pulse delivery must not leak internal reason codes, preview envelopes, or
  raw thread-context diagnostics.
- User-facing pulse or recall copy may be truthful about AI identity when relevant, but should not
  use label-style openings like `AI assistant response:` or `AI assistant check-in:`.
- User-facing replies should not volunteer AI identity in ordinary greetings or casual replies;
  mention it only when the user directly asks, a safety/capability boundary requires it, or it
  materially changes the answer.
- General user-facing replies should also strip any accidental label-style openings from model
  output before final delivery.
- Persisted assistant turns and prompt-context replays should strip the same label-style openings so
  stale history does not keep teaching the model robotic phrasing.
- User-facing pulse grounding may use bounded unresolved-situation summaries, but it must not leak
  raw memory internals or turn pulse delivery into a memory dump.
- Active-conversation contextual recall should stay inline and optional; it must not turn into a
  second proactive outreach channel.
- Active-conversation contextual recall should prefer concrete unresolved situations backed by
  bounded episodic memory over generic paused-topic overlap when both are available.
- Future human-centric proactive follow-up scoring should live in a bounded runtime such as
  `src/interfaces/proactiveRuntime/`, not by loosening generic pulse heuristics inside unrelated
  transport or delivery code.
- User-facing conversational language upgrades should prefer specific, useful follow-ups and
  suppression over broader interruption frequency.
- User-facing remembered-situation review must stay private-only, bounded, and explicit about what
  is remembered versus later corrected or forgotten.
- User-facing remembered-situation mutation flows must be explicit about whether a situation was
  marked resolved, marked wrong, or forgotten; they must not hide memory changes behind vague
  confirmation text.
- Conversation lifecycle behavior should remain discoverable here rather than spread into unrelated
  transport helpers.

## Related Tests
- `tests/interfaces/userFacingResult.test.ts`
- `tests/interfaces/autonomousMessagePolicy.test.ts`
- `tests/interfaces/conversationCommandPolicy.test.ts`
- `tests/interfaces/conversationDeliveryLifecycle.test.ts`
- `tests/interfaces/mediaContextRendering.test.ts`
- `tests/interfaces/memoryReviewCommand.test.ts`
- `tests/interfaces/sessionPersistence.test.ts`
- `tests/interfaces/transportRuntime.test.ts`
- `tests/scripts/mediaIngestExecutionIntentLiveSmoke.test.ts`
- `tests/interfaces/conversationWorkerRuntime.test.ts`
- `tests/interfaces/pulseState.test.ts`
- `scripts/evidence/interfaceAdvancedLiveSmoke.ts`

## When to Update This README
Update this README when:
- a top-level interface file is added, removed, or renamed
- ownership moves between transport lifecycle code, `src/interfaces/userFacing/`, and
  `src/interfaces/conversationRuntime/`
- ownership moves between the top-level transport entrypoints and `src/interfaces/mediaRuntime/`
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
- Telegram private-chat invocation or public-chat alias rules change materially
- Telegram or Discord runtime wiring changes materially
- Telegram media-ingest parsing, media-only fallback input, or bounded media-context rendering
  changes materially
- voice-only command promotion from Telegram transcripts changes materially
- user-facing proactive pulse rendering or suppression rules change materially
- user-facing pulse identity/natural-language rules change materially
- user-facing AI-identity mention rules change materially
- assistant-turn storage or prompt-context sanitization rules change materially
- bounded unresolved-situation pulse-grounding rules change materially
- in-conversation contextual recall rules change materially
- episodic-memory-backed conversation recall wiring changes materially
- remembered-situation review or mutation command behavior changes materially
- the related-test surface changes because interface responsibilities moved
