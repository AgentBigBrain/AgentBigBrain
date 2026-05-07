# Dynamic Pulse Semantic Inquiry Plan

## Plan Status

Draft. Implementation has not started.

This plan converts the accepted Dynamic Pulse + Proactive Inquiry audit into an
implementation-ready roadmap. The audit's core verdict is the premise of this plan:

Agent Pulse is robust as a deterministic safety and suppression system. It is not yet robust as an
intelligent proactive inquiry system.

The goal is not more proactive messages. The goal is better questions, rarer interruptions,
stronger evidence, clearer suppression, and learning from what the user actually values.

## Operator Instruction For Autonomous Run

Use this exact instruction to start autonomous execution:

```text
Execute this plan in autonomous end-to-end mode on branch `feat/dynamic-pulse-semantic-inquiry`.
Follow the Autonomous End-To-End Execution Addendum.
Start at S0. Continue through S7 only when each slice passes its continuation gates.
Create checkpoint commits after every passed slice.
Stop immediately if a stop condition fires.
Do not enable more proactive behavior by default.
Do not wire Source Recall into pulse unless the Source Recall production dependency gate is verified in current code.
Do not let model output, Source Recall evidence, or outcome learning grant outreach authority.
```

## Agent Start Here

Do not read this plan and begin a broad pulse refactor.

The first implementation slice is:

```text
S0-pulse-evidence-provenance
```

Start there only. Do not add Source Recall retrieval, model-generated inquiry candidates, delivery
policy changes, outcome learning, or new live Telegram behavior in the first slice.

If the operator explicitly requests end-to-end execution, continue only through the ordered slice
queue and only after the current slice passes its completion gate. End-to-end mode does not relax
privacy, authority, testing, sensitive-scan, or scope-budget requirements.

## Objective

Make Agent Pulse capable of proposing useful proactive inquiry candidates from graph, memory, Source
Recall, and recent conversation while preserving deterministic interruption authority.

The final architecture should allow:

1. source-labeled evidence to explain why a question might be useful,
2. a semantic inquiry layer to propose typed questions,
3. deterministic pulse policy to decide whether interruption is allowed,
4. model wording only after permission is granted,
5. outcome records to teach the runtime what the user values.

## Core Invariant

Pulse candidates may suggest questions.

Deterministic policy decides whether to interrupt.

Source Recall evidence never becomes outreach authority by itself.

## Pulse Authority Model

Agent Pulse has four separate layers:

1. Controls: exact `/pulse` commands and semantic pulse preferences.
2. Candidate generation: what might be useful to ask.
3. Delivery policy: whether ABB is allowed to interrupt.
4. Outcome learning: whether the user engaged, ignored, dismissed, muted, or corrected the pulse.

No layer may collapse into another.

- Candidate generation cannot deliver.
- Source Recall cannot deliver.
- Model wording cannot deliver.
- Outcome learning cannot override opt-in, quiet hours, private/public policy, active mission
  suppression, or cooldowns.

## Non-Goals

- Do not make Agent Pulse more aggressive.
- Do not let a model decide whether proactive outreach is allowed.
- Do not let Source Recall authorize outreach, memory truth, approval, action, safety, or completion
  proof.
- Do not weaken `/pulse` command determinism.
- Do not use deleted, redacted, quarantined, expired, assistant-only, media/document-derived, or
  public-unsafe source material for proactive outreach without explicit policy support.
- Do not replace deterministic safety gates with prompt instructions.
- Do not build a generic notification system.

## Current Verified State

Verified against the local repository before this plan was created.

Safety and config:

- `src/core/config.ts` defaults `agentPulse.enabled` and `agentPulse.enableDynamicPulse` to `false`.
- `BRAIN_AGENT_PULSE_ENABLED` enables pulse policy.
- `BRAIN_ENABLE_DYNAMIC_PULSE` enables the Stage 6.86 dynamic candidate path.
- `src/core/agentPulse.ts` enforces disabled, opt-out, missing reason prerequisites,
  workflow-domain suppression, quiet hours, and min-interval rate limiting.

Candidate generation:

- `src/core/stage6_86/pulseCandidates.ts` builds deterministic candidates from high-salience
  graph entities, uncertain co-mentioned edges, open loops, topic drift, and stale facts.
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts` consumes graph, conversation
  stack, recent pulse history, recent turns, timezone, and style fingerprint.
- `src/interfaces/conversationRuntime/pulsePrompting.ts` asks the model to word an already-selected
  candidate. The model does not invent dynamic candidates today.
- `src/core/stage6_86/bridgeQuestions.ts` keeps relationship clarification narrow and deterministic.

Controls:

- `/pulse on`, `/pulse off`, `/pulse private`, `/pulse public`, and `/pulse status` are
  deterministic command paths.
- `src/organs/intentRuntime/pulseLexicalRules.ts` owns current pulse lexical command rules and
  override loading.
- `src/interfaces/conversationRuntime/followUpResolution.ts` and
  `src/organs/intentRuntime/intentModelFallback.ts` provide bounded semantic interpretation for
  natural pulse-control language, but not candidate intelligence.

Source Recall boundary:

- Source Recall retrieval and quoted-evidence rendering exist in
  `src/core/sourceRecall/sourceRecallRetriever.ts` and
  `src/organs/memoryContext/contextInjection.ts`.
- The inspected pulse files do not currently import or call Source Recall retrieval/rendering.
- Source Recall authority flags explicitly mark recalled chunks as quoted evidence only and unsafe
  to follow as instructions.

Outcome learning:

- `src/interfaces/pulseEmissionLifecycle.ts` backfills recent pulse outcomes as engaged, ignored, or
  dismissed.
- Dynamic pulse currently persists `generatedSnippet` as an intent summary, not the actual delivered
  text or a durable question-intent record.

## Target Architecture

```text
Source Recall + graph + profile memory + semantic memory + recent conversation
        |
        v
Semantic proactive inquiry candidate proposal
        |
        v
Candidate evidence, user-value, risk, novelty, and provenance records
        |
        v
Deterministic delivery and suppression policy
        |
        v
Model wording after permission
        |
        v
Outcome learning and future candidate suppression/adaptation
```

The semantic layer may propose. It does not permit. The deterministic policy layer permits or
suppresses. The wording layer speaks only after permission.

## Proposed Contracts

These are target contracts for planning and tests. Exact names may change during implementation, but
the authority separation must not.

### Pulse Delivery Envelope

```ts
export interface PulseDeliveryEnvelope {
  pulseId: string;
  candidateId: string;
  reasonCode: PulseReasonCodeV1;
  inquiryType?: ProactiveInquiryType;
  evidenceRefs: readonly string[];
  sourceRecallRefs: readonly string[];
  deliveryDecisionId: string;
  promptKind: "stage6_86_dynamic_pulse" | "semantic_inquiry_pulse";
  createdAt: string;
  allowedByPolicy: boolean;
  userVisibleDeliveryAllowed: boolean;
}
```

Pulse UX rendering should consume typed delivery metadata when available. Extracting reason codes or
signal types from system prompt text is legacy compatibility only and must remain covered by
compatibility tests.

### Pulse Outcome Record

```ts
export interface PulseOutcomeRecord {
  pulseId: string;
  candidateId: string;
  emittedAt: string;
  deliveredTextHash: string | null;
  deliveredTextPreviewRedacted: string | null;
  responseOutcome:
    | "engaged"
    | "ignored"
    | "dismissed"
    | "negative"
    | "muted"
    | null;
  outcomeSource:
    | "explicit_user_reply"
    | "timeout"
    | "semantic_interpretation"
    | "legacy_keyword"
    | "operator_review";
  boundUserTurnId?: string;
}
```

The schema begins in S0 so later slices do not have to retrofit pulse ids through multiple runtime
surfaces. S5 implements richer binding and learning behavior.

### Proactive Inquiry Candidate

```ts
export type ProactiveInquiryType =
  | "clarify_memory"
  | "resume_open_loop"
  | "ask_missing_constraint"
  | "revalidate_stale_fact"
  | "surface_pattern"
  | "suggest_workflow_improvement"
  | "follow_up_user_requested"
  | "ask_review_priority";

export type PulseUserValueReason =
  | "prevents_stale_work"
  | "clarifies_ambiguous_memory"
  | "unblocks_saved_work"
  | "revalidates_likely_stale_fact"
  | "captures_user_preference"
  | "surfaces_useful_pattern"
  | "asks_for_missing_constraint"
  | "protects_against_wrong_assumption";

export type PulseSourceRecallStatus =
  | "not_used"
  | "available"
  | "disabled"
  | "blocked"
  | "unavailable";

export type PulseSourceEvidenceBlockReason =
  | "forgotten"
  | "redacted"
  | "expired"
  | "quarantined"
  | "projection_only_removed"
  | "public_unsafe"
  | "assistant_only"
  | "task_summary_only"
  | "media_document_without_policy";

export interface ProactiveInquiryCandidate {
  candidateId: string;
  inquiryType: ProactiveInquiryType;
  questionIntent: string;
  questionPlan: {
    userFacingGoal: string;
    allowedTopic: string;
    forbiddenDetails: readonly string[];
    suggestedTone: "direct" | "tentative" | "casual" | "formal";
  };
  questionDraft?: string;
  userValueReason: PulseUserValueReason;
  userValueRationale: string;
  evidence: {
    sourceRecallRefs: readonly string[];
    memoryRefs: readonly string[];
    graphRefs: readonly string[];
    recentTurnRefs: readonly string[];
  };
  evidencePolicy: {
    sourceRecallStatus: PulseSourceRecallStatus;
    sourceRecallUsable: boolean;
    blockedSourceRecallRefs: readonly string[];
    blockReasons: readonly PulseSourceEvidenceBlockReason[];
  };
  risk: {
    interruptionRisk: "low" | "medium" | "high";
    privacyRisk: "none" | "private_only" | "sensitive" | "blocked";
    publicSafe: boolean;
    activeMissionSafe: boolean;
  };
  confidence: number;
  novelty: number;
  expectedUserValue: number;
  authority: {
    outreachAuthority: false;
    memoryWriteAuthority: false;
    truthAuthority: false;
    approvalAuthority: false;
  };
}
```

### Pulse Evidence And Decision Records

Every emitted or suppressed candidate should eventually have:

- candidate id,
- candidate type,
- pulse reason mapping,
- evidence refs,
- Source Recall refs when used,
- source authority summary,
- user-value reason,
- user-value score,
- novelty score,
- privacy state,
- public/private suitability,
- deterministic delivery decision,
- suppression reason when blocked,
- model wording receipt only when delivery was allowed.

### Outcome Storage Boundary

The current `recentEmissions` shape is useful but too thin for learning. Richer outcome behavior
should record:

- emitted timestamp,
- candidate id,
- reason code,
- question intent,
- source refs,
- source recall refs,
- delivered text hash,
- redacted delivered-text preview,
- response outcome,
- optional bound user-reply id.

Do not store raw private source chunks in outcome records.

## Source Recall Dependency Gate

This plan depends on Source Recall production user-turn capture being stable enough to provide real
quoted evidence.

Do not assume an older Source Recall foundation state is still true. Before S2, re-verify the
current repository and runtime config. Source Recall is allowed into pulse only when production
capture and retrieval are actually safe in the current code.

Before implementing Source Recall-backed pulse evidence, verify:

- production Source Recall storage is encrypted,
- live user-turn capture is explicitly config-latched,
- retrieval is bounded and audited,
- forgotten/redacted/quarantined/expired records are hidden,
- retrieved chunks render as quoted evidence only,
- Source Recall refs cannot authorize memory truth, approval, actions, safety, completion proof, or
  outreach.

If this gate is not met, continue only with pulse evidence/provenance and control-preference slices.
Do not mock Source Recall as if it were production evidence.

## Autonomous End-To-End Execution Addendum

This plan may be executed autonomously end to end only when the operator explicitly says:

```text
Execute this plan in autonomous end-to-end mode.
```

Autonomous mode means the agent may continue through the ordered slice queue without waiting for a
new instruction after every slice.

Autonomous mode does not permit broad refactoring, skipped tests, weakened assertions, scope
expansion, unsafe Source Recall use, delivery-policy relaxation, or increased default proactive
frequency.

The agent must run the plan as checkpointed slices, not as one continuous refactor.

### Required Autonomous Branch

Use one branch unless the operator requests separate branches:

```text
feat/dynamic-pulse-semantic-inquiry
```

Every slice must produce a checkpoint commit. Pushing remains operator-controlled unless the
operator explicitly asks to sync.

Checkpoint commit format:

```text
feat(pulse): S0 evidence provenance
feat(pulse): S1 semantic preferences
feat(pulse): S2 source recall evidence
feat(pulse): S3 proactive inquiry candidates
fix(pulse): S4 deterministic delivery policy
feat(pulse): S5 wording and outcome learning
test(pulse): S6 multiday evidence matrix
docs(pulse): S7 proactive inquiry contract
```

Do not create one giant commit.

### Autonomous Slice State Machine

Every slice must have one state in the progress ledger:

- `not_started`
- `packetizing`
- `in_progress`
- `validating`
- `passed`
- `blocked`
- `failed`
- `deferred`

State transition rules:

- `not_started` -> `packetizing` before owner files are edited.
- `packetizing` -> `in_progress` only after owner files, tests, prohibited changes, and acceptance
  criteria are restated in the ledger.
- `in_progress` -> `validating` only after implementation changes are complete.
- `validating` -> `passed` only after all continuation gates pass.
- any state -> `blocked` when a required dependency is unavailable.
- any state -> `failed` when tests or checks fail.
- any state -> `deferred` only when the slice is explicitly split and the deferred work has a named
  follow-up slice.

Never mark a slice `passed` from schema-only, mocked, expected-route, phrase-only, or partial
evidence when runtime behavior proof is required.

### Autonomous Progress Ledger Requirements

Maintain:

```text
docs/plans/dynamic-pulse-semantic-inquiry-progress.md
```

Each slice must append:

- slice id,
- branch,
- checkpoint commit hash,
- state,
- files inspected,
- files changed,
- tests added,
- tests run,
- checks run,
- evidence produced,
- sensitive scan status,
- behavior changed,
- behavior intentionally not changed,
- production defaults after the slice,
- whether pulse frequency became stricter, equal, or broader,
- whether the next slice is unblocked,
- exact blocker if blocked.

The ledger must not contain raw Source Recall chunks, private conversation text, real
Telegram/Discord identifiers, local desktop paths, token-shaped secrets, provider payloads, full
model prompts, or raw generated evidence payloads.

### Autonomous Continuation Gates

Before moving to the next slice, all existing continuation gates must pass, plus:

1. A checkpoint commit exists for the current slice.
2. The progress ledger records the slice as `passed`.
3. The slice did not change prohibited files or prohibited behavior.
4. The next slice dependency is satisfied in current code, not assumed from the plan.
5. No new production pulse path emits more frequently than before unless an explicit test proves it
   is stricter or equal.
6. No Source Recall-backed pulse behavior starts unless the Source Recall dependency gate is
   verified.
7. No model-generated candidate can become delivery permission.
8. No delivered pulse wording is generated before deterministic delivery permission.
9. No public-mode pulse can include private, sensitive, Source Recall, relationship, memory, or
   identity evidence unless explicitly public-safe.
10. No test labels synthetic, schema, or mock evidence as runtime-observed or live proof.

## Source Recall Runtime Gate For Autonomous Mode

Before S2 starts, the agent must verify current code and record the result:

- production Source Recall storage is encrypted,
- live `conversation_turn` capture is config-latched,
- retrieval is bounded and audited,
- forgotten/redacted/quarantined/expired records are hidden,
- retrieved chunks render as quoted evidence only,
- Source Recall refs cannot authorize memory truth, approval, action, safety, completion proof, or
  outreach.

If any condition fails:

- mark S2 as `blocked`,
- do not mock Source Recall as production evidence,
- continue to S3 only if S3 is explicitly allowed to operate with
  `sourceRecallStatus = "blocked" | "disabled" | "unavailable"`,
- every S3 candidate must record that Source Recall was not used.

## Blocked Slice Continuation Rule

Some slices may be marked `blocked` without stopping the entire plan when the dependency table
allows continuation.

If S2 Source Recall evidence is blocked:

- S2 must record exactly which Source Recall gate failed.
- S3 may proceed only in no-Source-Recall mode.
- S3 candidates must set `sourceRecallStatus` to `disabled`, `blocked`, or `unavailable`.
- S3 tests must prove no Source Recall evidence was used.
- S6 must include both blocked-Source-Recall and available-Source-Recall scenarios, or mark
  available-Source-Recall live proof as blocked.

`blocked` is not `passed`. Blocked evidence cannot satisfy Source Recall-backed acceptance criteria.

## No Increased Proactivity Rule

Semantic inquiry must not increase default pulse frequency.

Every behavior slice after S3 must prove one of:

- pulse frequency is unchanged,
- pulse frequency is stricter,
- the new behavior only changes candidate quality while preserving existing delivery caps,
- the new behavior is disabled behind an explicit config latch.

The multi-day evidence matrix must report:

- candidates proposed,
- candidates suppressed,
- messages emitted,
- suppressions per emission,
- repeated-topic suppressions,
- user-dismissal suppressions,
- public-mode suppressions,
- active-mission suppressions,
- Source Recall lifecycle suppressions.

The matrix must show at least as many suppressions as emissions.

A model-generated candidate must never bypass opt-in, quiet hours, cooldowns, daily caps, active
mission suppression, route privacy, public/private safety, or Source Recall lifecycle suppression.

## Global Prohibited Changes In Autonomous Mode

The agent must not:

- enable Agent Pulse by default,
- enable Dynamic Pulse by default,
- increase default daily caps,
- reduce default cooldowns,
- weaken quiet hours,
- weaken opt-in,
- auto-enable public delivery,
- treat model output as delivery permission,
- treat Source Recall as outreach authority,
- use raw Source Recall chunks in durable outcome records,
- wire media/document Source Recall into pulse before the Source Recall production roadmap allows
  it,
- change `/pulse` exact command behavior except in S1 owner files,
- change unrelated memory write authority,
- change planner/action authority,
- change network approvals,
- change Obsidian projection behavior,
- change Telegram/Discord live delivery behavior outside the named pulse delivery slice.

## Agent Execution Protocol

This roadmap must be executed as ordered review slices.

### No Phase Skipping By Inference

If a later phase looks easier, do not start it. Semantic inquiry depends on evidence truth, Source
Recall lifecycle safety, and deterministic delivery policy.

The only valid first slice is `S0-pulse-evidence-provenance`.

### Required Slice Loop

For each slice:

1. Read the slice objective, owner files, prohibited changes, acceptance criteria, and tests.
2. Re-verify current code seams before editing.
3. Inspect every owner file before editing.
4. Add or update focused tests first.
5. Implement the smallest change that satisfies the slice.
6. Run focused tests.
7. Run required checks for the slice.
8. Run sensitive scan on changed files, fixtures, docs, generated evidence, and staged diff when
   staging exists.
9. Update the progress ledger.
10. Create a checkpoint commit if the operator requested implementation and commit/sync.
11. Continue only if every continuation gate passes.

### Continuation Gates

Before moving from one slice to the next:

- focused tests passed,
- required checks passed,
- sensitive scan passed,
- scope budget was respected or the slice was split,
- evidence output distinguishes mocked/schema/runtime/live proof,
- no Source Recall lifecycle or privacy suppression is bypassed,
- no model output grants outreach authority,
- completion note is written,
- next slice dependency is satisfied.

### Scope Budget

A normal slice should touch:

- 1 to 6 production files,
- 1 to 4 focused test files,
- optionally 1 docs/progress/evidence file.

If a slice needs more than 8 production files, split it before implementation.

## Autonomous Slice Packet Template

Before editing a slice in autonomous mode, append this packet to the progress ledger:

```text
### Slice ID

### Branch / Checkpoint Commit

### Objective

### Owner Files Inspected

### Read-Only Context Files Inspected

### Prohibited Changes For This Slice

### Precondition Verification
- current code seam:
- dependency state:
- Source Recall state if relevant:
- model/backend state if relevant:

### Tests To Add First

### Implementation Tasks

### Acceptance Criteria

### Required Commands

### Evidence Required

### Sensitive Scan Scope

### Stop Conditions

### Completion Note
```

The packet is required even when a slice looks straightforward. If the packet reveals that the owner
set is too broad, split the slice before editing code.

### Sensitive Scan Requirements

Each behavior slice must scan changed docs, tests, fixtures, evidence scripts, generated evidence,
and staged diff for:

- real names or business examples copied from private user material,
- local desktop paths,
- token-shaped secrets,
- raw Source Recall chunks,
- private pulse evidence,
- provider payloads,
- Telegram/Discord identifiers beyond synthetic fixtures.

Synthetic test text is allowed when clearly synthetic and not copied from real user data.

## Branch Queue

Use these branch names unless the operator chooses otherwise:

1. `test/pulse-evidence-provenance`
2. `feat/pulse-semantic-preferences`
3. `feat/pulse-source-recall-evidence`
4. `feat/proactive-inquiry-candidates`
5. `fix/pulse-deterministic-delivery-policy`
6. `feat/pulse-outcome-learning`
7. `test/pulse-multiday-evidence-matrix`
8. `docs/proactive-inquiry-contract`

Do not add a `codex/` prefix to these operator-facing branches.

## Phase Dependency Locks

| Slice | Cannot start until |
| --- | --- |
| S0 evidence/provenance | Audit accepted |
| S1 semantic preferences | S0 records can distinguish candidate, policy, and outcome proof |
| S2 Source Recall evidence | Source Recall production user-turn capture and retrieval gate are stable |
| S3 proactive inquiry candidates | S0 complete and S2 either complete or explicitly marked blocked |
| S4 delivery policy | S3 candidate authority flags exist |
| S5 outcome learning | S0 records exist and S4 delivery decisions are explicit |
| S6 multi-day matrix | S0-S5 authority surfaces are implemented or explicitly blocked |
| S7 docs | Behavior slices complete or intentionally deferred |

## Review Slice Order

1. S0 - Pulse evidence and provenance records
2. S1 - Pulse controls and semantic preference candidates
3. S2 - Source Recall as read-only pulse evidence
4. S3 - Proactive inquiry candidate proposal
5. S4 - Deterministic delivery and suppression policy
6. S5 - Wording after permission and outcome learning
7. S6 - Multi-day behavior evidence matrix
8. S7 - Docs and operator contract

## S0 - Pulse Evidence And Provenance Records

### Objective

Make pulse decisions explainable before making them smarter.

### Owner Files

- `src/core/stage6_86/pulseCandidateSupport.ts`
- `src/core/stage6_86/pulseCandidates.ts`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `src/interfaces/conversationRuntime/sessionPulseMetadata.ts`
- `tests/core/stage6_86PulseCandidates.test.ts`
- `tests/interfaces/agentPulseScheduler.test.ts`
- `scripts/evidence/stage6_86PulseCandidates.ts`

### Read-Only Context Files

- `src/interfaces/agentPulseScheduler.ts`
- `src/interfaces/conversationRuntime/pulseEvaluation.ts`
- `src/interfaces/conversationRuntime/pulseSchedulerContracts.ts`
- `src/interfaces/proactiveRuntime/deliveryPolicy.ts`
- `src/interfaces/proactiveRuntime/cooldownPolicy.ts`
- `src/interfaces/pulseEmissionLifecycle.ts`
- `src/interfaces/pulseUxRuntime.ts`

### Prohibited Changes

- Do not add Source Recall retrieval.
- Do not add model-generated inquiry candidates.
- Do not change delivery policy thresholds.
- Do not change `/pulse` command behavior.
- Do not expand live proactive delivery.

### Required Implementation

Add durable, bounded records or record-shaped diagnostics for:

- candidate evidence,
- deterministic decision,
- suppression reason,
- emitted outcome hook,
- proof category.

The first slice may use existing candidate types. It should not invent smarter candidates.

### Acceptance Criteria

- An emitted dynamic pulse records why it existed.
- A suppressed dynamic pulse records why it was suppressed.
- Evidence output distinguishes candidate generation from delivery permission.
- Dynamic pulse creates a typed candidate/decision trace even when no message is delivered.
- Delivery metadata is represented as structured fields, not only as system prompt text.
- Suppressed candidates record policy reason without storing raw private conversation text.
- Outcome records have a stable pulse id and candidate id even before richer S5 learning is
  implemented.
- Evidence output does not include raw private conversation text beyond existing bounded synthetic
  fixtures.
- Existing safety behavior remains unchanged.

### Required Tests

- Focused Stage 6.86 candidate tests.
- Focused scheduler/dynamic pulse tests.
- Evidence script test if one exists for the script path.

## S1 - Pulse Controls And Semantic Preferences

### Objective

Keep exact pulse commands deterministic while moving messy natural pulse preferences into typed
semantic preference candidates.

### Owner Files

- `src/interfaces/conversationCommandPolicy.ts`
- `src/organs/intentRuntime/pulseLexicalRules.ts`
- `src/interfaces/conversationRuntime/followUpResolution.ts`
- `src/organs/intentRuntime/intentModelFallback.ts`
- `tests/organs/pulseLexicalClassifier.test.ts`
- `tests/interfaces/followUpResolution.test.ts`

### Deterministic Controls To Keep

- `/pulse on`
- `/pulse off`
- `/pulse private`
- `/pulse public`
- `/pulse status`
- exact direct pulse command phrases
- override file validation
- conflict handling

### Natural Preferences To Interpret Semantically

- "don't ask about that anymore"
- "only ask me privately"
- "ask me tomorrow"
- "that follow-up was useful"
- "stop bringing up work stuff at night"
- "check in on the website project later"

### Acceptance Criteria

- Exact slash commands remain deterministic.
- Natural pulse preferences produce typed preference candidates, not immediate outreach authority.
- Ambiguous or low-confidence model interpretation fails closed.
- Preference candidates cannot override opt-in, quiet hours, private/public routing, or cooldowns.
- If a pulse lexical override path is explicitly configured and malformed, expanded natural pulse
  controls fail closed. Baseline fallback is allowed only when no override path is configured.

## S2 - Source Recall As Read-Only Pulse Evidence

### Objective

Allow pulse candidates to cite Source Recall as quoted evidence without giving Source Recall
outreach authority.

### Owner Files

- `src/core/sourceRecall/sourceRecallRetriever.ts`
- `src/organs/memoryContext/contextInjection.ts`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `src/interfaces/conversationRuntime/pulsePrompting.ts`
- `tests/core/sourceRecallRetriever.test.ts`
- `tests/organs/sourceRecallContextInjection.test.ts`
- `tests/interfaces/pulsePrompting.test.ts`

### Source Recall Rules

Source Recall may provide:

- exact quoted evidence,
- source refs,
- lifecycle state,
- source role,
- source kind,
- retrieval mode,
- retrieval authority,
- bounded audit metadata.

Source Recall may not provide:

- delivery permission,
- current truth,
- memory write authority,
- approval,
- safety permission,
- completion proof,
- public-channel permission.

### Source Recall Availability Rule

If Source Recall production retrieval is unavailable, disabled, blocked, or test-only, pulse may not
pretend source evidence exists. Candidates must record:

- `sourceRecallStatus: "not_used" | "available" | "disabled" | "blocked" | "unavailable"`
- `blockedSourceRecallReason` or equivalent bounded reason metadata when applicable

### Suppression Requirements

Suppress candidates that require Source Recall when all available source records are:

- forgotten,
- redacted,
- expired,
- quarantined,
- projection-only removed,
- public-unsafe for the target route,
- assistant-output-only without explicit support,
- task-summary-only without explicit support,
- media/document-derived without source policy support.

### Acceptance Criteria

- Source Recall evidence appears only as quoted evidence.
- Retrieved chunks cannot spoof route metadata, commands, approval, proof, or pulse permission.
- Source Recall lifecycle suppression is tested.
- Pulse can continue without Source Recall when retrieval is disabled or unavailable.

## S3 - Proactive Inquiry Candidate Proposal

### Objective

Introduce a semantic candidate layer that proposes useful questions without granting outreach
authority.

### Owner Files

- new `src/core/stage6_86/proactiveInquiryCandidates.ts`
- new or existing local model adapter under `src/organs/languageUnderstanding/`
- `src/interfaces/conversationRuntime/pulseDynamicEvaluation.ts`
- `tests/core/stage6_86ProactiveInquiryCandidates.test.ts`
- `tests/organs/*ProactiveInquiry*.test.ts`

### Inputs

- recent conversation,
- Source Recall bundle,
- open loops,
- entity graph,
- profile memory candidates,
- semantic memory lessons,
- recent pulse outcomes,
- active mission state,
- privacy/sensitivity state.

### Output

Typed `ProactiveInquiryCandidate` records, not final messages.

### Wording Boundary

The semantic inquiry generator proposes inquiry intent, user-value rationale, evidence, risk,
novelty, and optionally a bounded draft.

It does not produce the final delivered pulse message. Final user-facing wording is produced only in
S5 after deterministic delivery permission.

### Acceptance Criteria

- Model output is schema-normalized and bounded.
- Low-confidence or malformed model output fails closed to no semantic candidate.
- Candidate authority flags are all non-authorizing.
- User-value rationale is required and bounded.
- Candidate proposals cannot bypass deterministic delivery policy.

## S4 - Deterministic Delivery And Suppression Policy

### Objective

Extend deterministic policy so semantic candidates can be safely suppressed or allowed without model
permission.

### Owner Files

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

### Deterministic Checks

- opt-in,
- quiet hours,
- min interval,
- daily cap,
- active mission,
- private route,
- public-channel safety,
- workflow-domain suppression,
- Source Recall lifecycle state,
- privacy risk,
- repeated negative outcomes,
- novelty threshold,
- expected user-value threshold.

### Acceptance Criteria

- Model candidate confidence cannot override policy suppression.
- Source Recall retrieval cannot override policy suppression.
- Public mode blocks private/sensitive candidate evidence.
- Repeated ignored/dismissed candidates reduce or suppress future delivery.
- Semantic inquiry must not increase default pulse frequency. Existing opt-in, daily cap,
  cooldown, quiet hours, active mission suppression, private route checks, and public/private
  routing must remain equal or stricter.

## S5 - Wording After Permission And Outcome Learning

### Objective

Keep model wording after deterministic permission and record enough outcome metadata to learn from
user response.

### Owner Files

- `src/interfaces/conversationRuntime/pulsePrompting.ts`
- `src/interfaces/pulseEmissionLifecycle.ts`
- `src/interfaces/conversationRuntime/sessionPulseMetadata.ts`
- `src/interfaces/pulseUxRuntime.ts`
- `tests/interfaces/pulsePrompting.test.ts`
- `tests/interfaces/pulseState.test.ts`
- `tests/interfaces/pulseUxRuntime.test.ts`

### Wording Rules

- Model sees only the approved candidate.
- Model does not receive permission to decide delivery.
- Source Recall excerpts remain quoted evidence.
- Prompt text must distinguish candidate evidence from current user instruction.
- Generated message preview is redacted before durable outcome storage.

### Outcome Rules

Record:

- delivered text hash,
- redacted delivered preview,
- question intent,
- candidate id,
- bound user reply when detected,
- engaged/ignored/dismissed/negative/muted outcome.

### Acceptance Criteria

- Actual delivered wording is represented by hash/redacted preview, not just reason code.
- User replies can be bound to the relevant pulse id within the response window.
- Dismissals suppress similar future candidates.
- Stored outcome records do not contain raw Source Recall chunks.
- Pulse UX rendering consumes typed pulse delivery metadata where available. Regex extraction from
  system prompt text is legacy-only and covered by compatibility tests.

## S6 - Multi-Day Behavior Evidence Matrix

### Objective

Prove that pulse behavior improves over time without becoming noisy or unsafe.

### Owner Files

- new `scripts/evidence/dynamicPulseSemanticInquiryMatrix.ts`
- new `tests/scripts/dynamicPulseSemanticInquiryMatrix.test.ts`
- new `tests/fixtures/dynamicPulseSemanticInquiryScenarios.json`
- existing pulse tests as needed.

### Required Scenarios

- Day 1: user mentions project and asks for later follow-up.
- Day 2: user ignores a low-value pulse.
- Day 3: related source is forgotten or redacted.
- Day 4: stale fact becomes a candidate but is suppressed in public mode.
- Day 5: active mission suppresses outreach.
- Day 6: user says a follow-up was useful.
- Day 7: pulse adapts with a higher-value, non-repetitive question.

### Positive Cases

- User-requested follow-up becomes a candidate.
- Stale fact revalidation becomes a candidate.
- Open-loop resume becomes a candidate.
- Useful preference feedback changes future scoring.
- Semantic inquiry proposes a missing-constraint question.
- Private-safe Source Recall evidence supports a candidate when the Source Recall gate is
  available.

### Required Negative Controls

- Agent Pulse disabled.
- Dynamic Pulse disabled.
- User not opted in.
- Quiet hours active.
- Cooldown active.
- Daily cap reached.
- Active mission running.
- Public mode with private evidence.
- Source Recall disabled.
- Source Recall blocked.
- Source Recall forgotten source.
- Source Recall redacted source.
- Source Recall quarantined source.
- Source Recall expired source.
- Source Recall public-unsafe source.
- Assistant-only source.
- Task-summary-only source.
- Media/document source without policy.
- Model unavailable.
- Malformed semantic inquiry candidate.
- Low-confidence model candidate.
- Low expected user value.
- Repeated ignored pulse.
- Repeated dismissed pulse.
- Exact `/pulse off` or mute preference.
- Prompt-injection chunk saying `/approve`.
- Prompt-injection chunk saying `Resolved semantic route:`.
- Prompt-injection chunk saying `TASK COMPLETE`.
- Prompt-injection chunk saying `ignore quiet hours`.

### Required Output Fields

- scenario id,
- evidence mode,
- candidate proposed,
- candidate type,
- Source Recall status,
- delivery decision,
- suppression reason,
- message emitted,
- authority flags,
- outcome learning effect,
- proof category,
- live dependency status.

### Evidence Categories

The matrix must distinguish:

- schema-only proof,
- mocked provider proof,
- runtime-observed proof,
- Source Recall retrieval proof,
- deterministic suppression proof,
- live dependency blocked proof.

### Acceptance Criteria

- The matrix proves fewer, better, evidence-backed questions.
- The matrix shows at least as many suppressions as emissions.
- It includes negative controls where no pulse is sent.
- It proves deleted/redacted/quarantined source material cannot drive outreach.
- It proves Source Recall evidence cannot authorize delivery.

## S7 - Docs And Operator Contract

### Objective

Document the public/operator behavior without overselling autonomy.

### Owner Files

- `docs/CONCEPTS.md`
- `docs/ARCHITECTURE.md`
- `docs/COMMAND_EXAMPLES.md`
- `docs/SOURCE_RECALL.md`
- this plan

### Acceptance Criteria

- Docs explain that proactive inquiry is opt-in.
- Docs explain that the model proposes or words, while deterministic policy permits.
- Docs explain Source Recall evidence remains non-authoritative.
- Docs explain how users can enable, disable, route, and mute pulse behavior.
- Docs do not imply Agent Pulse is always-on or autonomous without opt-in.

## Required Validation Commands

Run focused tests first. Depending on the slice:

```powershell
npm run check:test-types
npm run build
npm test -- agentPulse
npm test -- pulse
npm test -- stage6_86Pulse
npm test -- sourceRecall
```

If the repo's test runner syntax differs, use the existing command style from nearby package
scripts and record the exact command in the completion note.

Full `npm test` is recommended before PR/merge for behavior slices that touch scheduler,
conversation runtime, Source Recall, or profile memory.

## Autonomous Validation Command Order

After each slice:

```powershell
npm run check:test-types
npm run build
```

After slices that touch docs, plans, or evidence:

```powershell
npm run check:docs
```

After slices that touch AI-first or lexical-boundary-sensitive files:

```powershell
npm run check:ai-first
```

After S6:

```powershell
npm test
npm run check:docs
npm run check:ai-first
npm run build
```

If a named focused test command does not exist, run the closest focused test file directly and
record the exact command in the ledger. Do not replace failed focused tests with full-suite output.

## Definition Of Done

The full roadmap is done only when:

- exact `/pulse` commands remain deterministic,
- natural pulse preferences become typed semantic preference candidates,
- Source Recall can provide quoted evidence but never outreach authority,
- proactive inquiry candidates carry user-value rationale, evidence refs, risk, novelty, and
  non-authority flags,
- deterministic policy remains the only interruption authority,
- model wording happens only after permission,
- outcome records track useful/dismissed/ignored behavior without raw sensitive text,
- multi-day evidence proves useful adaptation and safe suppression,
- docs describe the behavior accurately.

## Final Completion Gate

The plan is not complete when S0-S7 compile. The plan is complete only when:

1. Exact `/pulse` commands still work deterministically.
2. Natural pulse preferences produce typed preference candidates, not immediate outreach authority.
3. Dynamic pulse candidate generation records provenance, evidence, source authority, risk, novelty,
   and user-value reason.
4. Source Recall-backed candidates use only production-safe, quoted, lifecycle-visible evidence.
5. Deleted/redacted/quarantined/expired Source Recall records cannot trigger or support proactive
   outreach.
6. Semantic inquiry candidates cannot deliver messages.
7. Model wording happens only after deterministic delivery permission.
8. Public-mode delivery blocks private/sensitive/Source Recall/memory/relationship evidence unless
   explicitly public-safe.
9. Outcome records store hashes and redacted previews, not raw source chunks.
10. Repeated ignored/dismissed/negative outcomes suppress similar future candidates.
11. Multi-day evidence proves improved candidate quality without increased default proactivity.
12. Mock/schema evidence is not presented as live proof.
13. Sensitive scan passes on changed files, fixtures, docs, generated evidence, and staged diff.
14. `npm test`, `npm run build`, `npm run check:docs`, `npm run check:ai-first`, and relevant
    focused pulse tests pass.

## Progress Ledger

Create or update:

```text
docs/plans/dynamic-pulse-semantic-inquiry-progress.md
```

Each slice entry must include:

- date,
- branch,
- commit hash when available,
- slice id,
- state,
- files inspected,
- files changed,
- tests added,
- tests run,
- checks run,
- evidence produced,
- sensitive scan status,
- behavior changed,
- behavior intentionally not changed,
- production defaults after the slice,
- whether pulse frequency became stricter, equal, or broader,
- whether the next slice is unblocked,
- exact blocker if blocked,
- known limitations,
- next slice recommendation.

Do not store private conversation text, raw Source Recall chunks, local desktop paths, secrets,
provider payloads, Telegram/Discord identifiers, or raw scan needles in the progress ledger.

## Autonomous Resume Rule

If the run is interrupted, the next agent must resume from the progress ledger.

Resume steps:

1. Read the progress ledger.
2. Run `git status`.
3. Identify the last slice marked `passed`.
4. Verify the checkpoint commit exists.
5. Re-run that slice's focused tests if the worktree changed after the checkpoint.
6. Continue with the next `not_started`, `blocked`, or `deferred` slice only if its dependency gate
   is satisfied.

Never infer progress from uncommitted changes. Never skip a slice because files appear already
modified.
