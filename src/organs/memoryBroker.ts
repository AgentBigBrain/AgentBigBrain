/**
 * @fileoverview Stable entrypoint for brokered profile-memory planner input enrichment.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import { MemoryAccessAuditStore } from "../core/memoryAccessAudit";
import { LanguageUnderstandingOrgan } from "./languageUnderstanding/episodeExtraction";
import type { ProfileEpisodeStatus } from "../core/profileMemory";
import type {
  ProfileReadableEpisode,
  ProfileReadableFact
} from "../core/profileMemoryRuntime/contracts";
import type { TaskRequest } from "../core/types";
import {
  buildPlannerContextSynthesisBlock
} from "./memorySynthesis/plannerContextSynthesis";
import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./memorySynthesis/contracts";
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
  MemoryBrokerInputResult,
  MemoryBrokerOptions,
  ProbingSignalSnapshot
} from "./memoryContext/contracts";
import {
  assessDomainBoundary,
  extractCurrentUserRequest,
  registerAndAssessProbing,
  resolveProbingDetectorConfig
} from "./memoryContext/queryPlanning";

export { extractCurrentUserRequest } from "./memoryContext/queryPlanning";
export type { MemoryBrokerInputResult, MemoryBrokerOptions } from "./memoryContext/contracts";

export interface MemoryReviewEpisode {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  lastMentionedAt: string;
  resolvedAt: string | null;
  confidence: number;
  sensitive: boolean;
}

export class MemoryBrokerOrgan {
  private readonly probingDetectorConfig;
  private readonly recentProbeSignals: ProbingSignalSnapshot[] = [];

  /** Initializes the broker with deterministic profile-memory and audit dependencies. */
  constructor(
    private readonly profileMemoryStore?: ProfileMemoryStore,
    private readonly memoryAccessAuditStore = new MemoryAccessAuditStore(),
    options?: MemoryBrokerOptions,
    private readonly languageUnderstandingOrgan?: LanguageUnderstandingOrgan
  ) {
    this.probingDetectorConfig = resolveProbingDetectorConfig(options?.probingDetector);
  }

  /** Builds planner input while brokering profile context through deterministic guards. */
  async buildPlannerInput(task: TaskRequest): Promise<MemoryBrokerInputResult> {
    if (!this.profileMemoryStore) {
      return {
        userInput: task.userInput,
        profileMemoryStatus: "disabled"
      };
    }

      const currentUserRequest = extractCurrentUserRequest(task.userInput);
    const probing = registerAndAssessProbing(
      currentUserRequest,
      this.recentProbeSignals,
      this.probingDetectorConfig
    );
    this.recentProbeSignals.splice(0, this.recentProbeSignals.length, ...probing.nextSignals);

    try {
      const additionalEpisodeCandidates = this.languageUnderstandingOrgan
        ? await this.languageUnderstandingOrgan.extractEpisodeCandidates({
            text: currentUserRequest,
            sourceTaskId: task.id,
            observedAt: task.createdAt
          })
        : [];
      await this.profileMemoryStore.ingestFromTaskInput(
        task.id,
        currentUserRequest,
        task.createdAt,
        {
          additionalEpisodeCandidates
        }
      );
      const profileContext = await this.profileMemoryStore.getPlanningContext(6, currentUserRequest);
      const episodeContext = await this.profileMemoryStore.getEpisodePlanningContext(2, currentUserRequest);
      const plannerFacts = await this.profileMemoryStore.queryFactsForPlanningContext(
        3,
        currentUserRequest
      );
      const plannerEpisodes = await this.profileMemoryStore.queryEpisodesForPlanningContext(
        2,
        currentUserRequest,
        task.createdAt
      );
      const memorySynthesisContext = buildPlannerContextSynthesisBlock(
        plannerEpisodes.map((episode) => this.toMemorySynthesisEpisodeRecord(episode)),
        plannerFacts.map((fact) => this.toMemorySynthesisFactRecord(fact))
      );

      if (!profileContext && !episodeContext) {
        const domainBoundary = assessDomainBoundary(currentUserRequest, "");
        await this.recordAudit(task.id, currentUserRequest, 0, 0, 0, domainBoundary);
        if (probing.assessment.detected) {
          await this.recordProbingAudit(
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
      const assessedDomainBoundary = assessDomainBoundary(currentUserRequest, brokeredMemoryContext);
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

      await this.recordAudit(
        task.id,
        currentUserRequest,
        retrievedCount,
        retrievedEpisodeCount,
        redactedCount,
        domainBoundary
      );
      if (probing.assessment.detected) {
        await this.recordProbingAudit(
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

  /** Returns bounded remembered situations for an explicit user review request. */
  async reviewRememberedSituations(
    reviewTaskId: string,
    query: string,
    nowIso: string,
    maxEpisodes = 5
  ): Promise<readonly MemoryReviewEpisode[]> {
    if (!this.profileMemoryStore) {
      return [];
    }

    const episodes = await this.profileMemoryStore.reviewEpisodesForUser(maxEpisodes, nowIso);
    const domainBoundary = assessDomainBoundary(query, "");
    await this.recordAudit(
      reviewTaskId,
      query,
      0,
      episodes.length,
      0,
      domainBoundary
    );
    return episodes.map((episode) => ({
      episodeId: episode.episodeId,
      title: episode.title,
      summary: episode.summary,
      status: episode.status,
      lastMentionedAt: episode.lastMentionedAt,
      resolvedAt: episode.resolvedAt,
      confidence: episode.confidence,
      sensitive: episode.sensitive
    }));
  }

  /** Marks one remembered situation resolved through an explicit user instruction. */
  async resolveRememberedSituation(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ): Promise<MemoryReviewEpisode | null> {
    if (!this.profileMemoryStore) {
      return null;
    }

    const episode = await this.profileMemoryStore.updateEpisodeFromUser(
      episodeId,
      "resolved",
      sourceTaskId,
      sourceText,
      note,
      nowIso
    );
    return episode ? this.toMemoryReviewEpisode(episode) : null;
  }

  /** Marks one remembered situation as wrong or no longer relevant. */
  async markRememberedSituationWrong(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ): Promise<MemoryReviewEpisode | null> {
    if (!this.profileMemoryStore) {
      return null;
    }

    const episode = await this.profileMemoryStore.updateEpisodeFromUser(
      episodeId,
      "no_longer_relevant",
      sourceTaskId,
      sourceText,
      note,
      nowIso
    );
    return episode ? this.toMemoryReviewEpisode(episode) : null;
  }

  /** Forgets one remembered situation entirely through an explicit user instruction. */
  async forgetRememberedSituation(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string
  ): Promise<MemoryReviewEpisode | null> {
    if (!this.profileMemoryStore) {
      return null;
    }

    const episode = await this.profileMemoryStore.forgetEpisodeFromUser(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso
    );
    return episode ? this.toMemoryReviewEpisode(episode) : null;
  }

  /** Appends the probing-specific audit event when extraction-style bursts are detected. */
  private async recordProbingAudit(
    taskId: string,
    query: string,
    retrievedCount: number,
    retrievedEpisodeCount: number,
    redactedCount: number,
    domainBoundary: DomainBoundaryAssessment,
    probingAssessment: ReturnType<typeof registerAndAssessProbing>["assessment"]
  ): Promise<void> {
    await appendMemoryAccessAudit(
      this.memoryAccessAuditStore,
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
  private async recordAudit(
    taskId: string,
    query: string,
    retrievedCount: number,
    retrievedEpisodeCount: number,
    redactedCount: number,
    domainBoundary: DomainBoundaryAssessment
  ): Promise<void> {
    await appendMemoryAccessAudit(
      this.memoryAccessAuditStore,
      taskId,
      query,
      retrievedCount,
      retrievedEpisodeCount,
      redactedCount,
      domainBoundary.lanes
    );
  }

  /** Converts a readable profile-memory episode into the brokered review shape. */
  private toMemoryReviewEpisode(
    episode: Awaited<ReturnType<ProfileMemoryStore["reviewEpisodesForUser"]>>[number]
  ): MemoryReviewEpisode {
    return {
      episodeId: episode.episodeId,
      title: episode.title,
      summary: episode.summary,
      status: episode.status,
      lastMentionedAt: episode.lastMentionedAt,
      resolvedAt: episode.resolvedAt,
      confidence: episode.confidence,
      sensitive: episode.sensitive
    };
  }

  /** Converts one readable planner episode into the bounded synthesis episode shape. */
  private toMemorySynthesisEpisodeRecord(
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
  private toMemorySynthesisFactRecord(
    fact: ProfileReadableFact
  ): MemorySynthesisFactRecord {
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
}
