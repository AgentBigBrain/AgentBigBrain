/**
 * @fileoverview Canonical test-target groups for ergonomic and deterministic test command routing.
 */

/**
 * Defines a deterministic test target group.
 */
export interface TestTargetGroup {
  id: string;
  description: string;
  patterns: readonly string[];
}

/**
 * Canonical target map used by the generic test runner.
 */
export const TEST_TARGETS: Record<string, TestTargetGroup> = {
  all: {
    id: "all",
    description: "Run the full test suite.",
    patterns: ["tests/**/*.test.ts"]
  },
  stage1: {
    id: "stage1",
    description: "Stage 1 baseline tests.",
    patterns: [
      "tests/core/orchestrator.test.ts",
      "tests/core/stateStore.test.ts",
      "tests/core/personality.test.ts",
      "tests/core/personalityStore.test.ts",
      "tests/core/hardConstraints.test.ts",
      "tests/governors/masterGovernor.test.ts",
      "tests/models/createModelClient.test.ts",
      "tests/models/openaiModelClient.test.ts"
    ]
  },
  stage2: {
    id: "stage2",
    description: "Stage 2 safety tests.",
    patterns: [
      "tests/core/stage2Safety.test.ts",
      "tests/core/hardConstraints.test.ts",
      "tests/core/orchestrator.test.ts",
      "tests/governors/codeReviewGovernor.test.ts",
      "tests/organs/executor.test.ts"
    ]
  },
  stage2_5: {
    id: "stage2_5",
    description: "Stage 2.5 user-protected path tests.",
    patterns: [
      "tests/core/stage2_5UserProtectedPaths.test.ts",
      "tests/core/hardConstraints.test.ts",
      "tests/core/config.test.ts"
    ]
  },
  stage3: {
    id: "stage3",
    description: "Stage 3 governance tests.",
    patterns: [
      "tests/governors/masterGovernor.test.ts",
      "tests/governors/voteGate.test.ts",
      "tests/core/stage3Governance.test.ts"
    ]
  },
  stage4: {
    id: "stage4",
    description: "Stage 4 model integration tests.",
    patterns: [
      "tests/models/openaiModelClient.test.ts",
      "tests/models/createModelClient.test.ts",
      "tests/core/stage4ModelIntegration.test.ts",
      "tests/core/hardConstraints.test.ts"
    ]
  },
  stage5: {
    id: "stage5",
    description: "Stage 5 interface/runtime tests.",
    patterns: [
      "tests/interfaces/telegramAdapter.test.ts",
      "tests/interfaces/discordAdapter.test.ts",
      "tests/interfaces/discordApiUrl.test.ts",
      "tests/interfaces/discordRateLimit.test.ts",
      "tests/interfaces/runtimeConfig.test.ts",
      "tests/interfaces/invocationPolicy.test.ts",
      "tests/interfaces/invocationHints.test.ts",
      "tests/interfaces/followUpClassifier.test.ts",
      "tests/interfaces/conversationManager.test.ts",
      "tests/interfaces/sessionStore.test.ts",
      "tests/core/orchestrator.test.ts",
      "tests/core/hardConstraints.test.ts",
      "tests/organs/pulseLexicalClassifier.test.ts"
    ]
  },
  stage5_5: {
    id: "stage5_5",
    description: "Stage 5.5 Agent Friend tests.",
    patterns: [
      "tests/core/profileMemory.test.ts",
      "tests/core/commitmentSignalClassifier.test.ts",
      "tests/core/profileMemoryStore.test.ts",
      "tests/core/orchestrator.profileMemory.test.ts",
      "tests/core/hardConstraints.test.ts",
      "tests/interfaces/agentPulseScheduler.test.ts",
      "tests/interfaces/conversationManager.test.ts",
      "tests/interfaces/followUpClassifier.test.ts",
      "tests/interfaces/runtimeConfig.test.ts",
      "tests/organs/memoryBroker.test.ts"
    ]
  },
  stage6: {
    id: "stage6",
    description: "Stage 6 autonomy foundation tests.",
    patterns: ["tests/core/autonomyFoundation.test.ts"]
  },
  stage6_5: {
    id: "stage6_5",
    description: "Stage 6.5 advanced autonomy tests.",
    patterns: [
      "tests/core/advancedAutonomyFoundation.test.ts",
      "tests/core/advancedAutonomyRuntime.test.ts",
      "tests/interfaces/CheckpointReviewRunners/stage6_5Checkpoint6_13Live.test.ts",
      "tests/interfaces/CheckpointReviewRunners/stage6_5Checkpoint6_11Live.test.ts",
      "tests/core/governorDriftAudit.test.ts",
      "tests/tools/stage6_5Checkpoint6_9Live.test.ts",
      "tests/organs/reflection.test.ts",
      "tests/organs/reflectionSignalClassifier.test.ts"
    ]
  },
  stage6_75: {
    id: "stage6_75",
    description: "Stage 6.75 governed operator capability foundation tests.",
    patterns: [
      "tests/core/retrievalQuarantine.test.ts",
      "tests/core/evidenceStore.test.ts",
      "tests/core/stage6_75MissionStateMachine.test.ts",
      "tests/core/stage6_75ApprovalPolicy.test.ts",
      "tests/core/stage6_75ConnectorPolicy.test.ts",
      "tests/core/stage6_75ConsistencyPolicy.test.ts",
      "tests/core/stage6_75EgressPolicy.test.ts",
      "tests/core/normalizers/stage6_75MigrationParity.test.ts"
    ]
  },
  stage6_85: {
    id: "stage6_85",
    description: "Stage 6.85 orchestration and productization checkpoint tests.",
    patterns: [
      "tests/core/stage6_85PlaybookPolicy.test.ts",
      "tests/core/stage6_85PlaybookRuntime.test.ts",
      "tests/core/stage6_85MissionUxPolicy.test.ts",
      "tests/core/stage6_85CloneWorkflowPolicy.test.ts",
      "tests/core/stage6_85RecoveryPolicy.test.ts",
      "tests/core/stage6_85QualityGatePolicy.test.ts",
      "tests/core/stage6_85WorkflowReplayPolicy.test.ts",
      "tests/core/stage6_85LatencyPolicy.test.ts",
      "tests/core/stage6_85ObservabilityPolicy.test.ts",
      "tests/core/orchestrator.test.ts"
    ]
  },
  stage6_86: {
    id: "stage6_86",
    description: "Stage 6.86 dynamic relationship memory and threaded pulse foundation tests.",
    patterns: [
      "tests/core/stage6_86EntityGraph.test.ts",
      "tests/core/stage6_86ConversationStack.test.ts",
      "tests/core/stage6_86OpenLoops.test.ts",
      "tests/core/stage6_86PulseCandidates.test.ts",
      "tests/core/stage6_86BridgeQuestions.test.ts",
      "tests/core/stage6_86MemoryGovernance.test.ts",
      "tests/core/entityGraphStore.test.ts",
      "tests/interfaces/stage6_86UxRendering.test.ts",
      "tests/interfaces/pulseUxRuntime.test.ts",
      "tests/core/hardConstraints.test.ts",
      "tests/core/orchestrator.test.ts"
    ]
  },
  model_openai: {
    id: "model_openai",
    description: "OpenAI model client contract tests.",
    patterns: ["tests/models/openaiModelClient.test.ts"]
  },
  core: {
    id: "core",
    description: "All core-layer tests.",
    patterns: ["tests/core/**/*.test.ts"]
  },
  interfaces: {
    id: "interfaces",
    description: "All interface-layer tests.",
    patterns: ["tests/interfaces/**/*.test.ts"]
  },
  models: {
    id: "models",
    description: "All model adapter tests.",
    patterns: ["tests/models/**/*.test.ts"]
  },
  governors: {
    id: "governors",
    description: "All governor tests.",
    patterns: ["tests/governors/**/*.test.ts"]
  },
  organs: {
    id: "organs",
    description: "All organ tests.",
    patterns: ["tests/organs/**/*.test.ts"]
  }
};

/**
 * Implements `listTestTargetIds` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export function listTestTargetIds(): string[] {
  return Object.keys(TEST_TARGETS).sort((left, right) => left.localeCompare(right));
}
