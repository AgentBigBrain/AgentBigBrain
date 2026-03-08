/**
 * @fileoverview Stable entrypoint for brokered profile-memory planner input enrichment.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import { MemoryAccessAuditStore } from "../core/memoryAccessAudit";
import type { TaskRequest } from "../core/types";
import { appendMemoryAccessAudit } from "./memoryContext/auditEvents";
import {
  buildInjectedContextPacket,
  buildSuppressedContextPacket,
  countRetrievedProfileFacts,
  sanitizeProfileContextForModelEgress
} from "./memoryContext/contextInjection";
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

export class MemoryBrokerOrgan {
  private readonly probingDetectorConfig;
  private readonly recentProbeSignals: ProbingSignalSnapshot[] = [];

  /**
   * Initializes `MemoryBrokerOrgan` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures broker dependencies at initialization time so profile-context enrichment remains
   * explicit and testable.
   *
   * **What it talks to:**
   * - Uses `ProfileMemoryStore` from `../core/profileMemoryStore`.
   * - Uses `MemoryAccessAuditStore` from `../core/memoryAccessAudit`.
   * - Uses probing-detector config helpers from `./memoryContext/queryPlanning`.
   *
   * @param profileMemoryStore - Optional profile-memory store dependency for ingestion/retrieval.
   * @param memoryAccessAuditStore - Append-only audit store for memory access traces.
   * @param options - Optional deterministic probing-detector tuning values.
   */
  constructor(
    private readonly profileMemoryStore?: ProfileMemoryStore,
    private readonly memoryAccessAuditStore = new MemoryAccessAuditStore(),
    options?: MemoryBrokerOptions
  ) {
    this.probingDetectorConfig = resolveProbingDetectorConfig(options?.probingDetector);
  }

  /**
   * Builds planner input by optionally brokering profile context through deterministic guards.
   *
   * **Why it exists:**
   * The planner should only see profile context when the request is relevant, non-probing, and
   * safe to inject. This method coordinates profile ingestion, query-aware reads, domain-boundary
   * scoring, audit writes, and degraded fallback behavior.
   *
   * **What it talks to:**
   * - Uses `ProfileMemoryStore` read/ingest methods.
   * - Uses `memoryContext` helpers for request extraction, probing detection, context rendering,
   *   and audit appends.
   *
   * @param task - Incoming task request to enrich with brokered profile context.
   * @returns Planner input plus profile-memory availability status.
   */
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
      await this.profileMemoryStore.ingestFromTaskInput(task.id, currentUserRequest, task.createdAt);
      const profileContext = await this.profileMemoryStore.getPlanningContext(6, currentUserRequest);

      if (!profileContext) {
        const domainBoundary = assessDomainBoundary(currentUserRequest, "");
        await this.recordAudit(task.id, currentUserRequest, 0, 0, domainBoundary);
        if (probing.assessment.detected) {
          await this.recordProbingAudit(task.id, currentUserRequest, 0, 0, domainBoundary, probing.assessment);
        }
        return {
          userInput: task.userInput,
          profileMemoryStatus: "available"
        };
      }

      const sanitizedProfileContext = sanitizeProfileContextForModelEgress(profileContext);
      const assessedDomainBoundary = assessDomainBoundary(
        currentUserRequest,
        sanitizedProfileContext.sanitizedContext
      );
      const domainBoundary: DomainBoundaryAssessment = probing.assessment.detected
        ? {
            ...assessedDomainBoundary,
            decision: "suppress_profile_context",
            reason: "probing_detected"
          }
        : assessedDomainBoundary;
      const retrievedCount = countRetrievedProfileFacts(profileContext);

      await this.recordAudit(
        task.id,
        currentUserRequest,
        retrievedCount,
        sanitizedProfileContext.redactedFieldCount,
        domainBoundary
      );
      if (probing.assessment.detected) {
        await this.recordProbingAudit(
          task.id,
          currentUserRequest,
          retrievedCount,
          sanitizedProfileContext.redactedFieldCount,
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
        sanitizedProfileContext.redactedFieldCount > 0
          ? `\n[AgentFriendProfileEgressGuard]\nredactedSensitiveFields=${sanitizedProfileContext.redactedFieldCount}`
          : "";
      const brokeredContext = `${sanitizedProfileContext.sanitizedContext}${egressGuardFooter}`;

      return {
        userInput: buildInjectedContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          domainBoundary.reason,
          brokeredContext
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

  /**
   * Appends the probing-specific audit event when the broker suppresses extraction-style bursts.
   *
   * @param taskId - Task identifier associated with the retrieval.
   * @param query - Active user request query.
   * @param retrievedCount - Count of retrieved facts before suppression.
   * @param redactedCount - Count of redacted fields before suppression.
   * @param domainBoundary - Final domain-boundary decision.
   * @param probingAssessment - Deterministic probing assessment for this query window.
   * @returns Promise resolving when the audit append attempt completes.
   */
  private async recordProbingAudit(
    taskId: string,
    query: string,
    retrievedCount: number,
    redactedCount: number,
    domainBoundary: DomainBoundaryAssessment,
    probingAssessment: ReturnType<typeof registerAndAssessProbing>["assessment"]
  ): Promise<void> {
    await appendMemoryAccessAudit(
      this.memoryAccessAuditStore,
      taskId,
      query,
      retrievedCount,
      redactedCount,
      domainBoundary.lanes,
      {
        eventType: "PROBING_DETECTED",
        probeSignals: probingAssessment.matchedSignals,
        probeWindowSize: probingAssessment.windowSize,
        probeMatchCount: probingAssessment.matchCount,
        probeMatchRatio: probingAssessment.matchRatio
      }
    );
  }

  /**
   * Appends the standard retrieval audit event for one brokered planner-input build.
   *
   * @param taskId - Task identifier associated with the retrieval.
   * @param query - Active user request query.
   * @param retrievedCount - Count of retrieved facts.
   * @param redactedCount - Count of redacted sensitive fields.
   * @param domainBoundary - Final domain-boundary decision.
   * @returns Promise resolving when the audit append attempt completes.
   */
  private async recordAudit(
    taskId: string,
    query: string,
    retrievedCount: number,
    redactedCount: number,
    domainBoundary: DomainBoundaryAssessment
  ): Promise<void> {
    await appendMemoryAccessAudit(
      this.memoryAccessAuditStore,
      taskId,
      query,
      retrievedCount,
      redactedCount,
      domainBoundary.lanes
    );
  }
}
