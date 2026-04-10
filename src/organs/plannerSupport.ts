/**
 * @fileoverview Shared planner helpers kept outside the planner entrypoint to preserve a thin
 * orchestration surface.
 */

import {
  DistilledPacketV1,
  PlannerLearningHintSummaryV1
} from "../core/types";
import type { SemanticLesson } from "../core/semanticMemory";
import {
  buildDefaultRetrievalQuarantinePolicy,
  distillExternalContent,
  requireDistilledPacketForPlanner
} from "../core/retrievalQuarantine";
import { resolveUserOwnedPathHints } from "./plannerPolicy/userOwnedPathHints";
import { PlannerExecutionEnvironmentContext } from "./plannerPolicy/executionStyleContracts";

export interface DistilledRelevantLesson {
  packet: DistilledPacketV1;
  concepts: readonly string[];
}

/**
 * Evaluates whether a planner/provider failure looks like a bounded timeout condition.
 *
 * @param error - Unknown thrown planner/provider error.
 * @returns `true` when the failure text matches a bounded timeout condition.
 */
export function isPlannerTimeoutFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:request timed out|timed out(?: after \d+ms)?|provider or runtime step timed out)/i
    .test(message);
}

/**
 * Resolves default execution environment context from available runtime context.
 *
 * @returns Computed `PlannerExecutionEnvironmentContext` result.
 */
export function resolveDefaultExecutionEnvironmentContext(): PlannerExecutionEnvironmentContext {
  const platform = process.platform === "win32" || process.platform === "darwin" || process.platform === "linux"
    ? process.platform
    : "linux";
  const shellKind = platform === "win32" ? "powershell" : "bash";
  const userOwnedPaths = resolveUserOwnedPathHints();
  return {
    platform,
    shellKind,
    invocationMode: "inline_command",
    commandMaxChars: 4_000,
    desktopPath: userOwnedPaths.desktopPath,
    documentsPath: userOwnedPaths.documentsPath,
    downloadsPath: userOwnedPaths.downloadsPath
  };
}

/**
 * Distills planner lessons while suppressing quarantined memory entries.
 *
 * @param relevantLessons - Retrieved lesson candidates from semantic memory.
 * @param retrievalPolicy - Deterministic retrieval quarantine policy for this planning pass.
 * @returns Planner-safe distilled lessons ready for prompt inclusion.
 */
export function distillPlannerLessons(
  relevantLessons: readonly SemanticLesson[],
  retrievalPolicy: ReturnType<typeof buildDefaultRetrievalQuarantinePolicy>
): DistilledRelevantLesson[] {
  const distilledLessons: DistilledRelevantLesson[] = [];
  for (const lesson of relevantLessons) {
    const distillation = distillExternalContent(
      {
        sourceKind: "document",
        sourceId: lesson.id,
        contentType: "text/plain",
        rawContent: lesson.text,
        observedAt: lesson.createdAt
      },
      retrievalPolicy
    );
    if (!distillation.ok) {
      console.warn(
        `[Planner] Suppressing quarantined lesson ${lesson.id}: ` +
        `${distillation.blockCode} (${distillation.reason})`
      );
      continue;
    }
    const packetValidation = requireDistilledPacketForPlanner(distillation.packet);
    if (packetValidation) {
      throw new Error(
        `Retrieval quarantine packet validation failed for lesson ${lesson.id}: ` +
        `${packetValidation.blockCode} (${packetValidation.reason})`
      );
    }
    distilledLessons.push({
      packet: distillation.packet,
      concepts: lesson.concepts
    });
  }
  return distilledLessons;
}
