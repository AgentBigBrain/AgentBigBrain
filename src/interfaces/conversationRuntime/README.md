# Conversation Runtime

## Responsibility
This subsystem owns canonical interface session persistence plus the extracted conversation-runtime
implementation surfaces that should live below the stable top-level interface entrypoints.

The first extracted slice moved JSON and SQLite session persistence behind `sessionStore.ts` so the
top-level store can stay a stable coordination surface instead of mixing normalization and storage
plumbing in one file. `contracts.ts` owns the local persistence contracts plus the shared ingress
dependency contracts used by the extracted ingress helpers, and `sessionPersistence.ts` owns the
canonical JSON/SQLite helpers.

The next extracted slice moved Agent Pulse helper ownership here so `agentPulseScheduler.ts` can
stay the stable scheduler entrypoint while `pulseScheduling.ts`, `pulseContextualFollowup.ts`, and
`pulsePrompting.ts` own the canonical provider-filtering, contextual follow-up, and prompt-building
surfaces.

The latest Agent Pulse slice moved the scheduler's canonical contracts plus both evaluation paths
here so `agentPulseScheduler.ts` can stay a stable tick coordinator while:
- `pulseSchedulerContracts.ts` owns the canonical scheduler deps/config/state-update contracts
- `pulseEvaluation.ts` owns the canonical per-user legacy/dynamic evaluation routing
- `pulseDynamicEvaluation.ts` owns the canonical Stage 6.86 dynamic pulse evaluation path

The latest session-store slice moved canonical session-shape normalization, merge policy, and
shared Agent Pulse session metadata helpers here so `sessionStore.ts` can stay the stable session
contract and persistence entrypoint while:
- `sessionNormalization.ts` owns canonical session and state normalization
- `sessionMerging.ts` owns canonical session merge and deduplication policy
- `sessionPulseMetadata.ts` owns canonical recent-emission capping, timezone detection, user-style
  fingerprinting, and local-time resolution helpers

The latest slices moved queue/ack, worker-loop, and pulse-state ownership here so
`conversationManager.ts` can stay the stable conversation manager entrypoint while:
- `managerContracts.ts` owns the canonical conversation-manager contracts plus autonomous
  execution-input helpers used by extracted interface runtime modules and transport gateways
- `conversationLifecycle.ts` owns canonical ack-timer gating, queue insertion, and ack lifecycle
  transitions
- `deliveryContracts.ts` owns canonical ack/final-delivery contracts used by the stable delivery
  lifecycle entrypoint
- `deliveryPreview.ts` owns canonical editable/native final-message preview helpers
- `deliveryLifecycle.ts` owns canonical ack-timer persistence plus final-delivery outcome
  persistence below the stable `conversationDeliveryLifecycle.ts` entrypoint
- `conversationWorkerRuntime.ts` owns canonical system-job enqueue plus persisted worker-loop
  execution
- `pulseState.ts` owns canonical Agent Pulse session-state mutation
- `conversationRouting.ts` owns canonical `/chat` and free-form queue routing plus execution-input
  assembly below `conversationIngressLifecycle.ts`
- `invocationResolution.ts` owns canonical non-command invocation branching across pulse control,
  proposal follow-up, and queue routing below `conversationIngressLifecycle.ts`
- `commandDispatch.ts` owns canonical slash-command dispatch below `conversationIngressLifecycle.ts`
- `sessionRecovery.ts` owns canonical stale-running-job repair below
  `conversationIngressLifecycle.ts`
- `followUpResolution.ts` owns canonical proposal approval, proposal-reply interpretation, and
  model-assisted follow-up resolution below `conversationIngressLifecycle.ts`
- `contextualRecall.ts` owns canonical in-conversation contextual recall matching for active user
  turns below `conversationExecutionInputPolicy.ts`

## Inputs
- normalized conversation session payloads from `sessionStore.ts`
- JSON state paths and SQLite ledger paths from interface runtime wiring
- normalization callbacks supplied by the stable entrypoint
- recent-emission history, timezone text, and user-turn context from interface session flows
- pulse target-session state, contextual follow-up turns, and entity-graph inputs from
  `agentPulseScheduler.ts`
- scheduler deps/config/state-update contracts consumed by extracted pulse runtime helpers
- queue state, ack timers, and notifier capabilities from `conversationManager.ts`
- ack/final-delivery entrypoint contracts and notifier capabilities from
  `conversationDeliveryLifecycle.ts`
- Agent Pulse state-update patches from `conversationManager.ts`
- proposal/follow-up messages plus ingress dependencies from `conversationIngressLifecycle.ts`
- manager contract imports and autonomous execution helpers consumed by extracted runtime helpers
  and transport gateways

## Outputs
- persisted interface session snapshots in JSON and SQLite backends
- normalized session reads and listing behavior for interface runtime consumers
- deterministic bootstrap/import behavior when SQLite backends start from JSON snapshots
- canonical session normalization, merge policy, and Agent Pulse session metadata helpers for the
  stable session entrypoint and stable pulse scheduler entrypoint
- canonical pulse target-selection, contextual follow-up, and prompt-building helpers for the
  stable scheduler entrypoint
- canonical scheduler contracts plus legacy/dynamic user-evaluation helpers for the stable pulse
  scheduler entrypoint
- canonical conversation-manager contract and autonomous execution-input helpers for extracted
  runtime helpers and transport gateways
- canonical ack-timer persistence and final-delivery lifecycle helpers for the stable delivery
  lifecycle entrypoint
- canonical queue and ack-lifecycle helpers for the stable conversation manager entrypoint
- canonical system-job enqueue and queue-worker execution helpers for the stable manager entrypoint
- canonical Agent Pulse session-state persistence helpers for the stable manager entrypoint
- canonical `/chat` and free-form queue-routing helpers for the stable ingress entrypoint
- canonical non-command invocation-resolution helpers for the stable ingress entrypoint
- canonical slash-command dispatch helpers for the stable ingress entrypoint
- canonical stale-running-job recovery helpers for the stable ingress entrypoint
- canonical proposal approval and follow-up interpretation helpers for the stable ingress entrypoint
- canonical bounded in-conversation recall helpers for the stable execution-input entrypoint

## Invariants
- `sessionStore.ts` remains the stable public entrypoint for interface session contracts.
- `agentPulseScheduler.ts` remains the stable public entrypoint for Agent Pulse scheduling.
- Scheduler deps/config/state-update contracts here must preserve the public scheduler surface;
  extraction should only move canonical ownership, not change scheduler semantics.
- `conversationManager.ts` remains the stable public entrypoint and re-export surface even though
  canonical conversation-manager contract ownership now lives in this subsystem.
- `conversationDeliveryLifecycle.ts` remains the stable public entrypoint for ack/final-delivery
  behavior even though canonical delivery contracts and lifecycle ownership now live in this
  subsystem.
- Session normalization, merge, and shared Agent Pulse session metadata helpers here must preserve
  existing session semantics; extraction should only move ownership, not change persisted behavior.
- Storage helpers here must not change session semantics; they only persist, load, and bootstrap
  normalized session state.
- JSON and SQLite persistence must stay fail-closed and preserve deterministic ordering.
- Agent Pulse helpers here must preserve existing scheduling semantics; extraction should only move
  ownership, not change pulse behavior.
- User-facing proactive pulse delivery must emit only the final message body; internal reason codes,
  previews, and thread diagnostics belong in debug or diagnostic surfaces, not end-user messages.
- User-facing pulse prompts should sound natural; they may be truthful about AI identity when
  relevant, but must not prepend label-style openings like `AI assistant response:` or
  `AI assistant check-in:`.
- Conversation lifecycle helpers here must preserve queue and ack semantics; extraction should only
  move ownership, not change delivery or queue behavior.
- Worker-runtime helpers here must preserve job execution, heartbeat, and final-delivery semantics;
  extraction should only move ownership, not change queue behavior.
- Pulse-state helpers here must preserve persisted Agent Pulse semantics; extraction should only
  move mutation ownership, not change Pulse behavior.
- Conversation-routing helpers here must preserve `/chat` and free-form queue semantics; extraction
  should only move routing ownership, not change ingress behavior.
- Invocation-resolution helpers here must preserve pulse/follow-up/queue branching semantics;
  extraction should only move invocation ownership, not change ingress behavior.
- Command-dispatch helpers here must preserve slash-command semantics; extraction should only move
  command ownership, not change ingress behavior.
- Session-recovery helpers here must preserve stale-running-job repair semantics; extraction should
  only move recovery ownership, not change ingress behavior.
- Follow-up resolution helpers here must preserve proposal/follow-up semantics; extraction should
  only move ownership, not change ingress behavior.
- Contextual recall helpers here must stay bounded and optional; they may suggest one natural
  same-conversation follow-up, but must not turn into a separate proactive pulse path.

## Related Tests
- `tests/interfaces/sessionStore.test.ts`
- `tests/interfaces/sessionNormalization.test.ts`
- `tests/interfaces/sessionMerging.test.ts`
- `tests/interfaces/sessionPulseMetadata.test.ts`
- `tests/interfaces/sessionPersistence.test.ts`
- `tests/interfaces/agentPulseScheduler.test.ts`
- `tests/interfaces/pulseScheduling.test.ts`
- `tests/interfaces/pulseContextualFollowup.test.ts`
- `tests/interfaces/pulsePrompting.test.ts`
- `tests/interfaces/conversationLifecycle.test.ts`
- `tests/interfaces/conversationDeliveryLifecycle.test.ts`
- `tests/interfaces/conversationWorkerRuntime.test.ts`
- `tests/interfaces/pulseState.test.ts`
- `tests/interfaces/conversationRouting.test.ts`
- `tests/interfaces/invocationResolution.test.ts`
- `tests/interfaces/commandDispatch.test.ts`
- `tests/interfaces/sessionRecovery.test.ts`
- `tests/interfaces/followUpResolution.test.ts`
- `tests/interfaces/contextualRecall.test.ts`
- `tests/interfaces/managerContracts.test.ts`
- `tests/interfaces/conversationManager.test.ts`
- `scripts/evidence/interfaceAdvancedLiveSmoke.ts`

## When to Update This README
Update this README when:
- a new file is added to `src/interfaces/conversationRuntime/`
- ownership moves between `sessionStore.ts` and this subsystem
- ownership moves between `agentPulseScheduler.ts` and this subsystem
- scheduler contract ownership or legacy/dynamic evaluation ownership changes between
  `agentPulseScheduler.ts` and this subsystem
- ownership moves between `conversationManager.ts` and this subsystem
- ownership moves between `conversationDeliveryLifecycle.ts` and this subsystem
- canonical conversation-manager contract ownership or autonomous execution-input ownership changes
  between `conversationManager.ts` and this subsystem
- session persistence or bootstrap responsibilities change materially
- session normalization, session merge, timezone detection, or user-style fingerprint
  responsibilities change materially
- pulse target-selection, contextual follow-up, or pulse-prompt responsibilities change materially
- user-facing pulse suppression or pulse message-body rules change materially
- pulse identity or natural-language prompt rules change materially
- queue insertion, ack timers, or ack lifecycle responsibilities change materially
- ack/final-delivery contract, preview, or persistence responsibilities change materially
- system-job enqueue, worker execution, or pulse-state persistence responsibilities change
  materially
- `/chat` or free-form queue-routing responsibilities change materially
- non-command invocation-resolution responsibilities change materially
- slash-command dispatch responsibilities change materially
- stale-running-job recovery responsibilities change materially
- proposal approval, proposal-reply interpretation, or follow-up resolution responsibilities change
  materially
- in-conversation contextual recall matching or suppression rules change materially
- related test coverage changes because the conversation-runtime surface moved
