# Transport Runtime

## Responsibility
This subsystem owns canonical outbound transport delivery, notifier-construction helpers,
autonomous progress-delivery bridges, and shared gateway lifecycle helpers for the stable Discord
and Telegram gateway entrypoints.

The current extracted slice moves notifier wiring, autonomous progress bridging, and platform
send/edit/draft delivery behind:
- `autonomousAbortControl.ts`
- `contracts.ts`
- `deliveryLifecycle.ts`
- `inboundDispatch.ts`
- `telegramConversationDispatch.ts`
- `discordGatewayRuntime.ts`
- `discordTransport.ts`
- `gatewayLifecycle.ts`
- `rateLimitPolicy.ts`
- `telegramGatewayObservation.ts`
- `telegramGatewayRuntime.ts`
- `telegramTransport.ts`

The top-level gateway entrypoints still own conversation-manager orchestration and provider-specific
runtime state. Provider-specific inbound payload parsing/validation plus notifier/send-edit wrapper
ownership now lives here, and the shared accepted-inbound conversation dispatch path now also lives
here.

## Inputs
- normalized outbound user-facing text from the gateway entrypoints
- platform bot tokens, API base URLs, and bound channel/chat identifiers
- notifier capability decisions from `discordGateway.ts` and `telegramGateway.ts`
- autonomous progress callbacks emitted by governed adapter runs
- adapter validation codes used to decide whether transport-facing reject summaries should be sent
- platform-specific retry helpers already owned by the top-level interfaces layer

## Outputs
- canonical `ConversationNotifierTransport` instances for Discord and Telegram
- canonical autonomous progress send/edit/stream delivery behavior
- canonical explicit autonomous stop and abort-controller helpers shared by Discord and Telegram
  transport runtimes
- canonical transport-facing reject-notification policy for shared adapter validation codes
- canonical Discord socket attach/connect helper policy, hello/identify payload handling, and
  shared dispatch routing helpers
- canonical Telegram poll-loop helpers
- canonical provider-specific inbound payload parsing/validation helpers for Discord and Telegram
- canonical provider-specific gateway notifier/send-edit wrapper helpers for Discord and Telegram
- canonical Telegram outbound-delivery observation helpers used by live-smoke instrumentation
- canonical Telegram media-enrichment and conversation-key chat-id helpers used before shared
  conversation dispatch
- canonical accepted inbound conversation dispatch, autonomous/text task routing, and final reply
  delivery helpers shared by Discord and Telegram gateways
- deterministic Discord send/edit delivery results
- deterministic Telegram send/edit/draft delivery results

## Invariants
- `discordGateway.ts` and `telegramGateway.ts` remain the stable transport entrypoints.
- Extraction here must preserve existing Telegram and Discord delivery behavior; this subsystem only
  changes ownership, not product semantics.
- Autonomous progress delivery must preserve the existing send-first, edit-when-possible, and
  native-streaming semantics already used by the gateways.
- Shared reject-notification policy here must preserve existing gateway behavior; extraction should
  only move ownership, not change when validation rejections send user-facing summaries.
- Shared gateway-lifecycle helpers here must preserve existing socket/dispatched-event semantics;
  extraction should only move ownership, not change gateway behavior.
- Shared reconnect and poll-loop helpers here must preserve existing retry cadence and shutdown
  behavior; extraction should only move ownership, not change runtime behavior.
- Provider-specific inbound parse/validation helpers here must preserve existing accept/reject/stop
  behavior; extraction should only move ownership, not change gateway semantics.
- Telegram private one-to-one chats may accept plain text without an explicit `BigBrain` alias, but
  group/public chats must keep the name-call requirement fail-closed.
- Shared accepted-inbound dispatch helpers here must preserve existing entity-graph mutation,
  autonomous routing, conversation-manager execution, and final-send behavior; extraction should
  only move ownership, not change gateway semantics.
- Discord notifier wiring must preserve the existing edit callback surface used by autonomous
  progress consolidation.
- Telegram notifier wiring must preserve existing native draft-stream fallback behavior.

## Related Tests
- `tests/interfaces/discordGateway.test.ts`
- `tests/interfaces/telegramGateway.test.ts`
- `tests/interfaces/transportRuntime.test.ts`
- `scripts/evidence/interfaceAdvancedLiveSmoke.ts`

## When to Update This README
Update this README when:
- a new file is added to `src/interfaces/transportRuntime/`
- ownership moves between the top-level gateways and this subsystem
- autonomous progress or final-delivery bridge ownership moves between the gateways and this
  subsystem
- transport-facing rejection or retry policy ownership moves between the gateways and this
  subsystem
- socket hello/identify or shared dispatch-routing ownership moves between the gateways and this
  subsystem
- reconnect or Telegram poll-loop ownership moves between the gateways and this subsystem
- provider-specific inbound payload parsing/validation ownership moves between the gateways and this
  subsystem
- Telegram private-chat invocation or public-chat name-call rules change materially
- accepted inbound conversation dispatch ownership moves between the gateways and this subsystem
- provider-specific notifier/send-edit wrapper ownership moves between the gateways and this
  subsystem
- Telegram media-enrichment or conversation-key chat-id helper ownership moves between the gateway
  entrypoints and this subsystem
- Discord or Telegram notifier capability behavior changes materially
- outbound Discord or Telegram send/edit/draft behavior changes materially
- related test coverage changes because the transport-runtime surface moved
