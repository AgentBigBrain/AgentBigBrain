/**
 * @fileoverview Stable entrypoint for brokered profile-memory planner input enrichment.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import { MemoryAccessAuditStore } from "../core/memoryAccessAudit";
import { LanguageUnderstandingOrgan } from "./languageUnderstanding/episodeExtraction";
import type { ProfileEpisodeStatus } from "../core/profileMemory";
import type { ProfileMemoryQueryDecisionRecord } from "../core/profileMemoryRuntime/profileMemoryDecisionRecordContracts";
import type { ProfileMemoryMutationEnvelope } from "../core/profileMemoryRuntime/profileMemoryMutationEnvelopeContracts";
import type { TaskRequest } from "../core/types";
import type {
  MemoryBrokerBuildInputOptions,
  MemoryBrokerInputResult,
  MemoryBrokerOptions,
  ProbingSignalSnapshot
} from "./memoryContext/contracts";
import { assessDomainBoundary, resolveProbingDetectorConfig } from "./memoryContext/queryPlanning";
import { appendMemoryAccessAudit } from "./memoryContext/auditEvents";
import { buildBrokeredPlannerInput } from "./memoryBrokerPlannerInput";

export { extractCurrentUserRequest } from "./memoryContext/queryPlanning";
export type {
  MemoryBrokerBuildInputOptions,
  MemoryBrokerInputResult,
  MemoryBrokerOptions
} from "./memoryContext/contracts";

export interface MemoryReviewEpisode {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  lastMentionedAt: string;
  resolvedAt: string | null;
  confidence: number;
  sensitive: boolean;
  mutationEnvelope?: ProfileMemoryMutationEnvelope;
}

export interface MemoryReviewFact {
  factId: string;
  key: string;
  value: string;
  status: string;
  confidence: number;
  sensitive: boolean;
  observedAt: string;
  lastUpdatedAt: string;
  decisionRecord?: ProfileMemoryQueryDecisionRecord;
  mutationEnvelope?: ProfileMemoryMutationEnvelope;
}

export interface MemoryReviewFactResult extends ReadonlyArray<MemoryReviewFact> {
  hiddenDecisionRecords: readonly ProfileMemoryQueryDecisionRecord[];
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
  async buildPlannerInput(
    task: TaskRequest,
    options: MemoryBrokerBuildInputOptions = {}
  ): Promise<MemoryBrokerInputResult> {
    return buildBrokeredPlannerInput(task, options, {
      profileMemoryStore: this.profileMemoryStore,
      memoryAccessAuditStore: this.memoryAccessAuditStore,
      languageUnderstandingOrgan: this.languageUnderstandingOrgan,
      probingDetectorConfig: this.probingDetectorConfig,
      recentProbeSignals: this.recentProbeSignals
    });
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

  /** Returns bounded remembered facts for an explicit user review request. */
  async reviewRememberedFacts(
    reviewTaskId: string,
    query: string,
    nowIso: string,
    maxFacts = 5
  ): Promise<MemoryReviewFactResult> {
    if (!this.profileMemoryStore) {
      return Object.assign([], {
        hiddenDecisionRecords: []
      }) as MemoryReviewFactResult;
    }

    const review = await this.profileMemoryStore.reviewFactsForUser(query, maxFacts, nowIso);
    const domainBoundary = assessDomainBoundary(query, "");
    await this.recordAudit(
      reviewTaskId,
      query,
      review.entries.length,
      0,
      review.hiddenDecisionRecords.length,
      domainBoundary
    );
    return Object.assign(
      review.entries.map((entry) =>
        this.toMemoryReviewFact(entry.fact, {
          decisionRecord: entry.decisionRecord
        })
      ),
      {
        hiddenDecisionRecords: review.hiddenDecisionRecords
      }
    ) as MemoryReviewFactResult;
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

    const result = await this.profileMemoryStore.updateEpisodeFromUser(
      episodeId,
      "resolved",
      sourceTaskId,
      sourceText,
      note,
      nowIso
    );
    return result.episode
      ? this.toMemoryReviewEpisode(result.episode, {
          mutationEnvelope: result.mutationEnvelope
        })
      : null;
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

    const result = await this.profileMemoryStore.updateEpisodeFromUser(
      episodeId,
      "no_longer_relevant",
      sourceTaskId,
      sourceText,
      note,
      nowIso
    );
    return result.episode
      ? this.toMemoryReviewEpisode(result.episode, {
          mutationEnvelope: result.mutationEnvelope
        })
      : null;
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

    const result = await this.profileMemoryStore.forgetEpisodeFromUser(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso
    );
    return result.episode
      ? this.toMemoryReviewEpisode(result.episode, {
          mutationEnvelope: result.mutationEnvelope
        })
      : null;
  }

  /** Corrects one bounded remembered fact through an explicit user instruction. */
  async correctRememberedFact(
    factId: string,
    replacementValue: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ): Promise<MemoryReviewFact | null> {
    if (!this.profileMemoryStore) {
      return null;
    }

    const result = await this.profileMemoryStore.mutateFactFromUser({
      factId,
      action: "correct",
      replacementValue,
      note,
      nowIso,
      sourceTaskId,
      sourceText
    });
    return result.fact
      ? this.toMemoryReviewFact(result.fact, {
          mutationEnvelope: result.mutationEnvelope
        })
      : null;
  }

  /** Forgets one bounded remembered fact through an explicit user instruction. */
  async forgetRememberedFact(
    factId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string
  ): Promise<MemoryReviewFact | null> {
    if (!this.profileMemoryStore) {
      return null;
    }

    const result = await this.profileMemoryStore.mutateFactFromUser({
      factId,
      action: "forget",
      nowIso,
      sourceTaskId,
      sourceText
    });
    return result.fact
      ? this.toMemoryReviewFact(result.fact, {
          mutationEnvelope: result.mutationEnvelope
        })
      : null;
  }

  /** Appends the standard retrieval audit event for one remembered-situation review. */
  private async recordAudit(
    taskId: string,
    query: string,
    retrievedCount: number,
    retrievedEpisodeCount: number,
    redactedCount: number,
    domainBoundary: ReturnType<typeof assessDomainBoundary>
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
    episode: Awaited<ReturnType<ProfileMemoryStore["reviewEpisodesForUser"]>>[number],
    options: {
      mutationEnvelope?: ProfileMemoryMutationEnvelope;
    } = {}
  ): MemoryReviewEpisode {
    return {
      episodeId: episode.episodeId,
      title: episode.title,
      summary: episode.summary,
      status: episode.status,
      lastMentionedAt: episode.lastMentionedAt,
      resolvedAt: episode.resolvedAt,
      confidence: episode.confidence,
      sensitive: episode.sensitive,
      mutationEnvelope: options.mutationEnvelope
    };
  }

  /** Converts a readable profile-memory fact into the brokered review shape. */
  private toMemoryReviewFact(
    fact: Awaited<ReturnType<ProfileMemoryStore["reviewFactsForUser"]>>["entries"][number]["fact"],
    options: {
      decisionRecord?: ProfileMemoryQueryDecisionRecord;
      mutationEnvelope?: ProfileMemoryMutationEnvelope;
    } = {}
  ): MemoryReviewFact {
    return {
      factId: fact.factId,
      key: fact.key,
      value: fact.value,
      status: fact.status,
      confidence: fact.confidence,
      sensitive: fact.sensitive,
      observedAt: fact.observedAt,
      lastUpdatedAt: fact.lastUpdatedAt,
      decisionRecord: options.decisionRecord,
      mutationEnvelope: options.mutationEnvelope
    };
  }
}
