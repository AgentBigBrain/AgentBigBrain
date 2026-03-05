/**
 * @fileoverview Analyzes completed task runs, extracts reflection lessons, and persists only deterministic high-signal memory.
 */

import { MAIN_AGENT_ID, normalizeAgentId } from "../core/agentIdentity";
import { DistillerMergeLedgerStore } from "../core/distillerLedger";
import {
  LessonSignalMetadataV1,
  SemanticMemoryStore
} from "../core/semanticMemory";
import { SatelliteCloneCoordinator, SatelliteCloneRecord } from "../core/satelliteClone";
import { TaskRunResult } from "../core/types";
import {
  ModelClient,
  ReflectionModelOutput,
  SuccessReflectionModelOutput
} from "../models/types";
import {
  classifyLessonSignal,
  LessonSignalClassification,
  normalizeLessonText,
  ReflectionLessonSource
} from "./reflectionSignalClassifier";

export interface ReflectionConfig {
  reflectOnSuccess: boolean;
}

export interface ReflectionDistillerDependencies {
  distillerLedgerStore: DistillerMergeLedgerStore;
  satelliteCloneCoordinator: SatelliteCloneCoordinator;
}

const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  reflectOnSuccess: false
};
const CLONE_AGENT_ID_PATTERN = /^[a-z][a-z0-9]*-[1-9][0-9]*$/;

/**
 * Evaluates clone agent id and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps clone-agent detection explicit and stable so distiller routing cannot drift across call sites.
 *
 * **What it talks to:**
 * - Uses local clone-id regex policy in `CLONE_AGENT_ID_PATTERN`.
 *
 * @param agentId - Agent identifier candidate.
 * @returns `true` when the id matches clone naming contract and is not the main agent id.
 */
function isSatelliteCloneAgentId(agentId: string): boolean {
  return agentId !== MAIN_AGENT_ID && CLONE_AGENT_ID_PATTERN.test(agentId);
}

/**
 * Converts values into sorted unique governor-id list form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for rejecting governor ids deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses vote data from `TaskRunResult` action outcomes.
 *
 * @param runResult - Completed task run used for merge-governance context.
 * @returns Ordered collection produced by this step.
 */
function deriveRejectingGovernorIds(runResult: TaskRunResult): string[] {
  const collected = runResult.actionResults.flatMap((result) =>
    result.votes.filter((vote) => !vote.approve).map((vote) => vote.governorId)
  );
  return [...new Set(collected)].sort((left, right) => left.localeCompare(right));
}

/**
 * Builds synthetic clone record for distiller evaluation from available runtime context.
 *
 * **Why it exists:**
 * Distiller merge-policy helper requires clone record metadata; reflection only has task-scoped clone identity.
 *
 * **What it talks to:**
 * - Uses `SatelliteCloneRecord` (import `SatelliteCloneRecord`) from `../core/satelliteClone`.
 *
 * @param cloneId - Normalized clone agent id.
 * @param runResult - Completed task run carrying root task metadata.
 * @returns Computed `SatelliteCloneRecord` result.
 */
function buildSyntheticCloneRecord(
  cloneId: string,
  runResult: TaskRunResult
): SatelliteCloneRecord {
  return {
    cloneId,
    rootTaskId: runResult.task.id,
    depth: 1,
    budgetUsd: 0,
    role: "researcher",
    personaOverlay: {
      role: "researcher",
      traitDeltas: {}
    },
    status: "active",
    createdAt: runResult.startedAt,
    mergedAt: null
  };
}

/**
 * Converts values into lesson signal metadata form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for lesson signal metadata deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `LessonSignalMetadataV1` (import `LessonSignalMetadataV1`) from `../core/semanticMemory`.
 * - Uses `LessonSignalClassification` (import `LessonSignalClassification`) from `./reflectionSignalClassifier`.
 * - Uses `ReflectionLessonSource` (import `ReflectionLessonSource`) from `./reflectionSignalClassifier`.
 *
 * @param classification - Value for classification.
 * @param source - Value for source.
 * @returns Computed `LessonSignalMetadataV1` result.
 */
function toLessonSignalMetadata(
  classification: LessonSignalClassification,
  source: ReflectionLessonSource
): LessonSignalMetadataV1 {
  return {
    schemaVersion: 1,
    source: `reflection_${source}`,
    category: classification.category,
    confidenceTier: classification.confidenceTier,
    matchedRuleId: classification.matchedRuleId,
    rulepackVersion: classification.rulepackVersion,
    blockReason: classification.blockReason
  };
}

export class ReflectionOrgan {
  /**
   * Initializes `ReflectionOrgan` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `SemanticMemoryStore` (import `SemanticMemoryStore`) from `../core/semanticMemory`.
   * - Uses `DistillerMergeLedgerStore` (import `DistillerMergeLedgerStore`) from `../core/distillerLedger`.
   * - Uses `SatelliteCloneCoordinator` (import `SatelliteCloneCoordinator`) from `../core/satelliteClone`.
   * - Uses `ModelClient` (import `ModelClient`) from `../models/types`.
   *
   * @param memoryStore - Value for memory store.
   * @param modelClient - Value for model client.
   * @param config - Configuration or policy settings applied here.
   * @param distillerDependencies - Optional distiller runtime collaborators for clone-lesson merge governance.
   */
  constructor(
    private readonly memoryStore: SemanticMemoryStore,
    private readonly modelClient: ModelClient,
    private readonly config: ReflectionConfig = DEFAULT_REFLECTION_CONFIG,
    private readonly distillerDependencies?: ReflectionDistillerDependencies
  ) {}

  /**
   * Persists lesson through distiller governance path for clone-attributed runtime outcomes.
   *
   * **Why it exists:**
   * Phase-5 runtime wiring requires clone lessons to pass through distiller decision + ledger append
   * before any semantic-memory commit.
   *
   * **What it talks to:**
   * - Uses `SatelliteCloneCoordinator.evaluateMergeDecision` for merge allow/reject decision.
   * - Uses `DistillerMergeLedgerStore.appendDecision` for durable merge/reject ledger records.
   * - Uses `SemanticMemoryStore.appendLesson` for allowed merge commits only.
   *
   * @param lesson - Candidate lesson text from reflection output.
   * @param runResult - Completed task run carrying clone and governance context.
   * @param signalMetadata - Deterministic lesson signal metadata for semantic-memory commit.
   * @param cloneAgentId - Normalized clone identity that produced the lesson.
   * @returns Promise resolving to `true` when merge is approved and memory commit occurs.
   */
  private async saveLessonViaDistiller(
    lesson: string,
    runResult: TaskRunResult,
    signalMetadata: LessonSignalMetadataV1,
    cloneAgentId: string
  ): Promise<boolean> {
    if (!this.distillerDependencies) {
      return false;
    }

    const rejectingGovernorIds = deriveRejectingGovernorIds(runResult);
    const mergeDecision = this.distillerDependencies.satelliteCloneCoordinator.evaluateMergeDecision({
      clone: buildSyntheticCloneRecord(cloneAgentId, runResult),
      governanceApproved: rejectingGovernorIds.length === 0,
      rejectingGovernorIds,
      lessonText: lesson,
      reason:
        rejectingGovernorIds.length > 0
          ? "Distiller merge rejected by runtime governance vote history."
          : "Distiller merge approved from governed runtime evidence."
    });
    const ledgerReason =
      mergeDecision.rejectionReason ??
      "Distiller merge approved from governed runtime evidence.";

    await this.distillerDependencies.distillerLedgerStore.appendDecision({
      cloneId: cloneAgentId,
      lessonText: lesson,
      merged: mergeDecision.merged,
      rejectingGovernorIds,
      reason: ledgerReason
    });

    if (!mergeDecision.merged || !mergeDecision.committedByAgentId) {
      console.log(
        `[Reflection] Distiller rejected clone lesson for ${cloneAgentId}; merge skipped.`
      );
      return false;
    }

    await this.memoryStore.appendLesson(
      lesson,
      runResult.task.id,
      mergeDecision.committedByAgentId,
      "experience",
      signalMetadata
    );
    return true;
  }

  /**
   * Builds reflection output for on task using deterministic rules.
   *
   * **Why it exists:**
   * Keeps reflection synthesis for on task deterministic and auditable.
   *
   * **What it talks to:**
   * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
   *
   * @param runResult - Result object inspected or transformed in this step.
   * @param model - Value for model.
   * @returns Promise resolving to void.
   */
  async reflectOnTask(runResult: TaskRunResult, model: string): Promise<void> {
    const blockedActions = runResult.actionResults.filter((result) => !result.approved);

    if (blockedActions.length > 0) {
      await this.reflectOnFailure(runResult, blockedActions, model);
      return;
    }

    if (this.config.reflectOnSuccess) {
      await this.reflectOnSuccess(runResult, model);
    }
  }

  /**
   * Builds reflection output for on failure using deterministic rules.
   *
   * **Why it exists:**
   * Keeps reflection synthesis for on failure deterministic and auditable.
   *
   * **What it talks to:**
   * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
   * - Uses `ReflectionModelOutput` (import `ReflectionModelOutput`) from `../models/types`.
   *
   * @param runResult - Result object inspected or transformed in this step.
   * @param blockedActions - Value for blocked actions.
   * @param model - Value for model.
   * @returns Promise resolving to void.
   */
  private async reflectOnFailure(
    runResult: TaskRunResult,
    blockedActions: TaskRunResult["actionResults"],
    model: string
  ): Promise<void> {
    let output: ReflectionModelOutput;
    try {
      output = await this.modelClient.completeJson<ReflectionModelOutput>({
        model,
        schemaName: "reflection_v1",
        temperature: 0.2,
        systemPrompt:
          "You are a reflection engine. Analyze the failed/blocked actions of the given task run. " +
          "Extract 1 or 2 concise lessons learned that would prevent these failures in the future. " +
          "Return JSON with a `lessons` array of strings.",
        userPrompt: JSON.stringify({
          goal: runResult.task.goal,
          summary: runResult.summary,
          blockedActions: blockedActions.map((result) => ({
            type: result.action.type,
            description: result.action.description,
            blockedBy: result.blockedBy,
            violations: result.violations
          }))
        })
      });
    } catch (error) {
      console.error(`[Reflection] Model call failed: ${(error as Error).message}`);
      return;
    }

    console.log(
      `[Reflection] Extracted ${output.lessons.length} lessons from ${blockedActions.length} blocked actions.`
    );
    await this.saveLessons(output.lessons, runResult, "failure");
  }

  /**
   * Builds reflection output for on success using deterministic rules.
   *
   * **Why it exists:**
   * Keeps reflection synthesis for on success deterministic and auditable.
   *
   * **What it talks to:**
   * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
   * - Uses `SuccessReflectionModelOutput` (import `SuccessReflectionModelOutput`) from `../models/types`.
   *
   * @param runResult - Result object inspected or transformed in this step.
   * @param model - Value for model.
   * @returns Promise resolving to void.
   */
  private async reflectOnSuccess(runResult: TaskRunResult, model: string): Promise<void> {
    let output: SuccessReflectionModelOutput;
    try {
      output = await this.modelClient.completeJson<SuccessReflectionModelOutput>({
        model,
        schemaName: "reflection_success_v1",
        temperature: 0.1,
        systemPrompt:
          "You are a reflection engine. Analyze this fully successful task run. " +
          "Extract exactly 1 concise lesson about what key insight or approach made it succeed. " +
          "If something almost went wrong, note the near-miss. Return JSON with `lesson` " +
          "(string) and `nearMiss` (string or null).",
        userPrompt: JSON.stringify({
          goal: runResult.task.goal,
          summary: runResult.summary,
          approvedActions: runResult.actionResults.map((result) => ({
            type: result.action.type,
            description: result.action.description
          }))
        })
      });
    } catch (error) {
      console.error(`[Reflection] Success reflection model call failed: ${(error as Error).message}`);
      return;
    }

    console.log("[Reflection] Extracted success lesson from completed task.");
    await this.saveLessons([output.lesson], runResult, "success");

    if (output.nearMiss) {
      console.log(`[Reflection] Near-miss observed: ${output.nearMiss}`);
      await this.saveLessons([`Near-miss: ${output.nearMiss}`], runResult, "success");
    }
  }

  /**
   * Persists lessons with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes lessons mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
   * - Uses `classifyLessonSignal` (import `classifyLessonSignal`) from `./reflectionSignalClassifier`.
   * - Uses `normalizeLessonText` (import `normalizeLessonText`) from `./reflectionSignalClassifier`.
   * - Uses `ReflectionLessonSource` (import `ReflectionLessonSource`) from `./reflectionSignalClassifier`.
   *
   * @param lessons - Value for lessons.
   * @param runResult - Result object inspected or transformed in this step.
   * @param source - Value for source.
   * @returns Promise resolving to void.
   */
  private async saveLessons(
    lessons: readonly string[],
    runResult: TaskRunResult,
    source: ReflectionLessonSource
  ): Promise<void> {
    const existing = await this.memoryStore.load();
    const existingTexts = existing.lessons.map((lesson) => lesson.text);
    const acceptedInBatch: string[] = [];

    for (const rawLesson of lessons) {
      const lesson = normalizeLessonText(rawLesson);
      if (!lesson) {
        continue;
      }

      const classification = classifyLessonSignal(lesson, {
        runResult,
        source,
        existingLessons: [...existingTexts, ...acceptedInBatch]
      });
      if (!classification.allowPersist) {
        console.log(
          `[Reflection] Skipping lesson (${classification.matchedRuleId}${
            classification.blockReason ? `:${classification.blockReason}` : ""
          }): ${lesson}`
        );
        continue;
      }

      await this.saveLesson(
        lesson,
        runResult,
        toLessonSignalMetadata(classification, source)
      );
      acceptedInBatch.push(lesson);
    }
  }

  /**
   * Persists lesson with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes lesson mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `MAIN_AGENT_ID` (import `MAIN_AGENT_ID`) from `../core/agentIdentity`.
   * - Uses `normalizeAgentId` (import `normalizeAgentId`) from `../core/agentIdentity`.
   * - Uses `LessonSignalMetadataV1` (import `LessonSignalMetadataV1`) from `../core/semanticMemory`.
   * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
   *
   * @param lesson - Value for lesson.
   * @param runResult - Result object inspected or transformed in this step.
   * @param signalMetadata - Value for signal metadata.
   * @returns Promise resolving to void.
   */
  private async saveLesson(
    lesson: string,
    runResult: TaskRunResult,
    signalMetadata: LessonSignalMetadataV1
  ): Promise<void> {
    console.log(`[Reflection] Saving lesson: ${lesson}`);
    const normalizedAgentId = normalizeAgentId(runResult.task.agentId ?? MAIN_AGENT_ID);
    try {
      if (this.distillerDependencies && isSatelliteCloneAgentId(normalizedAgentId)) {
        const committed = await this.saveLessonViaDistiller(
          lesson,
          runResult,
          signalMetadata,
          normalizedAgentId
        );
        if (committed) {
          console.log("[Reflection] Lesson saved successfully.");
        } else {
          console.log("[Reflection] Lesson not committed after distiller merge decision.");
        }
      } else {
        await this.memoryStore.appendLesson(
          lesson,
          runResult.task.id,
          normalizedAgentId,
          "experience",
          signalMetadata
        );
        console.log("[Reflection] Lesson saved successfully.");
      }
    } catch (error) {
      console.error("[Reflection] Failed to save lesson:", error);
    }
  }
}
