/**
 * @fileoverview Brokered planner-input assembly extracted from the memory-broker entrypoint.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import { MemoryAccessAuditStore } from "../core/memoryAccessAudit";
import { LanguageUnderstandingOrgan } from "./languageUnderstanding/episodeExtraction";
import type { ProfileReadableEpisode, ProfileReadableFact } from "../core/profileMemoryRuntime/contracts";
import {
  buildConversationProfileMemoryTurnId,
  buildProfileMemorySourceFingerprint
} from "../core/profileMemoryRuntime/profileMemoryIngestProvenance";
import { createProfileMemoryRequestTelemetry } from "../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import type { TaskRequest } from "../core/types";
import { buildPlannerContextSynthesisBlock } from "./memorySynthesis/plannerContextSynthesis";
import type { MemorySynthesisEpisodeRecord, MemorySynthesisFactRecord } from "./memorySynthesis/contracts";
import { appendMemoryAccessAudit } from "./memoryContext/auditEvents";
import {
  buildInjectedContextPacket,
  buildSuppressedContextPacket,
  countRetrievedProfileFacts,
  sanitizeProfileContextForModelEgress
} from "./memoryContext/contextInjection";
import {
  countRetrievedEpisodeSummaries,
  sanitizeEpisodeContextForModelEgress
} from "./memoryContext/episodeContextInjection";
import type {
  DomainBoundaryAssessment,
  MemoryBrokerBuildInputOptions,
  MemoryBrokerInputResult,
  MemoryBrokerOptions,
  ProbingSignalSnapshot
} from "./memoryContext/contracts";
import {
  assessDomainBoundary,
  extractCurrentUserRequest,
  registerAndAssessProbing,
  resolveProbingDetectorConfig,
  shouldSkipProfileMemoryIngest
} from "./memoryContext/queryPlanning";

export interface MemoryBrokerPlannerInputDependencies {
  profileMemoryStore?: ProfileMemoryStore;
  memoryAccessAuditStore: MemoryAccessAuditStore;
  languageUnderstandingOrgan?: LanguageUnderstandingOrgan;
  probingDetectorConfig: ReturnType<typeof resolveProbingDetectorConfig>;
  recentProbeSignals: ProbingSignalSnapshot[];
}

interface BrokerProfileMemoryReadSession {
  getPlanningContext(maxFacts?: number, queryInput?: string): Promise<string> | string;
  getEpisodePlanningContext(
    maxEpisodes?: number,
    queryInput?: string,
    nowIso?: string
  ): Promise<string> | string;
  queryFactsForPlanningContext(
    maxFacts?: number,
    queryInput?: string
  ): Promise<readonly ProfileReadableFact[]> | readonly ProfileReadableFact[];
  queryEpisodesForPlanningContext(
    maxEpisodes?: number,
    queryInput?: string,
    nowIso?: string
  ): Promise<readonly ProfileReadableEpisode[]> | readonly ProfileReadableEpisode[];
}

/**
 * Opens one broker-scoped profile-memory read facade, preferring request-scoped snapshot reuse when
 * the concrete store supports it while keeping older store doubles compatible.
 *
 * @param store - Profile-memory store or compatible test double.
 * @returns Read facade used by planner-input assembly.
 */
async function openBrokerProfileMemoryReadSession(
  store: ProfileMemoryStore,
  storeTelemetry?: import("../core/profileMemoryRuntime/contracts").ProfileMemoryRequestTelemetry
): Promise<BrokerProfileMemoryReadSession> {
  const sessionFactory = (store as ProfileMemoryStore & {
    openReadSession?: (
      requestTelemetry?: import("../core/profileMemoryRuntime/contracts").ProfileMemoryRequestTelemetry
    ) => Promise<BrokerProfileMemoryReadSession>;
  }).openReadSession;
  if (typeof sessionFactory === "function") {
    return sessionFactory.call(store, storeTelemetry);
  }
  return {
    getPlanningContext: (maxFacts = 6, queryInput = "") =>
      store.getPlanningContext(maxFacts, queryInput),
    getEpisodePlanningContext: (maxEpisodes = 2, queryInput = "", nowIso = new Date().toISOString()) =>
      store.getEpisodePlanningContext(maxEpisodes, queryInput, nowIso),
    queryFactsForPlanningContext: (maxFacts = 6, queryInput = "") =>
      store.queryFactsForPlanningContext(maxFacts, queryInput),
    queryEpisodesForPlanningContext: (
      maxEpisodes = 2,
      queryInput = "",
      nowIso = new Date().toISOString()
    ) => store.queryEpisodesForPlanningContext(maxEpisodes, queryInput, nowIso)
  };
}

/**
 * Builds brokered planner input while keeping the entrypoint free of orchestration detail.
 *
 * @param task - Current task request.
 * @param options - Session-domain routing hints.
 * @param deps - Broker dependencies and mutable probing state.
 * @returns Planner input plus memory-status classification.
 */
export async function buildBrokeredPlannerInput(
  task: TaskRequest,
  options: MemoryBrokerBuildInputOptions,
  deps: MemoryBrokerPlannerInputDependencies
): Promise<MemoryBrokerInputResult> {
  if (!deps.profileMemoryStore) {
    return {
      userInput: task.userInput,
      profileMemoryStatus: "disabled"
    };
  }

  const currentUserRequest = extractCurrentUserRequest(task.userInput);
  const probing = registerAndAssessProbing(
    currentUserRequest,
    deps.recentProbeSignals,
    deps.probingDetectorConfig
  );
  deps.recentProbeSignals.splice(0, deps.recentProbeSignals.length, ...probing.nextSignals);
  const shouldSkipProfileIngest = shouldSkipProfileMemoryIngest(
    currentUserRequest,
    options.sessionDomainContext
  );

  try {
    const requestTelemetry = createProfileMemoryRequestTelemetry();
    const sourceFingerprint = buildProfileMemorySourceFingerprint(currentUserRequest);
    const conversationId = options.sessionDomainContext?.conversationId;
    const additionalEpisodeCandidates = !shouldSkipProfileIngest && deps.languageUnderstandingOrgan
      ? await deps.languageUnderstandingOrgan.extractEpisodeCandidates({
          text: currentUserRequest,
          sourceTaskId: task.id,
          observedAt: task.createdAt
        })
      : [];
    if (!shouldSkipProfileIngest) {
      await deps.profileMemoryStore.ingestFromTaskInput(
        task.id,
        currentUserRequest,
        task.createdAt,
        {
          additionalEpisodeCandidates,
          provenance: {
            conversationId,
            turnId: conversationId
              ? buildConversationProfileMemoryTurnId(
                  conversationId,
                  task.createdAt,
                  sourceFingerprint
                )
              : task.id,
            dominantLaneAtWrite: options.sessionDomainContext?.dominantLane ?? null,
            sourceSurface: "broker_task_ingest",
            sourceFingerprint
          },
          requestTelemetry
        }
      );
    }
    const readSession = await openBrokerProfileMemoryReadSession(
      deps.profileMemoryStore,
      requestTelemetry
    );
    const profileContext = await readSession.getPlanningContext(6, currentUserRequest);
    const episodeContext = await readSession.getEpisodePlanningContext(
      2,
      currentUserRequest,
      task.createdAt
    );
    const plannerFacts = await readSession.queryFactsForPlanningContext(
      3,
      currentUserRequest
    );
    const plannerEpisodes = await readSession.queryEpisodesForPlanningContext(
      2,
      currentUserRequest,
      task.createdAt
    );
    const memorySynthesisContext = buildPlannerContextSynthesisBlock(
      plannerEpisodes.map((episode) => toMemorySynthesisEpisodeRecord(episode)),
      plannerFacts.map((fact) => toMemorySynthesisFactRecord(fact))
    );

    if (!profileContext && !episodeContext) {
      const domainBoundary = assessDomainBoundary(
        currentUserRequest,
        "",
        options.sessionDomainContext
      );
      await recordAudit(
        deps.memoryAccessAuditStore,
        task.id,
        currentUserRequest,
        requestTelemetry.storeLoadCount,
        0,
        0,
        0,
        domainBoundary
      );
      if (probing.assessment.detected) {
        await recordProbingAudit(
          deps.memoryAccessAuditStore,
          task.id,
          currentUserRequest,
          requestTelemetry.storeLoadCount,
          0,
          0,
          0,
          domainBoundary,
          probing.assessment
        );
      }
      return {
        userInput: task.userInput,
        profileMemoryStatus: "available"
      };
    }

    const sanitizedProfileContext = sanitizeProfileContextForModelEgress(profileContext);
    const sanitizedEpisodeContext = sanitizeEpisodeContextForModelEgress(episodeContext);
    const brokeredMemoryContext = [
      sanitizedProfileContext.sanitizedContext,
      sanitizedEpisodeContext.sanitizedContext
    ]
      .filter((section) => section.trim().length > 0)
      .join("\n");
    const assessedDomainBoundary = assessDomainBoundary(
      currentUserRequest,
      brokeredMemoryContext,
      options.sessionDomainContext
    );
    const domainBoundary: DomainBoundaryAssessment = probing.assessment.detected
      ? {
          ...assessedDomainBoundary,
          decision: "suppress_profile_context",
          reason: "probing_detected"
        }
      : assessedDomainBoundary;
    const retrievedCount = countRetrievedProfileFacts(profileContext);
    const retrievedEpisodeCount = countRetrievedEpisodeSummaries(episodeContext);
    const redactedCount =
      sanitizedProfileContext.redactedFieldCount + sanitizedEpisodeContext.redactedFieldCount;

    await recordAudit(
      deps.memoryAccessAuditStore,
      task.id,
      currentUserRequest,
      requestTelemetry.storeLoadCount,
      retrievedCount,
      retrievedEpisodeCount,
      redactedCount,
      domainBoundary
    );
    if (probing.assessment.detected) {
      await recordProbingAudit(
        deps.memoryAccessAuditStore,
        task.id,
        currentUserRequest,
        requestTelemetry.storeLoadCount,
        retrievedCount,
        retrievedEpisodeCount,
        redactedCount,
        domainBoundary,
        probing.assessment
      );
    }

    if (domainBoundary.decision === "suppress_profile_context") {
      return {
        userInput: buildSuppressedContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          domainBoundary.reason
        ),
        profileMemoryStatus: "available"
      };
    }

    const egressGuardFooter =
      redactedCount > 0
        ? `\n[AgentFriendProfileEgressGuard]\nredactedSensitiveFields=${redactedCount}`
        : "";
    const brokeredContext = `${sanitizedProfileContext.sanitizedContext}${egressGuardFooter}`;

    return {
      userInput: buildInjectedContextPacket(
        task,
        domainBoundary.lanes,
        domainBoundary.scores,
        domainBoundary.reason,
        brokeredContext,
        sanitizedEpisodeContext.sanitizedContext,
        memorySynthesisContext
      ),
      profileMemoryStatus: "available"
    };
  } catch (error) {
    console.error(
      `[MemoryBroker] non-fatal profile-memory brokerage failure for task ${task.id}: ${(error as Error).message}`
    );
    return {
      userInput: [
        task.userInput,
        "",
        "[AgentFriendProfileStatus]",
        "mode=degraded_unavailable",
        "reason=profile_memory_unavailable"
      ].join("\n"),
      profileMemoryStatus: "degraded_unavailable"
    };
  }
}

/** Appends the standard retrieval audit event for one brokered planner-input build. */
async function recordAudit(
  memoryAccessAuditStore: MemoryAccessAuditStore,
  taskId: string,
  query: string,
  storeLoadCount: number,
  retrievedCount: number,
  retrievedEpisodeCount: number,
  redactedCount: number,
  domainBoundary: DomainBoundaryAssessment
): Promise<void> {
  await appendMemoryAccessAudit(
    memoryAccessAuditStore,
    taskId,
    query,
    retrievedCount,
    retrievedEpisodeCount,
    redactedCount,
    domainBoundary.lanes,
    {
      storeLoadCount
    }
  );
}

/** Appends the probing-specific audit event when extraction-style bursts are detected. */
async function recordProbingAudit(
  memoryAccessAuditStore: MemoryAccessAuditStore,
  taskId: string,
  query: string,
  storeLoadCount: number,
  retrievedCount: number,
  retrievedEpisodeCount: number,
  redactedCount: number,
  domainBoundary: DomainBoundaryAssessment,
  probingAssessment: ReturnType<typeof registerAndAssessProbing>["assessment"]
): Promise<void> {
  await appendMemoryAccessAudit(
    memoryAccessAuditStore,
    taskId,
    query,
    retrievedCount,
    retrievedEpisodeCount,
    redactedCount,
    domainBoundary.lanes,
    {
      eventType: "PROBING_DETECTED",
      storeLoadCount,
      retrievedEpisodeCount,
      probeSignals: probingAssessment.matchedSignals,
      probeWindowSize: probingAssessment.windowSize,
      probeMatchCount: probingAssessment.matchCount,
      probeMatchRatio: probingAssessment.matchRatio
    }
  );
}

/** Converts one readable planner episode into the bounded synthesis episode shape. */
function toMemorySynthesisEpisodeRecord(
  episode: ProfileReadableEpisode
): MemorySynthesisEpisodeRecord {
  return {
    episodeId: episode.episodeId,
    title: episode.title,
    summary: episode.summary,
    status: episode.status,
    lastMentionedAt: episode.lastMentionedAt,
    entityRefs: [...episode.entityRefs],
    entityLinks: episode.entityRefs.map((entityRef: string, index: number) => ({
      entityKey: `episode_entity_${episode.episodeId}_${index}`,
      canonicalName: entityRef
    })),
    openLoopLinks: episode.openLoopRefs.map((loopId: string, index: number) => ({
      loopId,
      threadKey: `episode_thread_${episode.episodeId}_${index}`,
      status: episode.status === "resolved" ? "resolved" : "open",
      priority: 1
    }))
  };
}

/** Converts one readable planner fact into the bounded synthesis fact shape. */
function toMemorySynthesisFactRecord(fact: ProfileReadableFact): MemorySynthesisFactRecord {
  return {
    factId: fact.factId,
    key: fact.key,
    value: fact.value,
    status: fact.status,
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence
  };
}
