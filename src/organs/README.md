# Organs Layer

## Responsibility
This folder owns the runtime "organs" that plan, execute, interpret intent, broker memory, and
reflect on task outcomes.

The extracted `src/organs/liveRun/`, `src/organs/executionRuntime/`,
`src/organs/plannerPolicy/`, `src/organs/memoryContext/`, `src/organs/reflectionRuntime/`,
`src/organs/intentRuntime/`, `src/organs/mediaUnderstanding/`, and `src/organs/skillRegistry/`
subsystems own detailed
live-run, non-live-run execution, planner-policy, memory-broker, reflection-runtime,
intent-runtime, bounded media-understanding, and skill registry/inspection support modules; the
top-level files here keep the stable orchestration entrypoints and remaining single-surface organs.
`plannerSupport.ts` now holds shared planner timeout, environment, and lesson-distillation helpers
so `planner.ts` stays under the entrypoint size budget.
`plannerEagerFallbackSupport.ts` and `plannerDeterministicFallbackSupport.ts` now hold the shared
exact-resource fallback selection and fallback-plan finalization helpers so `planner.ts` can stay
focused on the orchestration contract instead of repeating fallback validation boilerplate.

## Primary Files
- Stable orchestration entrypoints: `executor.ts`, `planner.ts`.
- Planner entrypoint support: `plannerSupport.ts`, `plannerEagerFallbackSupport.ts`,
  `plannerDeterministicFallbackSupport.ts`.
- Non-live-run execution subsystem: `executionRuntime/contracts.ts`,
  `executionRuntime/fileMutationExecution.ts`, `executionRuntime/skillRuntime.ts`,
  `executionRuntime/shellExecution.ts`.
- Skill registry subsystem: `skillRegistry/contracts.ts`, `skillRegistry/skillInspection.ts`,
  `skillRegistry/skillLifecycle.ts`, `skillRegistry/skillManifest.ts`,
  `skillRegistry/skillRegistryStore.ts`, `skillRegistry/skillSuggestionPolicy.ts`,
  `skillRegistry/skillVerification.ts`, `skillRegistry/skillVerificationContracts.ts`,
  `skillRegistry/workflowSkillBridge.ts`.
- Memory brokerage subsystem: `memoryBrokerPlannerInput.ts`, `memoryContext/contracts.ts`,
  `memoryContext/queryPlanning.ts`, `memoryContext/queryPlanningProbing.ts`,
  `memoryContext/queryPlanningDomainBoundary.ts`, `memoryContext/contextInjection.ts`,
  `memoryContext/auditEvents.ts`.
- Media understanding subsystem: `mediaUnderstanding/contracts.ts`,
  `mediaUnderstanding/imageUnderstanding.ts`, `mediaUnderstanding/speechToText.ts`,
  `mediaUnderstanding/videoUnderstanding.ts`, `mediaUnderstanding/mediaInterpretation.ts`,
  `mediaUnderstanding/mediaModelFallback.ts`.
- Reflection runtime subsystem: `reflectionRuntime/contracts.ts`,
  `reflectionRuntime/failureLessons.ts`, `reflectionRuntime/successLessons.ts`,
  `reflectionRuntime/signalClassification.ts`.
- Intent runtime subsystem: `intentRuntime/contracts.ts`, `intentRuntime/pulseLexicalRules.ts`,
  `intentRuntime/intentModelFallback.ts`.
- Intent classification entrypoints: `intentInterpreter.ts`, `pulseLexicalClassifier.ts`.
- Runtime support organs: `memoryBroker.ts`, `reflection.ts`.

## Inputs
- user goals, current request context, and orchestrator-governed runtime metadata
- model outputs, memory signals, and reflection events
- typed action definitions and planner schema contracts from `src/core/`

## Outputs
- executable action plans and fail-closed fallback responses
- action execution dispatch and live-run capability routing
- memory context packets, bounded remembered-situation review and mutation brokerage, bounded media
  interpretations, reflection lessons, and pulse-intent classification
- governed skill manifests, verification state, inventory summaries, and workflow-linked preferred
  skill suggestions
- explicit remembered-situation and remembered-fact review/update brokerage so private interface
  controls can resolve, correct, or forget episodic memory and bounded profile facts through
  stable organ boundaries
- additive proof-bearing review and mutation brokerage so hidden fact-review decisions and bounded
  mutation envelopes can cross the stable organ boundary without forcing user-facing review
  rendering to adopt a new prompt or journal contract early

## Invariants
- `planner.ts` and `executor.ts` remain stable thin entrypoints; detailed policy or capability logic
  belongs in `plannerPolicy/`, `executionRuntime/`, and `liveRun/`.
- `planner.ts` is intentionally guarded by the module-size check as a stable top-level planning
  coordinator.
- `executor.ts` is intentionally guarded by the module-size check as a stable top-level execution
  coordinator.
- Planner action normalization, explicit-action intent inference, planner failure cooldown policy,
  and Markdown skill guidance injection belong in `plannerPolicy/`, not in new top-level helper
  files.
- `memoryBroker.ts` remains the stable broker entrypoint; detailed query planning, context
  injection, audit helpers, and planner-input assembly belong in `memoryContext/` and
  `memoryBrokerPlannerInput.ts`.
- Explicit user review/correction/forget flows for remembered situations and bounded remembered
  facts should stay brokered through `memoryBroker.ts`; transport layers must not reach directly
  into encrypted profile-memory storage.
- Remembered-situation resolve, wrong, and forget flows should stay explicit and deterministic at
  the broker boundary; `memoryBroker.ts` should not silently rewrite episodic memory.
- When store-side review or mutation proof becomes live, `memoryBroker.ts` should preserve it
  additively instead of flattening bounded decision records or mutation envelopes back into
  untyped review rows.
- Future richer language understanding should converge under bounded `languageUnderstanding/` and
  `memorySynthesis/` organs rather than adding more bespoke lexical heuristics across unrelated
  organs.
- Bounded image/video/voice interpretation belongs in `mediaUnderstanding/`; transport or memory
  layers should consume interpreted summaries, not reinvent provider-specific media parsing.
- Skill manifests, inventory summaries, verification state, and workflow-linked preferred-skill
  summaries belong in `skillRegistry/`; top-level organs should consume those stable surfaces
  instead of re-inventing skill discovery or trust logic inline.
- `intentRuntime/pulseLexicalRules.ts` stays a deterministic lexical gate; human-centric proactive
  utility scoring belongs in a separate bounded runtime, not in the fail-closed pulse rulepack.
- `reflection.ts` remains the stable reflection coordinator; detailed signal classification and
  model-prompt logic belong in `reflectionRuntime/`.
- `intentInterpreter.ts` and `pulseLexicalClassifier.ts` remain stable intent entrypoints;
  detailed lexical rules, override loading, and model fallback belong in `intentRuntime/`.
- Remaining top-level organs should stay single-purpose; if one grows into a multi-surface system,
  extract a subsystem instead of hiding more branches here.
- Memory and reflection behavior should remain explicit rather than being inferred from planner or
  executor internals.

## Related Tests
- `tests/organs/planner.test.ts`
- `tests/organs/plannerPolicy.test.ts`
- `tests/organs/plannerActionNormalization.test.ts`
- `tests/organs/plannerExplicitActionIntent.test.ts`
- `tests/organs/plannerSkillActionNormalization.test.ts`
- `tests/organs/executor.test.ts`
- `tests/organs/liveRunHandlers.test.ts`
- `tests/organs/memoryBroker.test.ts`
- `tests/organs/memoryContextQueryPlanning.test.ts`
- `tests/organs/memoryContextContextInjection.test.ts`
- `tests/organs/mediaUnderstanding.test.ts`
- `tests/organs/reflection.test.ts`
- `tests/organs/intentInterpreter.test.ts`
- `tests/organs/pulseLexicalClassifier.test.ts`
- `tests/organs/intentModelFallback.test.ts`
- `tests/models/mockModelClient.test.ts`

## When to Update This README
Update this README when:
- a top-level organ file is added, removed, or renamed
- ownership moves between this folder and `executionRuntime/`, `liveRun/`, `plannerPolicy/`, or
  `memoryContext/`
- ownership moves between this folder and `mediaUnderstanding/`
- ownership moves between this folder and `skillRegistry/`
- a remaining top-level organ is extracted into a new subsystem
- the related-test surface changes because organ ownership moved
