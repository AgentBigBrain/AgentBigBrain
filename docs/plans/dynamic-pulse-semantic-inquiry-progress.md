# Dynamic Pulse Semantic Inquiry Progress

Do not store private conversation text, raw Source Recall chunks, local desktop paths, secrets,
provider payloads, Telegram/Discord identifiers, full model prompts, raw generated evidence
payloads, or raw scan needles in this ledger.

## 2026-05-07 - S0-pulse-evidence-provenance

### Slice ID

S0-pulse-evidence-provenance

### Branch / Checkpoint Commit

feat/dynamic-pulse-semantic-inquiry / 125f6e7

### State

passed

### Objective

Make pulse decisions explainable before making them smarter.

### Owner Files Inspected

- `src/core/stage6_86/pulseCandidateSupport.ts`
- `src/core/stage6_86/pulseCandidates.ts`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `src/interfaces/conversationRuntime/sessionPulseMetadata.ts`
- `tests/core/stage6_86PulseCandidates.test.ts`
- `tests/interfaces/agentPulseScheduler.test.ts`
- `scripts/evidence/stage6_86PulseCandidates.ts`

### Read-Only Context Files Inspected

- `src/interfaces/agentPulseScheduler.ts`
- `src/interfaces/conversationRuntime/pulseEvaluation.ts`
- `src/interfaces/conversationRuntime/pulseSchedulerContracts.ts`
- `src/interfaces/proactiveRuntime/deliveryPolicy.ts`
- `src/interfaces/proactiveRuntime/cooldownPolicy.ts`
- `src/interfaces/pulseEmissionLifecycle.ts`
- `src/interfaces/pulseUxRuntime.ts`

### Prohibited Changes For This Slice

- Do not add Source Recall retrieval.
- Do not add model-generated inquiry candidates.
- Do not change delivery policy thresholds.
- Do not change `/pulse` command behavior.
- Do not expand live proactive delivery.

### Precondition Verification

- current code seam: Stage 6.86 candidate evaluation returned candidates/decisions but no typed
  trace/envelope/outcome records.
- dependency state: no live dependency required for S0
- Source Recall state if relevant: not relevant for S0
- model/backend state if relevant: not relevant for S0

### Tests To Add First

- Stage 6.86 candidate test for typed evidence records, decision records, and delivery envelope.
- Scheduler test assertions for emitted pulse id, candidate id, delivery envelope, and outcome
  record on persisted recent emissions.

### Implementation Tasks

- Added typed pulse evidence, decision, delivery-envelope, and outcome-record contracts.
- Added deterministic trace construction to `evaluatePulseCandidatesV1`.
- Added emitted delivery envelope and outcome seed to dynamic pulse recent emissions.
- Added outcome-record updates to deterministic pulse response lifecycle.
- Extended Stage 6.86 pulse candidate evidence artifact with provenance fields.

### Acceptance Criteria

- Emitted dynamic pulses record why they existed.
- Suppressed dynamic pulses record why they were suppressed.
- Evidence output distinguishes candidate generation from delivery permission.
- Dynamic pulse creates a typed candidate/decision trace even when no message is delivered.
- Delivery metadata is represented as structured fields, not only as system prompt text.
- Suppressed candidates record policy reason without storing raw private conversation text.
- Outcome records have a stable pulse id and candidate id before richer S5 learning.
- Existing safety behavior remains unchanged.

### Required Commands

- `npx tsx tests/core/stage6_86PulseCandidates.test.ts` - passed.
- `npx tsx tests/interfaces/agentPulseScheduler.test.ts` - passed.
- `npm run test:stage6_86:pulse_candidates` - passed.
- `npm run check:test-types` - passed.
- `npm run build` - passed.
- `npm run check:docs` - passed.

### Evidence Required

Focused tests passed. Updated Stage 6.86 pulse candidate evidence output at
`runtime/evidence/stage6_86_pulse_candidates_report.json` with provenance counts, trace id, emitted
pulse id, delivery decision id, runtime delivery decision, and proof categories.

### Sensitive Scan Scope

Changed docs, tests, fixtures, evidence scripts, generated evidence, and staged diff. Focused scan
for prior private fixture strings, token-shaped secrets, key markers, and local desktop paths
passed.

### Stop Conditions

Stop if S0 requires Source Recall retrieval, model-generated candidates, delivery threshold changes,
or broader scheduler behavior changes.

### Completion Note

- checkpoint commit hash: pending
- files changed: Stage 6.86 pulse candidate support/evaluator, compatibility export, dynamic pulse
  emission metadata, pulse emission lifecycle, evidence script, focused pulse tests, plan/progress
  docs
- tests added: typed candidate evidence/decision/envelope assertions; persisted emission envelope
  assertions
- behavior changed: dynamic emitted pulse history now carries a deterministic pulse id, candidate
  id, delivery envelope, and outcome seed; candidate evaluation now returns typed provenance trace
- behavior intentionally not changed: no Source Recall retrieval, no semantic candidate model, no
  delivery-threshold changes, no `/pulse` command changes, no increased proactive frequency
- production defaults after the slice: unchanged; Agent Pulse and Dynamic Pulse remain disabled by
  default
- pulse frequency became: equal
- next slice unblocked: yes, S1 can proceed

## 2026-05-07 - S1-pulse-controls-semantic-preferences

### Slice ID

S1-pulse-controls-semantic-preferences

### Branch / Checkpoint Commit

feat/dynamic-pulse-semantic-inquiry / e0b7e9f

### State

passed

### Objective

Keep exact pulse commands deterministic while moving messy natural pulse preferences into typed
semantic preference candidates.

### Owner Files Inspected

- `src/interfaces/conversationCommandPolicy.ts`
- `src/organs/intentRuntime/pulseLexicalRules.ts`
- `src/interfaces/conversationRuntime/followUpResolution.ts`
- `src/organs/intentRuntime/intentModelFallback.ts`
- `tests/organs/pulseLexicalClassifier.test.ts`
- `tests/interfaces/followUpResolution.test.ts`

### Read-Only Context Files Inspected

- `src/organs/intentRuntime/contracts.ts`
- `src/organs/intentInterpreter.ts`
- `src/organs/pulseLexicalClassifier.ts`
- `tests/organs/intentInterpreter.test.ts`
- `src/interfaces/conversationRuntime/invocationResolution.ts`

### Prohibited Changes For This Slice

- Do not change exact `/pulse` command behavior.
- Do not add Source Recall retrieval.
- Do not change pulse delivery policy, quiet hours, cooldowns, daily caps, or opt-in defaults.
- Do not treat preference candidates as delivery permission.
- Do not wire preference candidates into proactive outreach.

### Precondition Verification

- current code seam: exact commands were deterministic, but natural visibility/preference phrases
  could be interpreted as direct pulse-control commands.
- dependency state: S0 passed and typed pulse candidate/decision/outcome records exist.
- Source Recall state if relevant: not relevant for S1.
- model/backend state if relevant: model fallback remains pulse-control only; S1 adds typed
  preference candidates without model delivery authority.

### Tests To Add First

- Pulse lexical classifier tests for non-authoritative preference candidates and malformed override
  fail-closed behavior.
- Follow-up resolution tests for accepted preference candidates and blocked preference candidates.
- Intent interpreter test proving preference candidates are returned without model calls or command
  authority.

### Implementation Tasks

- Added `PulsePreferenceCandidate` and `PulsePreferenceIntent` contracts.
- Added deterministic preference-candidate classification for messy natural pulse preferences.
- Kept exact direct pulse command phrases deterministic.
- Prevented natural preference phrases like "only ask me privately" from becoming direct command
  authority.
- Added override-load failure state so expanded natural preference controls fail closed when a
  configured override path is malformed.
- Added interpreter/follow-up helpers that return preference candidates only when confidence passes
  and candidate state is not blocked.

### Acceptance Criteria

- Exact slash commands remain deterministic.
- Natural pulse preferences produce typed preference candidates, not immediate outreach authority.
- Ambiguous, blocked, or low-confidence interpretation fails closed.
- Preference candidates cannot override opt-in, quiet hours, private/public routing, or cooldowns.
- Malformed configured override paths block expanded natural preference controls while baseline
  fallback remains allowed when no override path is configured.

### Required Commands

- `npx tsx tests/organs/pulseLexicalClassifier.test.ts` - passed.
- `npx tsx tests/interfaces/followUpResolution.test.ts` - passed.
- `npx tsx tests/organs/intentInterpreter.test.ts` - passed.
- `npm run check:test-types` - passed.
- `npm run build` - passed.
- `npm run check:docs` - passed.

### Evidence Required

Focused tests prove natural preferences are typed as non-authoritative candidates, blocked override
state fails closed, exact pulse command behavior remains deterministic, and preference candidates
do not grant delivery permission or outreach authority.

### Sensitive Scan Scope

Changed contracts, pulse lexical rules, intent interpreter/fallback, follow-up resolution, focused
tests, and progress docs. Focused scan for prior private fixture strings, token-shaped secrets, key
markers, and local desktop paths passed.

### Stop Conditions

Stop if S1 requires Source Recall retrieval, delivery-policy changes, broader scheduler behavior,
or runtime outreach changes.

### Completion Note

- checkpoint commit hash: pending
- files changed: intent-runtime contracts/fallback/rules, stable pulse lexical export, intent
  interpreter, follow-up resolution, focused pulse/follow-up/intent tests, progress ledger
- tests added: preference candidate classifier tests, follow-up preference resolution tests, intent
  interpreter preference test
- behavior changed: messy natural pulse preferences now have typed non-authoritative candidate
  shape and do not collapse into command authority
- behavior intentionally not changed: no pulse delivery policy changes, no Source Recall retrieval,
  no proactive outreach expansion, no exact `/pulse` command changes
- production defaults after the slice: unchanged; Agent Pulse and Dynamic Pulse remain disabled by
  default
- pulse frequency became: equal
- next slice unblocked: yes, S2 can proceed only after the Source Recall runtime gate is verified

## 2026-05-07 - S2-source-recall-evidence

### Slice ID

S2-source-recall-evidence

### Branch / Checkpoint Commit

feat/dynamic-pulse-semantic-inquiry / b9532ed

### State

passed

### Objective

Allow pulse candidates to cite Source Recall as quoted evidence without giving Source Recall
outreach authority.

### Owner Files Inspected

- `src/core/sourceRecall/sourceRecallRetriever.ts`
- `src/organs/memoryContext/contextInjection.ts`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `src/interfaces/conversationRuntime/pulsePrompting.ts`
- `tests/core/sourceRecallRetriever.test.ts`
- `tests/organs/sourceRecallContextInjection.test.ts`
- `tests/interfaces/pulsePrompting.test.ts`

### Read-Only Context Files Inspected

- `src/core/sourceRecall/contracts.ts`
- `src/core/sourceRecall/sourceRecallRetention.ts`
- `src/core/config.ts`
- `src/core/buildBrain.ts`
- `src/interfaces/runtimeConfig.ts`

### Prohibited Changes For This Slice

- Do not add a default Source Recall retrieval callsite to planner/chat/pulse.
- Do not grant Source Recall delivery permission or outreach authority.
- Do not loosen Source Recall lifecycle, privacy, or public-mode suppression.
- Do not enable media/document Source Recall pulse use.
- Do not change pulse frequency, caps, cooldowns, quiet hours, or opt-in.

### Precondition Verification

- current code seam: Source Recall has encrypted production config, retrieval latches, lifecycle
  filtering, quoted-evidence renderer, bounded audit metadata, and non-authority flags.
- dependency state: S0 and S1 passed; Source Recall retrieval and quoted rendering tests already
  exist.
- Source Recall state if relevant: production storage and retrieval are config-latched; retrieval is
  not invoked by planner/chat/pulse by default.
- model/backend state if relevant: not relevant for S2.

### Tests To Add First

- Pulse prompting tests for quoted Source Recall evidence.
- Pulse prompting tests for public-mode Source Recall suppression.
- Pulse prompting tests for disabled Source Recall status with no evidence.

### Implementation Tasks

- Added optional Source Recall evidence context to dynamic pulse prompting.
- Rendered Source Recall via the canonical quoted-evidence egress renderer when explicitly supplied.
- Added Source Recall status/block reason rendering for disabled, blocked, unavailable, and not-used
  states.
- Blocked Source Recall evidence from public-mode pulse prompts unless the caller marks it
  public-safe.
- Preserved no-default-retrieval behavior; no pulse/planner/chat path retrieves Source Recall by
  default in this slice.

### Acceptance Criteria

- Source Recall evidence appears only as quoted evidence.
- Retrieved chunks cannot spoof route metadata, commands, approval, proof, or pulse permission.
- Source Recall lifecycle/privacy suppression remains delegated to retrieval and public-mode prompt
  suppression.
- Pulse can continue without Source Recall when retrieval is disabled or unavailable.

### Required Commands

- `npx tsx tests/interfaces/pulsePrompting.test.ts` - passed.
- `npx tsx tests/core/sourceRecallRetriever.test.ts` - passed.
- `npx tsx tests/organs/sourceRecallContextInjection.test.ts` - passed.
- `npm run check:test-types` - passed.
- `npm run build` - passed.
- `npm run check:docs` - passed.

### Evidence Required

Focused tests prove prompt rendering quotes route/approval/proof-looking Source Recall text, blocks
public-unsafe Source Recall evidence in public mode, records disabled status without evidence, and
keeps retrieval/context-injection non-authority contracts intact.

### Sensitive Scan Scope

Changed pulse prompting, pulse prompting tests, and progress docs. Focused scan for prior private
fixture strings, token-shaped secrets, key markers, and local desktop paths passed.

### Stop Conditions

Stop if S2 requires default Source Recall retrieval, production media/document Source Recall pulse
use, delivery-policy changes, or broader context-injection behavior changes.

### Completion Note

- checkpoint commit hash: pending
- files changed: pulse prompting, pulse prompting tests, progress ledger
- tests added: Source Recall quoted-evidence pulse prompt tests, public-mode suppression test,
  disabled Source Recall status test
- behavior changed: dynamic pulse prompts can render explicitly supplied Source Recall as
  non-authoritative quoted evidence with status and block reasons
- behavior intentionally not changed: no default Source Recall retrieval callsite, no planner/chat
  context injection changes, no delivery-policy changes, no increased proactive frequency
- production defaults after the slice: unchanged; Source Recall and Dynamic Pulse remain
  config-latched/disabled by default
- pulse frequency became: equal
- next slice unblocked: yes, S3 can proceed; if Source Recall is unavailable at runtime, S3 must
  mark `sourceRecallStatus` as disabled, blocked, or unavailable and avoid Source Recall evidence

## 2026-05-07 - S3-proactive-inquiry-candidates

### Slice ID

S3-proactive-inquiry-candidates

### Branch / Checkpoint Commit

feat/dynamic-pulse-semantic-inquiry / a9c7e68

### State

passed

### Objective

Introduce a semantic candidate layer that proposes useful questions without granting outreach
authority.

### Owner Files Inspected

- `src/core/stage6_86/proactiveInquiryCandidates.ts`
- `src/organs/languageUnderstanding/proactiveInquiryInterpretation.ts`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `tests/core/stage6_86ProactiveInquiryCandidates.test.ts`
- `tests/organs/proactiveInquiryInterpretation.test.ts`

### Read-Only Context Files Inspected

- `src/core/stage6_86/pulseCandidateSupport.ts`
- `src/core/stage6_86PulseCandidates.ts`
- `src/core/types.ts`
- `tests/interfaces/agentPulseScheduler.test.ts`

### Prohibited Changes For This Slice

- Do not generate final delivered wording.
- Do not grant delivery permission from model or inquiry output.
- Do not change deterministic delivery thresholds, cooldowns, quiet hours, caps, or opt-in.
- Do not require Source Recall availability.
- Do not add Source Recall retrieval callsites.

### Precondition Verification

- current code seam: dynamic pulse emitted deterministic reason codes and S0 envelope metadata, but
  did not have a typed inquiry intent/risk/user-value layer.
- dependency state: S0-S2 passed.
- Source Recall state if relevant: optional; S3 can operate with `sourceRecallStatus=not_used`.
- model/backend state if relevant: model output normalization is schema-only and fail-closed; no
  live model dependency required.

### Tests To Add First

- Core proactive inquiry candidate tests for Stage 6.86 pulse-candidate conversion.
- Model-output normalization tests for malformed, low-confidence, and accepted candidates.
- Scheduler test assertions proving emitted inquiry metadata is non-authoritative and uses
  `sourceRecallStatus=not_used`.

### Implementation Tasks

- Added `ProactiveInquiryCandidate` contracts, user-value reasons, question-plan shape, evidence
  policy, risk metadata, and non-authority flags.
- Added deterministic conversion from existing Stage 6.86 pulse candidates into inquiry candidates.
- Added schema-normalized model-output boundary that rejects malformed, absent, low-confidence, or
  low-value candidates.
- Attached inquiry metadata to dynamic pulse emission history and delivery envelope metadata without
  changing delivery permission.

### Acceptance Criteria

- Model output is schema-normalized and bounded.
- Low-confidence or malformed model output fails closed to no semantic candidate.
- Candidate authority flags are all non-authorizing.
- User-value rationale is required and bounded.
- Candidate proposals cannot bypass deterministic delivery policy.
- S3 does not produce final deliverable pulse wording.

### Required Commands

- `npx tsx tests/core/stage6_86ProactiveInquiryCandidates.test.ts` - passed.
- `npx tsx tests/organs/proactiveInquiryInterpretation.test.ts` - passed.
- `npx tsx tests/interfaces/agentPulseScheduler.test.ts` - passed.
- `npm run check:test-types` - passed.
- `npm run build` - passed.
- `npm run check:docs` - passed.

### Evidence Required

Focused tests prove inquiry candidates carry user-value rationale, question intent, evidence policy,
risk, Source Recall status, and non-authority flags; malformed and low-confidence model output
returns no candidate; persisted dynamic pulse metadata has no delivery authority.

### Sensitive Scan Scope

Changed proactive inquiry contracts, model-output normalization boundary, dynamic pulse emission
metadata, focused tests, and progress docs. Focused scan for prior private fixture strings,
token-shaped secrets, key markers, and local desktop paths passed.

### Stop Conditions

Stop if S3 requires final wording generation, Source Recall retrieval, live model dependency,
delivery-policy changes, or increased pulse frequency.

### Completion Note

- checkpoint commit hash: pending
- files changed: proactive inquiry candidate contracts, proactive inquiry model-output normalizer,
  pulse candidate support, dynamic pulse evaluation, focused tests, progress ledger
- tests added: core proactive inquiry candidate tests, model-output normalization tests, scheduler
  inquiry metadata assertions
- behavior changed: dynamic pulse emission history now includes a typed, non-authoritative
  proactive inquiry candidate and delivery envelope inquiry type
- behavior intentionally not changed: no final wording generation, no delivery permission changes,
  no Source Recall retrieval, no model candidate callsite, no increased proactive frequency
- production defaults after the slice: unchanged; Agent Pulse and Dynamic Pulse remain disabled by
  default
- pulse frequency became: equal
- next slice unblocked: yes, S4 can apply deterministic delivery/suppression policy to semantic
  candidates

## 2026-05-07 - S4-deterministic-delivery-policy

### Slice ID

S4-deterministic-delivery-policy

### Branch / Checkpoint Commit

feat/dynamic-pulse-semantic-inquiry / 68eacfd

### State

passed

### Objective

Extend deterministic policy so semantic candidates can be safely suppressed or allowed without model
permission.

### Owner Files Inspected

- `src/core/agentPulse.ts`
- `src/interfaces/agentPulseScheduler.ts`
- `src/interfaces/proactiveRuntime/deliveryPolicy.ts`
- `src/interfaces/proactiveRuntime/cooldownPolicy.ts`
- `src/interfaces/proactiveRuntime/followupQualification.ts`
- `src/interfaces/proactiveRuntime/userValueScoring.ts`
- `src/interfaces/conversationRuntime/pulseEvaluation.ts`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `src/interfaces/conversationRuntime/pulseSchedulerContracts.ts`
- `tests/core/agentPulse.test.ts`
- `tests/interfaces/proactiveRuntime.test.ts`

### Read-Only Context Files Inspected

- `src/core/stage6_86/proactiveInquiryCandidates.ts`
- `tests/interfaces/agentPulseScheduler.test.ts`

### Prohibited Changes For This Slice

- Do not increase default pulse frequency.
- Do not loosen opt-in, quiet hours, cooldowns, daily caps, active mission suppression, or routing.
- Do not let model confidence or Source Recall retrieval override suppression.
- Do not generate final pulse wording.
- Do not enable Source Recall retrieval by default.

### Precondition Verification

- current code seam: S3 created non-authoritative inquiry candidates, but no deterministic semantic
  inquiry policy checked expected user value, novelty, privacy, Source Recall usability, or repeated
  negative outcomes.
- dependency state: S0-S3 passed.
- Source Recall state if relevant: policy consumes Source Recall status on candidate only; no
  retrieval callsite added.
- model/backend state if relevant: not relevant for S4.

### Tests To Add First

- Proactive runtime tests for allowed semantic inquiry candidates.
- Proactive runtime tests for public/private evidence, unusable Source Recall, low value, low
  novelty, and repeated negative outcome suppression.
- Scheduler regression test remains focused on unchanged dynamic pulse delivery path.

### Implementation Tasks

- Added deterministic `evaluateProactiveInquiryDeliveryPolicy`.
- Added suppression reasons for invalid candidate authority, low expected user value, low novelty,
  blocked privacy risk, public-route private evidence, active mission risk, unusable Source Recall,
  and repeated negative outcomes.
- Applied the policy in dynamic pulse evaluation before prompt construction and enqueue.
- Preserved existing delivery gates and made semantic inquiry policy stricter/equal.

### Acceptance Criteria

- Model candidate confidence cannot override policy suppression.
- Source Recall retrieval/status cannot override policy suppression.
- Public mode blocks private/sensitive candidate evidence.
- Repeated ignored/dismissed/negative/muted outcomes suppress similar future delivery.
- Semantic inquiry does not increase default pulse frequency; default opt-in, caps, cooldowns,
  quiet hours, active mission suppression, and route checks remain equal or stricter.

### Required Commands

- `npx tsx tests/interfaces/proactiveRuntime.test.ts` - passed.
- `npx tsx tests/interfaces/agentPulseScheduler.test.ts` - passed.
- `npx tsx tests/core/agentPulse.test.ts` - passed.
- `npm run check:test-types` - passed.
- `npm run build` - passed.
- `npm run check:docs` - passed.

### Evidence Required

Focused tests prove semantic inquiry candidates are deterministically allowed or suppressed by
policy and that low-value/low-novelty/public-unsafe/Source Recall-unusable/repeated-negative
candidates cannot deliver.

### Sensitive Scan Scope

Changed proactive delivery policy, dynamic pulse evaluation, proactive runtime tests, and progress
docs. Focused scan for prior private fixture strings, token-shaped secrets, key markers, and local
desktop paths passed.

### Stop Conditions

Stop if S4 requires policy relaxation, increased frequency, final wording generation, Source Recall
retrieval callsites, or unrelated scheduler delivery changes.

### Completion Note

- checkpoint commit hash: 68eacfd
- files changed: proactive delivery policy, dynamic pulse evaluation, proactive runtime tests,
  progress ledger
- tests added: semantic inquiry delivery policy allow/suppress tests
- behavior changed: semantic inquiry candidates pass through deterministic delivery policy before
  dynamic pulse prompt enqueue
- behavior intentionally not changed: no default pulse frequency increase, no Source Recall
  retrieval, no final wording generation, no opt-in/quiet-hours/cooldown/cap/routing relaxation
- production defaults after the slice: unchanged
- pulse frequency became: equal or stricter
- next slice unblocked: yes, S5 can bind wording/outcome learning after permission

## 2026-05-07 - S5-wording-outcome-learning

### Slice ID

S5-wording-outcome-learning

### Branch / Checkpoint Commit

feat/dynamic-pulse-semantic-inquiry / pending

### State

in_progress

### Objective

Keep pulse wording after deterministic permission and record bounded outcome metadata for learning.

### Owner Files Inspected

- `src/interfaces/conversationRuntime/pulsePrompting.ts`
- `src/interfaces/pulseEmissionLifecycle.ts`
- `src/interfaces/conversationRuntime/sessionPulseMetadata.ts`
- `src/interfaces/pulseUxRuntime.ts`
- `tests/interfaces/pulsePrompting.test.ts`
- `tests/interfaces/pulseState.test.ts`
- `tests/interfaces/pulseUxRuntime.test.ts`

### Read-Only Context Files Inspected

- `src/core/stage6_86/pulseCandidateSupport.ts`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `src/interfaces/conversationWorkerLifecycle.ts`
- `src/interfaces/telegramGateway.ts`
- `src/interfaces/discordGateway.ts`

### Prohibited Changes For This Slice

- Do not change deterministic delivery permission.
- Do not increase pulse frequency.
- Do not add new Source Recall retrieval callsites.
- Do not make model wording decide whether delivery is allowed.
- Do not store raw Source Recall chunks in outcome records.

### Precondition Verification

- current code seam: S0-S4 produce typed delivery envelopes and outcome records, but pulse UX
  rendering still falls back to prompt-text reason markers and delivered wording is not persisted as
  a hash/redacted preview.
- dependency state: S0-S4 checkpoint commits exist and S4 passed.
- Source Recall state if relevant: only already-rendered quoted evidence may appear in summaries;
  no new retrieval is needed for S5.
- model/backend state if relevant: no live model dependency is needed.

### Tests To Add First

- Pulse UX test that typed delivery metadata is preferred over prompt-text parsing.
- Pulse emission lifecycle test that delivered text is recorded as hash/redacted preview.
- Pulse emission lifecycle test that user reply binding records the pulse id/user-turn id without
  raw source text.

### Implementation Tasks

- Prefer typed pulse delivery metadata in UX rendering when available.
- Keep prompt-text marker extraction as legacy compatibility only.
- Backfill delivered-text hash and redacted preview on completed pulse jobs.
- Bind user replies to pulse outcome records inside the response window.

### Acceptance Criteria

- Actual delivered wording is represented by hash/redacted preview, not only reason code.
- User replies can be bound to the relevant pulse id within the response window.
- Dismissals continue to suppress similar future candidates through existing recent-emission
  history.
- Stored outcome records do not contain raw Source Recall chunks.
- Pulse UX rendering consumes typed pulse delivery metadata where available and keeps regex prompt
  extraction as legacy-only compatibility.

### Required Commands

- `npx tsx tests/interfaces/pulseUxRuntime.test.ts` - passed.
- `npx tsx tests/interfaces/pulseEmissionLifecycle.test.ts` - passed.
- `npx tsx tests/interfaces/pulseState.test.ts` - passed.
- `npx tsx tests/interfaces/pulsePrompting.test.ts` - passed.
- `npm run check:test-types` - passed.
- `npm run build` - passed.
- `npm run check:docs` - passed.

### Evidence Required

Focused tests must prove typed metadata rendering, delivered-text hashing/redaction, and bounded user
reply binding without raw Source Recall storage.

### Sensitive Scan Scope

Changed pulse UX/outcome lifecycle files, focused tests, and progress docs. Scan for prior private
fixture strings, token-shaped secrets, key markers, and local desktop paths before checkpoint.

### Stop Conditions

Stop if S5 requires delivery-policy changes, Source Recall retrieval, final wording before
permission, or unrelated gateway/transport behavior changes.

### Completion Note

- checkpoint commit hash: pending
- files changed: pulse UX runtime, pulse emission lifecycle, focused pulse UX/outcome tests,
  progress ledger
- tests added: pulse emission lifecycle outcome metadata tests and typed pulse UX metadata
  preference test
- behavior changed: pulse UX rendering now prefers typed delivery metadata when present; completed
  pulse jobs record delivered-text hash and bounded redacted preview; user replies bind to pulse
  outcome records without raw reply text
- behavior intentionally not changed: no delivery permission changes, no Source Recall retrieval,
  no pulse frequency increase, no transport delivery changes
- production defaults after the slice: unchanged
- pulse frequency became: equal
- next slice unblocked: yes, S6 can build the multi-day evidence matrix
