import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import type { ConversationWorkerRuntimeConfig } from "../../src/interfaces/conversationRuntime/conversationWorkerRuntime";
import type {
  ConversationBrowserSessionRecord,
  ConversationJob,
  ConversationSession
} from "../../src/interfaces/sessionStore";
import type { TelegramInterfaceConfig } from "../../src/interfaces/runtimeConfig";
import type { PulseScoreBreakdownV1 } from "../../src/core/types";
import type { WorkspaceRecoverySignal } from "../../src/core/autonomy/workspaceRecoveryPolicy";

/**
 * Builds a fully shaped conversation session fixture for tests so interface/session contract
 * changes do not leave ad hoc object literals behind.
 */
export function buildConversationSessionFixture(
  overrides: Partial<ConversationSession> = {},
  seed: Partial<{
    provider: "telegram" | "discord";
    conversationId: string;
    userId: string;
    username: string;
    conversationVisibility: ConversationSession["conversationVisibility"];
    receivedAt: string;
  }> = {}
): ConversationSession {
  const provider = seed.provider ?? "telegram";
  const seededConversationId = seed.conversationId ?? "chat-1";
  const baseSession = buildSessionSeed({
    provider,
    conversationId: seededConversationId,
    userId: seed.userId ?? "user-1",
    username: seed.username ?? "agentowner",
    conversationVisibility: seed.conversationVisibility ?? "private",
    receivedAt: seed.receivedAt ?? "2026-03-07T12:00:00.000Z"
  });
  return {
    ...baseSession,
    conversationId:
      seededConversationId.startsWith(`${provider}:`)
        ? seededConversationId
        : baseSession.conversationId,
    ...overrides
  };
}

/**
 * Builds the full ingress config shape expected by conversation ingress tests.
 */
export function buildConversationIngressConfig(
  overrides: Partial<ConversationIngressDependencies["config"]> = {}
): ConversationIngressDependencies["config"] {
  return {
    allowAutonomousViaInterface: true,
    maxProposalInputChars: 5_000,
    maxConversationTurns: 20,
    maxContextTurnsForExecution: 8,
    staleRunningJobRecoveryMs: 60_000,
    maxRecentJobs: 20,
    maxRecentActions: 20,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    ...overrides
  };
}

/**
 * Builds a canonical conversation job fixture so lifecycle contract changes do not leave stale
 * inline job objects across tests.
 */
export function buildConversationJobFixture(
  overrides: Partial<ConversationJob> = {}
): ConversationJob {
  const input = overrides.input ?? "run test task";
  const executionInput = overrides.executionInput ?? input;
  return {
    id: "job-1",
    input,
    executionInput,
    createdAt: "2026-03-07T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    status: "queued",
    resultSummary: null,
    errorMessage: null,
    ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "NOT_SENT",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: null,
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 0,
    finalDeliveryLastErrorCode: null,
    finalDeliveryLastAttemptAt: null,
    ...overrides
  };
}

/**
 * Builds a fully shaped browser-session record for tracked workspace tests.
 */
export function buildConversationBrowserSessionFixture(
  overrides: Partial<ConversationBrowserSessionRecord> = {}
): ConversationBrowserSessionRecord {
  return {
    id: "browser-1",
    label: "Tracked preview",
    url: "http://127.0.0.1:4173/",
    visibility: "visible",
    status: "open",
    sourceJobId: "job-1",
    openedAt: "2026-03-07T12:00:00.000Z",
    closedAt: null,
    controllerKind: "playwright_managed",
    controlAvailable: true,
    browserProcessPid: null,
    workspaceRootPath: null,
    linkedProcessLeaseId: null,
    linkedProcessCwd: null,
    linkedProcessPid: null,
    ...overrides
  };
}

/**
 * Builds the full worker-runtime config shape expected by queue-runtime tests.
 */
export function buildConversationWorkerRuntimeConfig(
  overrides: Partial<ConversationWorkerRuntimeConfig> = {}
): ConversationWorkerRuntimeConfig {
  return {
    ackDelayMs: 5_000,
    heartbeatIntervalMs: 250,
    maxRecentJobs: 20,
    maxRecentActions: 20,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 20,
    maxContextTurnsForExecution: 8,
    showCompletionPrefix: false,
    ...overrides
  };
}

/**
 * Builds the canonical pulse-score breakdown shape used by pulse/runtime fixtures.
 */
export function buildPulseScoreBreakdownFixture(
  overrides: Partial<PulseScoreBreakdownV1> = {}
): PulseScoreBreakdownV1 {
  return {
    recency: 0.2,
    frequency: 0.1,
    unresolvedImportance: 0.1,
    sensitivityPenalty: 0,
    cooldownPenalty: 0,
    ...overrides
  };
}

/**
 * Builds a fully shaped workspace-recovery signal so test literals track recovery-contract drift.
 */
export function buildWorkspaceRecoverySignalFixture(
  overrides: Partial<WorkspaceRecoverySignal> = {}
): WorkspaceRecoverySignal {
  return {
    recommendedAction: "inspect_first",
    matchedRuleId: "workspace_recovery_fixture",
    reasoning: "Fixture reasoning.",
    question: "Inspect the workspace first?",
    recoveryInstruction: "Inspect the relevant workspace resources first.",
    trackedPreviewProcessLeaseIds: [],
    recoveredExactHolderPids: [],
    untrackedCandidatePids: [],
    untrackedCandidateKinds: [],
    untrackedCandidateNames: [],
    blockedFolderPaths: [],
    exactNonPreviewHolderPid: null,
    exactNonPreviewHolderKind: null,
    exactNonPreviewHolderName: null,
    ...overrides
  };
}

/**
 * Builds a canonical Telegram runtime config including the required media block.
 */
export function buildTelegramInterfaceConfigFixture(
  overrides: Partial<TelegramInterfaceConfig> = {}
): TelegramInterfaceConfig {
  return {
    provider: "telegram",
    security: {
      sharedSecret: "secret",
      allowedUsernames: ["agentowner"],
      allowedUserIds: [],
      rateLimitWindowMs: 60_000,
      maxEventsPerWindow: 10,
      replayCacheSize: 500,
      agentPulseTickIntervalMs: 30_000,
      ackDelayMs: 800,
      showTechnicalSummary: true,
      showSafetyCodes: true,
      showCompletionPrefix: false,
      followUpOverridePath: null,
      pulseLexicalOverridePath: null,
      allowAutonomousViaInterface: false,
      enableDynamicPulse: false,
      invocation: {
        requireNameCall: false,
        aliases: ["BigBrain"]
      }
    },
    botToken: "telegram-token",
    apiBaseUrl: "https://api.telegram.org",
    pollTimeoutSeconds: 25,
    pollIntervalMs: 500,
    streamingTransportMode: "edit",
    nativeDraftStreaming: false,
    allowedChatIds: [],
    media: {
      enabled: true,
      maxAttachments: 4,
      maxAttachmentBytes: 10_000_000,
      maxDownloadBytes: 20_000_000,
      maxVoiceSeconds: 180,
      maxVideoSeconds: 300,
      allowImages: true,
      allowVoiceNotes: true,
      allowVideos: true,
      allowDocuments: true
    },
    ...overrides
  };
}
