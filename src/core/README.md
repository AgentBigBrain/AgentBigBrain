# Core Runtime

## Responsibility
This folder owns the shared runtime contracts, orchestration entrypoints, deterministic safety
policy, persistence primitives, memory/state helpers, and the stage-policy clusters that are still
canonical at the core layer.

The extracted `src/core/autonomy/` subsystem owns the detailed bounded-autonomy contract, but
`agentLoop.ts` remains a stable top-level entrypoint here. The extracted
`src/core/orchestration/` subsystem owns shared orchestration contracts and mission/postmortem
helpers for `orchestrator.ts` and `taskRunner.ts`. The extracted
`src/core/languageRuntime/` subsystem owns canonical deterministic non-safety tokenization,
language-profile, stop-word, and overlap-scoring helpers used by memory, continuity, and retrieval
surfaces. The extracted `src/core/constraintRuntime/` subsystem owns the remaining hard-constraint
action-family evaluators while `hardConstraints.ts` stays the stable fail-closed entrypoint. The extracted
`src/core/profileMemoryRuntime/` subsystem owns the runtime contracts plus query, commitment
matching, episodic-memory, and persistence helpers that sit between encrypted profile storage and
planner/operator surfaces. The extracted `src/core/stage6_85/` subsystem owns clustered Stage 6.85 mission-UX,
latency, observability, playbook, quality-gate, recovery, clone-workflow, workflow-replay, and
runtime-guard helpers while the matching `stage6_85*Policy.ts` entrypoints remain stable
compatibility surfaces. The extracted `src/core/stage6_86/` subsystem now owns the canonical
bridge-question, conversation-stack, entity-graph, pulse-candidate, runtime-action, runtime-state,
and shared Stage 6.86 runtime contracts while the matching `stage6_86*.ts` entrypoints remain
stable compatibility surfaces. The extracted `src/core/runtimeTypes/` subsystem now owns canonical
action, governance, task, shell, planning, persistence/evidence schema, runtime-state,
delegation/first-principles/failure-taxonomy, and interface-facing contracts while `types.ts`
remains the stable shared import surface. The
extracted `src/core/configRuntime/` subsystem now owns canonical runtime config contracts and
env-parsing helpers while `config.ts` remains the stable config entrypoint.

## Primary Files
- Orchestration and execution flow: `actionCostPolicy.ts`, `agentIdentity.ts`, `agentLoop.ts`,
  `agentPulse.ts`, `buildBrain.ts`, `executionMode.ts`, `orchestrator.ts`, `runtimeAbort.ts`,
  `runtimeTraceLogger.ts`, `taskRunner.ts`, `taskRunnerSupport.ts`.
- Extracted orchestration subsystem: `src/core/orchestration/contracts.ts`,
  `src/core/orchestration/orchestratorContinuation.ts`,
  `src/core/orchestration/orchestratorFederation.ts`,
  `src/core/orchestration/orchestratorGovernance.ts`,
  `src/core/orchestration/orchestratorExecution.ts`,
  `src/core/orchestration/orchestratorLearning.ts`,
  `src/core/orchestration/orchestratorPlanning.ts`,
  `src/core/orchestration/orchestratorReceipts.ts`,
  `src/core/orchestration/taskRunnerNetworkPreflight.ts`,
  `src/core/orchestration/taskRunnerPersistence.ts`,
  `src/core/orchestration/taskRunnerPreflight.ts`,
  `src/core/orchestration/taskRunnerProposal.ts`,
  `src/core/orchestration/taskRunnerExecution.ts`,
  `src/core/orchestration/taskRunnerGovernance.ts`,
  `src/core/orchestration/taskRunnerLifecycle.ts`,
  `src/core/orchestration/taskRunnerSummary.ts`.
- Extracted language-runtime subsystem: `src/core/languageRuntime/contracts.ts`,
  `src/core/languageRuntime/languageProfiles.ts`,
  `src/core/languageRuntime/stopWordPolicy.ts`,
  `src/core/languageRuntime/tokenization.ts`,
  `src/core/languageRuntime/queryIntentTerms.ts`,
  `src/core/languageRuntime/languageScoring.ts`.
- Extracted constraint-runtime subsystem: `src/core/constraintRuntime/contracts.ts`,
  `src/core/constraintRuntime/decisionHelpers.ts`,
  `src/core/constraintRuntime/pathConstraints.ts`,
  `src/core/constraintRuntime/processConstraints.ts`,
  `src/core/constraintRuntime/loopbackConstraints.ts`,
  `src/core/constraintRuntime/browserConstraints.ts`,
  `src/core/constraintRuntime/continuityConstraints.ts`,
  `src/core/constraintRuntime/skillConstraints.ts`.
- Autonomy foundations, planning context, and prompt classification:
  `advancedAutonomyFoundation.ts`, `advancedAutonomyRuntime.ts`, `autonomyFoundation.ts`,
  `commitmentSignalClassifier.ts`, `currentRequestExtraction.ts`, `plannerActionSchema.ts`,
  `plannerFailureStore.ts`, `verificationPromptClassifier.ts`, `workflowLearningStore.ts`.
- Extracted workflow-learning runtime subsystem: `src/core/workflowLearningRuntime/contracts.ts`,
  `src/core/workflowLearningRuntime/observationExtraction.ts`,
  `src/core/workflowLearningRuntime/observationScoring.ts`,
  `src/core/workflowLearningRuntime/patternLifecycle.ts`,
  `src/core/workflowLearningRuntime/plannerBias.ts`,
  `src/core/workflowLearningRuntime/relevanceRanking.ts`,
  `src/core/workflowLearningRuntime/skillOpportunityRanking.ts`,
  `src/core/workflowLearningRuntime/workflowInspection.ts`.
- Config, identity, and platform/runtime support: `appleSiliconRuntime.ts`, `config.ts`,
  `crossPlatformPath.ts`, `envLoader.ts`, `fileLock.ts`, `ids.ts`, `personality.ts`,
  `personalityStore.ts`, `runtimeEntropy.ts`, `sessionContext.ts`, `shellRuntimeProfile.ts`,
  `sqliteStore.ts`,
  `stateStore.ts`, `types.ts`.
- Extracted runtime-types subsystem: `src/core/runtimeTypes/actionTypes.ts`,
  `src/core/runtimeTypes/decisionSupportTypes.ts`,
  `src/core/runtimeTypes/governanceTypes.ts`,
  `src/core/runtimeTypes/governanceOutcomeTypes.ts`,
  `src/core/runtimeTypes/interfaceTypes.ts`,
  `src/core/runtimeTypes/persistenceTypes.ts`,
  `src/core/runtimeTypes/runtimeStateTypes.ts`,
  `src/core/runtimeTypes/taskPlanningTypes.ts`,
  `src/core/runtimeTypes/workflowPersistenceTypes.ts`.
- Extracted config-runtime subsystem: `src/core/configRuntime/envContracts.ts`,
  `src/core/configRuntime/configParsing.ts`,
  `src/core/configRuntime/platformProfiles.ts`.
- Deterministic safety, governance, and routing helpers: `delegationPolicy.ts`,
  `governorDriftAudit.ts`, `hardConstraintCommunicationPolicy.ts`,
  `hardConstraintParamUtils.ts`, `hardConstraintPathPolicy.ts`, `hardConstraints.ts`,
  `hardConstraintShellPolicy.ts`, `immutableTargetPolicy.ts`, `retrievalQuarantine.ts`.
- Shared data, memory, and model-routing primitives: `embeddingProvider.ts`, `entityGraphStore.ts`,
  `evidenceStore.ts`, `governanceMemory.ts`, `judgmentPatterns.ts`, `memoryAccessAudit.ts`,
  `modelRouting.ts`, `onnxEmbeddingProvider.ts`, `profileMemory.ts`, `profileMemoryCrypto.ts`,
  `profileMemoryPlanningContext.ts`, `profileMemoryStore.ts`, `semanticMemory.ts`,
  `vectorStore.ts`, `workflowLearningStore.ts`.
- `profileMemory.ts` remains the stable public entrypoint for temporal profile-memory helpers and
  now also re-exports the Phase 2.5 family-registry, proof, mutation-envelope, and retraction
  contracts so bounded callers do not have to depend on deep runtime subpaths for live policy
  shapes. Phase 3 additive graph-backed persistence contracts now enter through that same stable
  entrypoint and stay under `profileMemoryStore.ts` rather than creating a second persistence
  surface.
- Extracted profile-memory runtime subsystem: `src/core/profileMemoryRuntime/contracts.ts`,
  `src/core/profileMemoryRuntime/profileMemoryCommitmentSignals.ts`,
  `src/core/profileMemoryRuntime/profileMemoryCommitmentTopics.ts`,
  `src/core/profileMemoryRuntime/profileMemoryContactExtraction.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEncryption.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeContracts.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeExtraction.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeConsolidation.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeLinking.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeMutations.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodePlanningContext.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeNormalization.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeQueries.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeResolution.ts`,
  `src/core/profileMemoryRuntime/profileMemoryEpisodeState.ts`,
  `src/core/profileMemoryRuntime/profileMemoryConversationalSignals.ts`,
  `src/core/profileMemoryRuntime/profileMemoryExtraction.ts`,
  `src/core/profileMemoryRuntime/profileMemoryFactLifecycle.ts`,
  `src/core/profileMemoryRuntime/profileMemoryIngestProvenance.ts`,
  `src/core/profileMemoryRuntime/profileMemoryMediaIngest.ts`,
  `src/core/profileMemoryRuntime/profileMemoryMutations.ts`,
  `src/core/profileMemoryRuntime/profileMemoryNormalization.ts`,
  `src/core/profileMemoryRuntime/profileMemoryPersistence.ts`,
  `src/core/profileMemoryRuntime/profileMemoryPlanningContext.ts`,
  `src/core/profileMemoryRuntime/profileMemoryState.ts`,
  `src/core/profileMemoryRuntime/profileMemoryStateNormalization.ts`,
  `src/core/profileMemoryRuntime/profileMemoryPulse.ts`,
  `src/core/profileMemoryRuntime/profileMemoryQueries.ts`.
- Extracted Stage 6.85 subsystem: `src/core/stage6_85/cloneWorkflow.ts`,
  `src/core/stage6_85/contracts.ts`,
  `src/core/stage6_85/latency.ts`, `src/core/stage6_85/missionUx.ts`,
  `src/core/stage6_85/observability.ts`, `src/core/stage6_85/playbookIntent.ts`,
  `src/core/stage6_85/playbookPolicy.ts`, `src/core/stage6_85/playbookRegistry.ts`,
  `src/core/stage6_85/playbookRuntime.ts`, `src/core/stage6_85/playbookSeeds.ts`,
  `src/core/stage6_85/qualityGates.ts`, `src/core/stage6_85/recovery.ts`,
  `src/core/stage6_85/runtimeGuards.ts`, `src/core/stage6_85/workflowReplay.ts`.
- Extracted Stage 6.86 subsystem: `src/core/stage6_86/bridgeQuestions.ts`,
  `src/core/stage6_86/conversationStack.ts`, `src/core/stage6_86/conversationStackContracts.ts`,
  `src/core/stage6_86/conversationStackHelpers.ts`, `src/core/stage6_86/contracts.ts`,
  `src/core/stage6_86/entityGraph.ts`, `src/core/stage6_86/mediaContinuityLinking.ts`,
  `src/core/stage6_86/memoryGovernance.ts`,
  `src/core/stage6_86/openLoops.ts`, `src/core/stage6_86/pulseCandidates.ts`,
  `src/core/stage6_86/pulseCandidateSupport.ts`,
  `src/core/stage6_86/runtimeActions.ts`, `src/core/stage6_86/runtimeState.ts`.
- Federation, receipts, and schema support: `cryptoUtils.ts`, `distillerLedger.ts`,
  `executionReceipts.ts`, `federatedDelegation.ts`, `federatedOutboundDelegation.ts`,
  `satelliteClone.ts`, `schemaEnvelope.ts`.
- Stage 6.75 policy cluster: `stage6_75ApprovalPolicy.ts`, `stage6_75CheckpointLive.ts`,
  `stage6_75ConnectorPolicy.ts`, `stage6_75ConsistencyPolicy.ts`,
  `stage6_75EgressPolicy.ts`, `stage6_75MissionStateMachine.ts`.
- Stage 6.85 policy cluster: `stage6_85CloneWorkflowPolicy.ts`, `stage6_85LatencyPolicy.ts`,
  `stage6_85MissionUxPolicy.ts`, `stage6_85ObservabilityPolicy.ts`,
  `stage6_85PlaybookPolicy.ts`, `stage6_85PlaybookRuntime.ts`,
  `stage6_85QualityGatePolicy.ts`, `stage6_85RecoveryPolicy.ts`,
  `stage6_85RuntimeGuards.ts`, `stage6_85WorkflowReplayPolicy.ts`.
- Stage 6.86 policy cluster: `stage6_86BridgeQuestions.ts`, `stage6_86ConversationStack.ts`,
  `stage6_86EntityGraph.ts`, `stage6_86MemoryGovernance.ts`, `stage6_86OpenLoops.ts`,
  `stage6_86PulseCandidates.ts`, `stage6_86RuntimeActions.ts`,
  `stage6_86RuntimeStateStore.ts` (stable compatibility entrypoints over
  `src/core/stage6_86/`).

## Inputs
- user goals, execution context, and planner outputs
- environment variables, runtime config, and filesystem-backed state
- governor outcomes, action receipts, and reflection or memory signals
- transport/runtime state from higher layers that depend on core contracts

## Outputs
- canonical runtime types and deterministic policy decisions
- governed orchestration flow, task execution sequencing, and autonomy entrypoints
- persisted receipts, memory state, profile state, and stage-policy state
- shared runtime helpers consumed by `src/governors/`, `src/interfaces/`, `src/models/`, and
  `src/organs/`, including bounded episodic-memory queries and freshness-ranked unresolved
  situations for active-conversation recall, private remembered-situation review/update, bounded
  remembered-fact review/update contract passthroughs, or pulse grounding, plus the shared
  conversation-domain contract and reducers consumed by interface routing, broker integration, and
  lifecycle coordination

## Invariants
- Shared contracts belong here before they belong in higher layers.
- Deterministic safety or hard-constraint behavior must stay fail-closed and locally discoverable.
- `hardConstraints.ts` remains the stable top-level fail-closed safety entrypoint; detailed
  action-family evaluators belong in `src/core/constraintRuntime/`.
- `stage6_*` clusters should stay grouped until they receive an explicit subsystem extraction.
- Extracted Stage 6.85 helpers belong in `src/core/stage6_85/` once they stop fitting the
  top-level `stage6_85*` files.
- Extracted Stage 6.86 helpers belong in `src/core/stage6_86/` once they stop fitting the
  top-level `stage6_86*` files.
- Thin stable entrypoints such as `agentLoop.ts` and `orchestrator.ts` should remain documented
  here even when detailed ownership moves into subfolders.
- `types.ts`, `config.ts`, and the top-level `stage6_85*` or `stage6_86*` compatibility
  entrypoints are intentionally kept thin and are protected by the module-size check as stable
  import surfaces.
- Shared orchestration contracts and mission/postmortem helpers belong in
  `src/core/orchestration/` once they are reused across top-level core entrypoints.
- `taskRunnerSupport.ts` should remain a shared utility surface only when the helpers are reused
  outside orchestration; task-runner proposal, persistence, and execution helpers belong in
  `src/core/orchestration/`.
- Profile-memory runtime contracts and query, pulse, mutation, persistence, and episodic-memory
  helpers belong in `src/core/profileMemoryRuntime/` once they are reused across planner,
  operator, or interface call sites.
- Workflow-learning observation extraction, ranking, planner bias, inspection, and skill-opportunity
  helpers belong in `src/core/workflowLearningRuntime/` once they are reused across planner,
  orchestrator, or operator call sites.
- Interpreted media should enter durable memory only through bounded profile-memory and continuity
  helpers here; raw image, voice, or video payloads do not belong in the six governed memory
  systems.
- Explicit user review/correction of remembered situations should still route through stable brokered
  or interface entrypoints, not direct encrypted-store access from transport layers.
- Explicit user review/correction of bounded remembered facts should follow the same rule: stable
  orchestrator, broker, and interface entrypoints may expose contracts, but transport or gateway
  code must not bypass them for direct encrypted-store access.
- Remembered-situation resolve, wrong, and forget flows must stay bounded, deterministic, and
  approval-aware even when private user controls exist at the interface layer.
- Conversational language generalization for memory, recall, and planner-context ranking should
  route through `src/core/languageRuntime/`; this folder should not keep growing scattered ad hoc
  stop-word or tokenization rules across memory surfaces.
- Safety-critical lexical policy should remain deterministic here or in the dedicated governor or
  intent surfaces; richer human-language understanding belongs in bounded higher-level runtimes or
  organs, not in fail-closed hard-constraint code.
- Shared session-domain reducers and contracts belong here before routing, broker, or lifecycle
  layers start inventing separate per-conversation domain state.

## Related Tests
- `tests/core/agentLoop.test.ts`
- `tests/core/orchestrator.test.ts`
- `tests/core/config.test.ts`
- `tests/core/crossPlatformPath.test.ts`
- `tests/core/shellRuntimeProfile.test.ts`
- `tests/core/autonomyModules.test.ts`
- `tests/core/orchestrationModules.test.ts`
- `tests/core/languageRuntime.test.ts`
- `tests/core/orchestratorLearning.test.ts`
- `tests/core/orchestratorPlanning.test.ts`
- `tests/core/orchestratorGovernance.test.ts`
- `tests/core/runtimeTypes.test.ts`
- `tests/core/configParsing.test.ts`
- `tests/core/configPlatformProfiles.test.ts`
- `tests/core/taskRunnerPersistence.test.ts`
- `tests/core/taskRunnerPreflight.test.ts`
- `tests/core/taskRunnerProposal.test.ts`
- `tests/core/taskRunnerExecution.test.ts`
- `tests/core/taskRunnerGovernance.test.ts`
- `tests/core/taskRunnerLifecycle.test.ts`
- `tests/core/taskRunnerSummary.test.ts`
- `tests/core/profileMemoryMutations.test.ts`
- `tests/core/profileMemoryNormalization.test.ts`
- `tests/core/profileMemoryFactLifecycle.test.ts`
- `tests/core/profileMemoryEpisodeExtraction.test.ts`
- `tests/core/profileMemoryEpisodeLinking.test.ts`
- `tests/core/profileMemoryEpisodeMutations.test.ts`
- `tests/core/profileMemoryEpisodePlanningContext.test.ts`
- `tests/core/profileMemoryEpisodeQueries.test.ts`
- `tests/core/profileMemoryEpisodeResolution.test.ts`
- `tests/core/profileMemoryEpisodeConsolidation.test.ts`
- `tests/core/profileMemoryMediaIngest.test.ts`
- `tests/core/profileMemoryStateNormalization.test.ts`
- `tests/core/profileMemoryExtraction.test.ts`
- `tests/core/profileMemoryEncryption.test.ts`
- `tests/core/profileMemoryPlanningContext.test.ts`
- `tests/core/profileMemoryPersistence.test.ts`
- `tests/core/profileMemoryPulse.test.ts`
- `tests/core/profileMemoryQueries.test.ts`
- `tests/core/stage6_85CloneWorkflowPolicy.test.ts`
- `tests/core/stage6_85CloneWorkflowRuntime.test.ts`
- `tests/core/stage6_85LatencyPolicy.test.ts`
- `tests/core/stage6_85MissionUxPolicy.test.ts`
- `tests/core/stage6_85MissionUxRuntime.test.ts`
- `tests/core/stage6_85ObservabilityPolicy.test.ts`
- `tests/core/stage6_85PlaybookIntent.test.ts`
- `tests/core/stage6_85PlaybookPolicy.test.ts`
- `tests/core/stage6_85PlaybookRegistry.test.ts`
- `tests/core/stage6_85PlaybookRuntime.test.ts`
- `tests/core/stage6_85PolicyRuntime.test.ts`
- `tests/core/stage6_85QualityGatePolicy.test.ts`
- `tests/core/stage6_85RecoveryPolicy.test.ts`
- `tests/core/stage6_85RecoveryRuntime.test.ts`
- `tests/core/stage6_85RuntimeGuards.test.ts`
- `tests/core/stage6_85RuntimeGuardsRuntime.test.ts`
- `tests/core/stage6_85WorkflowReplayPolicy.test.ts`
- `tests/core/stage6_85WorkflowReplayRuntime.test.ts`
- `tests/core/stage6_86BridgeQuestions.test.ts`
- `tests/core/stage6_86ConversationStack.test.ts`
- `tests/core/stage6_86EntityGraph.test.ts`
- `tests/core/stage6_86MediaContinuityLinking.test.ts`
- `tests/core/stage6_86RuntimeActions.test.ts`
- `tests/core/stage6_86MemoryGovernance.test.ts`
- `tests/core/stage6_86OpenLoops.test.ts`
- `tests/core/stage6_86PulseCandidates.test.ts`
- `tests/core/stage6_86RuntimeStateStore.test.ts`
- `tests/core/liveRunRecovery.test.ts`
- `tests/core/loopCleanupPolicy.test.ts`
- `tests/core/sessionContext.test.ts`

## When to Update This README
Update this README when:
- a new top-level core file is added, removed, or renamed
- a shared runtime responsibility moves between `src/core/` and another top-level folder
- a stage-policy cluster is extracted into its own subsystem
- a new `src/core/stage6_85/` or `src/core/stage6_86/` cluster file is added, removed, or renamed
- a stable core entrypoint changes or the related-test expectations move materially
- hard-constraint ownership moves between `hardConstraints.ts`, `constraintRuntime/`, or the older
  `hardConstraint*Policy.ts` helpers
