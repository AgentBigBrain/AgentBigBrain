# Core Runtime

## Responsibility
This folder owns the shared runtime contracts, orchestration entrypoints, deterministic safety
policy, persistence primitives, memory/state helpers, and the stage-policy clusters that are still
canonical at the core layer.

The extracted `src/core/autonomy/` subsystem owns the detailed bounded-autonomy contract, but
`agentLoop.ts` remains a stable top-level entrypoint here.

## Primary Files
- Orchestration and execution flow: `actionCostPolicy.ts`, `agentIdentity.ts`, `agentLoop.ts`,
  `agentPulse.ts`, `buildBrain.ts`, `executionMode.ts`, `orchestrator.ts`, `runtimeAbort.ts`,
  `runtimeTraceLogger.ts`, `taskRunner.ts`, `taskRunnerSupport.ts`.
- Autonomy foundations, planning context, and prompt classification:
  `advancedAutonomyFoundation.ts`, `advancedAutonomyRuntime.ts`, `autonomyFoundation.ts`,
  `commitmentSignalClassifier.ts`, `currentRequestExtraction.ts`, `plannerActionSchema.ts`,
  `plannerFailureStore.ts`, `verificationPromptClassifier.ts`, `workflowLearningStore.ts`.
- Config, identity, and platform/runtime support: `appleSiliconRuntime.ts`, `config.ts`,
  `envLoader.ts`, `fileLock.ts`, `ids.ts`, `personality.ts`, `personalityStore.ts`,
  `runtimeEntropy.ts`, `shellRuntimeProfile.ts`, `sqliteStore.ts`, `stateStore.ts`, `types.ts`.
- Deterministic safety, governance, and routing helpers: `delegationPolicy.ts`,
  `governorDriftAudit.ts`, `hardConstraintCommunicationPolicy.ts`,
  `hardConstraintParamUtils.ts`, `hardConstraintPathPolicy.ts`, `hardConstraints.ts`,
  `hardConstraintShellPolicy.ts`, `immutableTargetPolicy.ts`, `retrievalQuarantine.ts`.
- Shared data, memory, and model-routing primitives: `embeddingProvider.ts`, `entityGraphStore.ts`,
  `evidenceStore.ts`, `governanceMemory.ts`, `judgmentPatterns.ts`, `memoryAccessAudit.ts`,
  `modelRouting.ts`, `onnxEmbeddingProvider.ts`, `profileMemory.ts`, `profileMemoryCrypto.ts`,
  `profileMemoryPlanningContext.ts`, `profileMemoryStore.ts`, `semanticMemory.ts`,
  `vectorStore.ts`.
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
  `stage6_86RuntimeStateStore.ts`.

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
  `src/organs/`

## Invariants
- Shared contracts belong here before they belong in higher layers.
- Deterministic safety or hard-constraint behavior must stay fail-closed and locally discoverable.
- `stage6_*` clusters should stay grouped until they receive an explicit subsystem extraction.
- Thin stable entrypoints such as `agentLoop.ts` and `orchestrator.ts` should remain documented
  here even when detailed ownership moves into subfolders.

## Related Tests
- `tests/core/agentLoop.test.ts`
- `tests/core/orchestrator.test.ts`
- `tests/core/config.test.ts`
- `tests/core/shellRuntimeProfile.test.ts`
- `tests/core/autonomyModules.test.ts`
- `tests/core/liveRunRecovery.test.ts`
- `tests/core/loopCleanupPolicy.test.ts`

## When to Update This README
Update this README when:
- a new top-level core file is added, removed, or renamed
- a shared runtime responsibility moves between `src/core/` and another top-level folder
- a stage-policy cluster is extracted into its own subsystem
- a stable core entrypoint changes or the related-test expectations move materially
