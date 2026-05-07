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

feat/dynamic-pulse-semantic-inquiry / pending

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
