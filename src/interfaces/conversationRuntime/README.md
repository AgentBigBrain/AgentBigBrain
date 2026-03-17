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
- `sessionStateContracts.ts` owns the canonical typed session-shape contracts that `sessionStore.ts`
  now re-exports as its stable public surface
- `sessionNormalization.ts` owns canonical session and state normalization
- `sessionNormalizationRecords.ts` owns the canonical record-level normalization helpers used by the
  stable session-normalization entrypoint
- `sessionNormalizationOwnershipRecords.ts` owns the extracted browser, path, workspace, and
  classifier normalization helpers reused by the stable record-normalization entrypoint
- `sessionPulseNormalization.ts` owns canonical Agent Pulse session-state normalization below the
  stable session-normalization entrypoint
- `sessionMerging.ts` owns canonical session merge and deduplication policy
- `sessionMergeStateSelection.ts` owns extracted clarification, progress, and durable handoff
  state-selection helpers reused by the stable session-merge entrypoint
- `workspaceMerge.ts` owns canonical active-workspace merge selection below the stable session
  merge entrypoint
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
- `conversationWorkerRuntimeSnapshots.ts` owns best-effort live browser/process snapshot
  collection so completed worker turns can reconcile persisted workspace and browser ownership
  state against current runtime truth before final handoff and delivery
- `conversationWorkerProgressText.ts` owns canonical human-first queued-worker progress phrasing so
  the worker can say `building the page`, `organizing the folders`, or `closing the preview`
  instead of echoing the raw request text back to the user
- `conversationWorkerAutoRecovery.ts` owns bounded exact-tracked post-execution auto-retry for
  worker-managed local folder recovery so the worker loop stays thin
- `conversationWorkerAutoRecoverySupport.ts` owns the extracted path-overlap, marker, retry-input,
  and assistant-turn replacement helpers reused by the stable worker auto-recovery entrypoint
- `conversationNotifierTransport.ts` owns canonical notifier-shape normalization so the worker
  runtime can stay focused on queue control instead of transport-shape coercion
- `conversationWorkerProgressPersistence.ts` owns canonical persistence of structured autonomous
  progress states emitted by the execution runtime so session recall and later status queries can
  distinguish between starting, retrying, verifying, completed, and stopped work instead of
  flattening everything into generic `working`
- `pulseState.ts` owns canonical Agent Pulse session-state mutation
- `conversationRouting.ts` owns canonical `/chat` and free-form queue routing plus execution-input
  assembly below `conversationIngressLifecycle.ts`
- `conversationRoutingSupport.ts` owns small extracted confidence and autonomous-brief helpers so
  the stable conversation-routing entrypoint can stay within its size budget
- `conversationRoutingQueueSupport.ts` owns the extracted follow-up-linked queue enqueue helper so
  the stable conversation-routing entrypoint can stay within its size budget without duplicating
  continuity-aware enqueue logic
- `invocationResolution.ts` owns canonical non-command invocation branching across pulse control,
  proposal follow-up, and queue routing below `conversationIngressLifecycle.ts`
- `commandDispatch.ts` owns canonical slash-command dispatch below `conversationIngressLifecycle.ts`
- `sessionRecovery.ts` owns canonical stale-running-job repair below
  `conversationIngressLifecycle.ts`
- `executionIntentClarification.ts` owns canonical plan/build/execute-now clarification rules below
  `conversationRouting.ts`
- `followUpResolution.ts` owns canonical proposal approval, proposal-reply interpretation, and
  model-assisted follow-up resolution below `conversationIngressLifecycle.ts`
- `mediaContextRendering.ts` owns canonical bounded execution-input rendering for interpreted media
  context below `conversationExecutionInputPolicy.ts`
- `contextualRecall.ts` owns canonical in-conversation contextual recall matching for active user
  turns below `conversationExecutionInputPolicy.ts`
- `contextualRecallSupport.ts` owns shared tokenization, cue-building, duplicate-suppression, and
  episodic/paused-thread candidate assembly used by bounded contextual recall
- `contextualRecallRanking.ts` owns canonical prioritization between generic paused-thread recall
  and concrete unresolved-situation recall backed by episodic memory
- `memoryReviewCommand.ts` owns the bounded private `/memory` review and mutation command surface
  below `commandDispatch.ts`
- `memoryReviewRendering.ts` owns the canonical user-facing rendering for remembered-situation
  review and mutation responses, including explicit resolve, wrong, and forget outcomes
- `intentModeContracts.ts` owns the canonical front-door intent-mode contracts for natural
  execution, capability discovery, and clarification results
- `intentModeResolution.ts` owns canonical deterministic intent-mode routing plus the optional
  local intent-model seam used when deterministic confidence stays weak
- `executionPreferenceExtraction.ts` owns canonical extraction of plan/build-now, natural skill
  discovery, and presentation preferences like `leave it open`
- `capabilityIntrospection.ts` owns canonical truthful capability summaries for natural questions
  like `what can you do here?` or `why can't you do that?`
- `capabilityIntrospectionRendering.ts` owns canonical user-facing capability and skill-discovery
  rendering used by natural front-door discovery replies, plus the bounded execution input used
  when the direct conversation runtime should answer capability questions in a more natural voice
- `directConversationReply.ts` owns the bounded direct-conversation helper that lets the runtime
  synthesize ordinary conversational replies without queueing background work or fabricating task
  progress
- `conversationRoutingDirectReplies.ts` owns the extracted casual-chat and capability-discovery
  direct-reply helpers reused by the stable conversation-routing entrypoint so ordinary
  conversation and normal capability checks can stay out of the worker queue
- `presentationPreferenceResolution.ts` owns canonical user-facing presentation preference families
  such as `keep it open`, `show it later`, and `run it locally`
- `routingPrecedence.ts` owns the canonical ordering between slash commands, voice `command <name>`
  promotion, active clarification, proposal follow-up, natural intent routing, and media-only
  fallback
- `clarificationBroker.ts` owns canonical persisted clarification state creation, one-turn answer
  resolution, and clarified execution-input rebuilding
- `clarificationState.ts` owns canonical active-clarification state guards used by routing helpers
- `taskRecoveryClarification.ts` owns canonical post-execution recovery clarifications for
  recoverable blocked runs such as locked local folder-organization requests
- `modeContinuity.ts` owns canonical sticky working-mode promotion so natural follow-ups like
  `go ahead`, `same place as before`, or `use the same approach` can stay inside the current safe
  build/review/autonomous mode without making the user restate it every turn
- `returnHandoff.ts` owns canonical durable work-handoff checkpoints so the session can answer
  return questions like `what is ready?`, `what did you get done?`, or `pick that back up`
- `returnHandoffControl.ts` owns canonical natural pause and while-you-were-away checkpoint helpers
  so phrases like `leave the rest for later` or `what changed while I was away?` can mutate or
  review the same durable handoff state without queueing unnecessary work, and can now also stop
  an in-flight autonomous run through the real gateway abort path before the worker settles the
  paused checkpoint
- `returnHandoffContinuation.ts` owns canonical session-aware resume detection and continuation
  grounding so phrases like `pick that back up` or `continue from there` can continue prior work
  from the durable handoff checkpoint instead of restarting from scratch
- `recentActionLedger.ts` owns canonical recent-action and progress recall so questions like `what
  did you just do?`, `where did you put it?`, and `what are you waiting on from me?` can resolve
  from typed session state instead of queue wording alone
- `recentActionLedgerMetadataHelpers.ts` owns extracted metadata parsing and label helpers reused by
  the stable recent-action ledger entrypoint so the entrypoint can stay within its module-size
  budget while still handling linked browser cleanup and other typed execution metadata
- `recentActionLedgerRendering.ts` owns small shared rendering helpers used by recent-action,
  browser, path, and workspace recall surfaces
- `pathDestinationContext.ts` owns canonical execution-input grounding for remembered save/open
  locations like `my desktop` or `the same place as before`
- `reuseIntentContext.ts` owns canonical execution-input grounding for natural reuse phrasing like
  `use the same approach as before` or `do it the same way again`
- `workspaceRecoveryContext.ts` owns canonical organization-recovery grounding for current tracked
  workspace state, exact preview-holder affordances, and managed-preview fallback hints below
  `conversationExecutionInputPolicy.ts`
- `executionInputRuntimeOwnership.ts` owns canonical live-runtime reconciliation for persisted
  browser/workspace ownership during execution-input assembly, including `file://` preview-derived
  workspace envelopes when static local previews were tracked without an explicit persisted root
- `workspaceRecoveryRoots.ts` owns attributable workspace-root selection and explanation reused by
  the stable workspace-recovery context entrypoint so broader stale-work attribution can grow
  without re-bloating that entrypoint

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
- bounded continuity-episode query results supplied by transport/runtime wiring for active-turn
  episodic recall
- bounded freshness-ranked unresolved-situation summaries supplied by profile-memory pulse
  evaluation for natural pulse grounding
- optional local intent-model resolver callbacks supplied by interface wiring when the repo enables
  richer local intent understanding

## Outputs
- persisted interface session snapshots in JSON and SQLite backends
- normalized session reads and listing behavior for interface runtime consumers
- deterministic bootstrap/import behavior when SQLite backends start from JSON snapshots
- canonical session normalization, merge policy, and Agent Pulse session metadata helpers for the
  stable session entrypoint and stable pulse scheduler entrypoint
- canonical extracted clarification/progress/return-handoff state-selection helpers reused by the
  stable session-merge entrypoint
- canonical active-workspace merge selection so tracked project continuity survives session writes
  and follow-up turns
- canonical workspace-ownership state so the session can say which browser sessions, preview
  leases, pids, and control affordances still belong to the current or stale project workspace
- canonical browser-session workspace-root persistence so detached or older browser-only assistant
  work can still stay attributable to the right project folder after preview-process churn
- canonical active-workspace control-state derivation so remembered preview lease ids from earlier
  assistant work can still support attribution and recovery grounding without being overstated as
  live controllable preview holders after the session already recorded them as stopped
- canonical typed session contracts plus record-level normalization helpers for the stable session
  store and stable session-normalization entrypoints
- canonical extracted browser/path/workspace/classifier normalization helpers used below the stable
  session-normalization entrypoint
- canonical pulse target-selection, contextual follow-up, and prompt-building helpers for the
  stable scheduler entrypoint
- canonical bounded unresolved-situation pulse grounding so useful older situations can inform a
  pulse prompt without leaking raw memory internals to the user
- canonical scheduler contracts plus legacy/dynamic user-evaluation helpers for the stable pulse
  scheduler entrypoint
- canonical conversation-manager contract and autonomous execution-input helpers for extracted
  runtime helpers and transport gateways
- canonical ack-timer persistence and final-delivery lifecycle helpers for the stable delivery
  lifecycle entrypoint
- canonical queue and ack-lifecycle helpers for the stable conversation manager entrypoint
- canonical system-job enqueue and queue-worker execution helpers for the stable manager entrypoint
- canonical worker-owned live browser/process snapshot collection so completed turns can persist
  reconciled browser-session and active-workspace control state instead of lagging behind the live
  runtime by one turn
- canonical human-first queued-worker progress narration so session state and long-running worker
  updates can describe the active job in calmer typed terms instead of reflecting the raw user
  prompt back at them
- canonical structured autonomous progress persistence so the session can remember when `/auto` is
  starting, retrying, verifying, completed, or stopped instead of only generic working/waiting
  states
- canonical bounded exact-tracked post-execution auto-retry so normal build-mode runs can retry
  once without making the user confirm a holder shutdown the runtime can already prove
- canonical bounded post-shutdown organization retry so a confirmed recovery pass that already
  stopped exact tracked preview holders will automatically re-run the original move and verify the
  destination instead of ending on a weak inspection-only summary
- canonical extracted tracked-workspace auto-recovery helpers for overlap checks, retry markers,
  retry-input assembly, and summary replacement below the stable worker auto-recovery entrypoint
- canonical Agent Pulse session-state persistence helpers for the stable manager entrypoint
- canonical `/chat` and free-form queue-routing helpers for the stable ingress entrypoint
- canonical small routing-support helpers reused by the stable conversation-routing entrypoint
- canonical extracted follow-up-linked queue enqueue helper reused by both `/chat` and free-form
  routing so short continuity turns do not duplicate continuity-aware enqueue logic
- canonical non-command invocation-resolution helpers for the stable ingress entrypoint
- canonical slash-command dispatch helpers for the stable ingress entrypoint
- canonical stale-running-job recovery helpers for the stable ingress entrypoint
- canonical plan/build/execute-now clarification helpers for the stable routing entrypoint
- canonical proposal approval and follow-up interpretation helpers for the stable ingress entrypoint
- canonical bounded media-context rendering helpers for the stable execution-input entrypoint
- canonical bounded in-conversation recall helpers and ranking for the stable execution-input
  entrypoint
- canonical bounded remembered-situation review and mutation command helpers for the stable ingress
  command path
- canonical user-facing `/memory` list/help plus resolve, wrong, and forget rendering for the
  stable ingress command path
- canonical front-door intent-mode contracts and resolution helpers for natural build/review/plan,
  capability discovery, and active clarification
- canonical bounded local-intent session hints and semantic handoff cues so nuanced review, saved
  work explanation, softer draft-check-in questions, anything-else-to-review prompts, review-next
  phrasing, wrap-up summaries, and resume phrasing can reuse durable checkpoint state without
  widening the deterministic phrase shell
- canonical execution preference extraction and presentation-preference resolution for natural
  phrases like `plan it first`, `build it now`, `leave it open`, or `show it later`
- canonical capability-introspection summaries and rendering so natural capability questions can
  return practical environment limits plus reusable skill inventory
- canonical direct-conversation reply helpers so ordinary conversation and natural capability
  checks can be answered inline instead of starting governed work
- canonical routing precedence and active-clarification brokers so the front door can stay
  stateful instead of relying on disposable prompts
- canonical post-execution recovery clarifications so recoverable blocked runs can ask one short
  follow-up question instead of ending in a dead-end failure
- canonical recovery-option shaping so exact tracked holder evidence can ask for shutdown-and-retry,
  inspect-first recovery can ask to continue narrow inspection, and stale-only findings can explain
  the blocker without pretending a shutdown confirmation still makes sense
- canonical mode-continuity promotion for natural continuation phrases that should stay inside the
  current working mode
- canonical recent-action and progress recall so users can ask what just happened, where something
  was put, or what the runtime is waiting on
- canonical linked-browser cleanup recall so stop-process cleanup can persist closed browser
  windows into session state instead of leaving the workspace falsely remembered as still open
- canonical shared rendering helpers for recent-action, browser, path, and workspace recall lines
- canonical path-destination and reuse context blocks so remembered locations and prior successful
  approaches can be carried into safe execution input naturally
- canonical durable return-handoff checkpoints so later resume/review turns can use a typed summary
  of the last meaningful completed work instead of reconstructing everything from raw history
- canonical natural pause and while-you-were-away checkpoint helpers so users can intentionally
  leave work for later or review what changed while away from the same durable handoff record
- canonical session-aware return-handoff continuation helpers so natural resume turns can continue
  prior work from the durable checkpoint instead of falling back to generic chat or restart flows
- canonical stale/orphaned workspace wording so remembered locations and recall surfaces stay
  truthful when earlier assistant work is no longer current or directly controllable
- canonical workspace-recovery context blocks so organization follow-ups can hand the planner exact
  tracked workspace, remembered attributable roots, preview-holder, and inspect-first recovery
  facts instead of relying on token hints alone

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
- Active-workspace merge selection here must preserve the newest continuity snapshot while
  backfilling missing project-root, preview, artifact, browser/process ownership, and control-state
  fields instead of dropping them on a later partial update.
- Recent-action ledger derivation here must preserve typed linked-browser cleanup emitted by exact
  runtime stop-process actions so session browser ledgers and active workspace state stay truthful
  after preview-holder cleanup.
- Browser-session persistence here must preserve workspace-root ownership metadata alongside linked
  preview-process metadata so stale browser-only assistant work can still ground later recovery and
  cleanup flows without pretending live control still exists.
- Workspace ownership here must distinguish between tracked, stale, and orphaned project state so
  later autonomy or follow-up control does not have to infer ownership from free-form summaries.
- Active-workspace continuity here must not treat remembered preview lease ids as live control by
  default. If the session's own process/browser ledgers already show those preview resources as
  stopped or closed, the workspace must downgrade to stale or orphaned truthfully instead of
  remaining tracked just because old ids were preserved for attribution.
- Durable return-handoff state here must remain a truthful checkpoint of finished or blocked work;
  it must not invent readiness, completion, or next-step claims beyond what the run actually
  persisted.
- Return-handoff continuation here must stay grounded in the durable checkpoint plus current
  workspace state; it must not silently restart or fabricate a new mission when the user only
  wants explanation or review of saved work.
- Semantic handoff cues here must remain meaning-only. They can improve review, explain, or resume
  routing, but they cannot authorize risky execution, holder shutdown, or cross-workspace access.
  asked to continue prior work.
- Natural pause and "while I was away" handling here must stay truthful to the stored checkpoint;
  it may preserve or review the handoff, but it must not invent unseen work or imply that active
  in-flight execution was safely interrupted if the runtime did not actually stop it.
- Storage helpers here must not change session semantics; they only persist, load, and bootstrap
  normalized session state.
- JSON and SQLite persistence must stay fail-closed and preserve deterministic ordering.
- Agent Pulse helpers here must preserve existing scheduling semantics; extraction should only move
  ownership, not change pulse behavior.
- User-facing proactive pulse delivery must emit only the final message body; internal reason codes,
  previews, and thread diagnostics belong in debug or diagnostic surfaces, not end-user messages.
- User-facing pulse prompts should sound natural; they may be truthful about AI identity when
  relevant, but must not prepend label-style openings like `AI assistant response:` or
  `AI assistant check-in:` and should not volunteer AI identity in ordinary greetings or casual
  replies.
- Stored assistant turns and recent-conversation prompt context must also strip robotic label-style
  openings like `AI assistant response:` or `AI assistant answer:` so stale history does not
  reintroduce unnatural phrasing into later model turns.
- User-facing pulse grounding may use bounded unresolved-situation summaries, but it must not leak
  raw episode ids or private memory internals into the user-visible message body.
- Conversation lifecycle helpers here must preserve queue and ack semantics; extraction should only
  move ownership, not change delivery or queue behavior.
- Worker-runtime helpers here must preserve job execution, heartbeat, and final-delivery semantics;
  extraction should only move ownership, not change queue behavior.
- Structured autonomous progress persistence here must stay truthful: active states may be updated
  during a run, but terminal `completed` or `stopped` state must never be fabricated if the
  runtime did not emit it.
- Human-first queued-worker progress narration here must stay descriptive but meaning-light. It may
  categorize already-running work for user-facing progress updates, but it must not participate in
  routing, authorization, or recovery decisions.
- Direct-conversation reply helpers here must stay bounded to ordinary conversation and capability
  discovery. They may improve natural user-facing phrasing, but they must not silently authorize
  task execution or bypass the governed worker path for real side effects.
- Exact-tracked worker auto-retry must stay bounded to one automatic retry lane, must only use
  exact proven preview-holder evidence, and must not bypass clarification when the runtime only
  has likely untracked holder candidates.
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
- Execution-intent clarification helpers here must preserve direct `execute now` / `build this
  now` support while asking at most one short clarification when the user stays ambiguous.
- Follow-up resolution helpers here must preserve proposal/follow-up semantics; extraction should
  only move ownership, not change ingress behavior.
- Media-context rendering here must stay bounded, interpreted, and text-based; it must not leak raw
  bytes or become a generic multimodal transport envelope downstream.
- Contextual recall helpers here must stay bounded and optional; they may suggest one natural
  same-conversation follow-up, but must not turn into a separate proactive pulse path.
- Contextual recall should prefer concrete unresolved situations linked through episodic memory
  over generic paused-topic overlap when that situation is available, recent, and not repetitious.
- Contextual recall should suppress bare repeated-name revivals when the current turn lacks a real
  recall cue; a name mention alone is not enough to reopen an older unresolved situation.
- Contextual recall may still surface without an explicit canned recall phrase when the current
  turn has strong direct overlap with a concrete unresolved situation (for example, re-mentioning
  both the person and the distinctive situation detail), but weak one-term overlap should remain
  suppressed.
- Shared tokenization, stop-wording, and recall-term extraction should converge on canonical
  `src/core/languageRuntime/` helpers instead of drifting across local recall helpers; local
  helpers here should stay focused on recall-specific cue assembly and suppression policy.
- Future proactive utility scoring should live in a bounded dedicated runtime rather than being
  smuggled into contextual recall or generic pulse heuristics here.
- Remembered-situation review and mutation commands here must stay private-only, bounded, and
  brokered; they must not expose raw encrypted-store internals or bypass approval-aware reads.
- Remembered-situation mutation commands here must remain explicit about the action taken
  (`resolved`, `wrong`, `forgotten`) and must not silently rewrite memory.
- The conversation front door must have one canonical intent seam. Slash commands, voice
  `command <name>` promotion, active clarification, proposal/review follow-up, and natural
  execution intent should converge through the same precedence model rather than drifting into
  parallel routers.
- Clarification here must be session-backed state, not a disposable one-off prompt. If the runtime
  asks the user to choose between planning, building, or explaining, that waiting state must
  survive the next turn until it is answered or cleared.
- Recoverable blocked runs here may ask one short shutdown-and-retry clarification when the
  runtime has a truthful next step, but they must stay fail-closed and never claim the retry
  already happened.
- Recovery clarification options here must match the runtime's actual proof state. Exact tracked
  holders may offer shutdown-and-retry, inspect-first recovery may offer continue-inspection, and
  stale-only findings must not ask the user to approve a shutdown the runtime can no longer prove.
- The optional local intent-model seam must stay fail-closed and subordinate to deterministic safe
  routing. It can improve weak front-door understanding, but it must never become a second planner.
- Mode continuity must only promote natural follow-ups when the session already has a strong active
  mode and the current wording still points at the same work; it must not silently override a new
  explicit intent.
- Recent-action and progress recall must prefer typed artifact/progress state over job-summary text
  so user-facing answers stay concrete and trustworthy.
- Workspace/location recall here must not overstate stale or orphaned assistant work as if it were
  still the current controlled project.
- Path-destination and reuse context should enrich safe execution input, not bypass path
  constraints, artifact ledgers, or clarification when scope is still ambiguous.

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
- `tests/interfaces/conversationWorkerProgressText.test.ts`
- `tests/interfaces/pulseState.test.ts`
- `tests/interfaces/conversationRouting.test.ts`
- `tests/interfaces/invocationResolution.test.ts`
- `tests/interfaces/commandDispatch.test.ts`
- `tests/interfaces/sessionRecovery.test.ts`
- `tests/interfaces/followUpResolution.test.ts`
- `tests/interfaces/mediaContextRendering.test.ts`
- `tests/interfaces/contextualRecall.test.ts`
- `tests/interfaces/conversationExecutionInputPolicy.test.ts`
- `tests/interfaces/clarificationBroker.test.ts`
- `tests/interfaces/conversationWorkerLifecycle.test.ts`
- `tests/interfaces/memoryReviewCommand.test.ts`
- `tests/interfaces/recentActionLedger.test.ts`
- `tests/interfaces/intentModeResolution.test.ts`
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
- bounded unresolved-situation pulse-grounding responsibilities change materially
- user-facing pulse suppression or pulse message-body rules change materially
- pulse identity or natural-language prompt rules change materially
- AI-identity mention rules for pulse or conversational prompts change materially
- assistant-turn storage or recent-context sanitization rules change materially
- queue insertion, ack timers, or ack lifecycle responsibilities change materially
- ack/final-delivery contract, preview, or persistence responsibilities change materially
- system-job enqueue, worker execution, or pulse-state persistence responsibilities change
  materially
- queued-worker progress narration responsibilities change materially
- `/chat` or free-form queue-routing responsibilities change materially
- conversation-routing support helper ownership changes materially
- non-command invocation-resolution responsibilities change materially
- slash-command dispatch responsibilities change materially
- stale-running-job recovery responsibilities change materially
- execution-intent clarification responsibilities change materially
- active clarification state shape, precedence, or answer-resolution behavior changes materially
- post-execution recovery-clarification behavior changes materially
- recovery-option wording or option selection changes materially
- canonical intent-mode resolution, execution-preference extraction, or presentation-preference
  families change materially
- capability-introspection summary or capability/skill discovery rendering responsibilities change
  materially
- direct-conversation reply ownership or the ordinary-conversation/capability-discovery
  queue-bypass rules
  change materially
- the optional local intent-model seam or its fail-closed routing rules change materially
- mode-continuity promotion rules or active-mode carry-forward behavior change materially
- proposal approval, proposal-reply interpretation, or follow-up resolution responsibilities change
  materially
- bounded media-context rendering responsibilities change materially
- recent-action or progress recall behavior changes materially
- return-handoff pause or while-you-were-away review responsibilities change materially
- return-handoff continuation detection or continuation-grounding responsibilities change materially
- stale/orphaned workspace wording or remembered-destination caution rules change materially
- remembered save/open destination or natural reuse context responsibilities change materially
- in-conversation contextual recall matching or suppression rules change materially
- bare repeated-name suppression or recall-cue requirements change materially
- the strong direct-overlap threshold for bounded contextual recall changes materially
- contextual recall ranking or continuity-episode query usage changes materially
- remembered-situation review or mutation command responsibilities change materially
- remembered-situation rendering or privacy rules change materially
- related test coverage changes because the conversation-runtime surface moved
