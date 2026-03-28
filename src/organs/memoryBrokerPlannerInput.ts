/**
 * @fileoverview Brokered planner-input assembly extracted from the memory-broker entrypoint.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import { MemoryAccessAuditStore } from "../core/memoryAccessAudit";
import { LanguageUnderstandingOrgan } from "./languageUnderstanding/episodeExtraction";
import type { ProfileReadableEpisode, ProfileReadableFact } from "../core/profileMemoryRuntime/contracts";
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
          additionalEpisodeCandidates
        }
      );
    }
    const profileContext = await deps.profileMemoryStore.getPlanningContext(6, currentUserRequest);
    const episodeContext = await deps.profileMemoryStore.getEpisodePlanningContext(
      2,
      currentUserRequest
    );
    const plannerFacts = await deps.profileMemoryStore.queryFactsForPlanningContext(
      3,
      currentUserRequest
    );
    const plannerEpisodes = await deps.profileMemoryStore.queryEpisodesForPlanningContext(
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

/** Appends the probing-specific audit event when extraction-style bursts are detected. */
async function recordProbingAudit(
  memoryAccessAuditStore: MemoryAccessAuditStore,
  taskId: string,
  query: string,
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
      retrievedEpisodeCount,
      probeSignals: probingAssessment.matchedSignals,
      probeWindowSize: probingAssessment.windowSize,
      probeMatchCount: probingAssessment.matchCount,
      probeMatchRatio: probingAssessment.matchRatio
    }
  );
}

/** Appends the standard retrieval audit event for one brokered planner-input build. */
async function recordAudit(
  memoryAccessAuditStore: MemoryAccessAuditStore,
  taskId: string,
  query: string,
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
    domainBoundary.lanes
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
