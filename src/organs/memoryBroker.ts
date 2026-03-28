/**
 * @fileoverview Stable entrypoint for brokered profile-memory planner input enrichment.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import { MemoryAccessAuditStore } from "../core/memoryAccessAudit";
import { LanguageUnderstandingOrgan } from "./languageUnderstanding/episodeExtraction";
import type { ProfileEpisodeStatus } from "../core/profileMemory";
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
}
