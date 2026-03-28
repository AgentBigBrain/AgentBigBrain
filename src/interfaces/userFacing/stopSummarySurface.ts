/**
 * @fileoverview Renders human-first autonomous terminal messages and shared summary fallbacks.
 */

import { TaskRunResult } from "../../core/types";
import { humanizeAutonomousStopReason as humanizeSharedAutonomousStopReason } from "../../core/autonomy/stopReasonText";
import {
  NormalizedUserFacingSummaryOptions,
  applyTruthPolicyV1ToOutcomeSummary
} from "./contracts";

const COMPLETED_TASK_SUMMARY_PREFIX = "completed task with";

/**
 * Renders a human-first explanation for autonomous stop/abort reasons.
 */
export function humanizeAutonomousStopReason(reason: string): string {
  return humanizeSharedAutonomousStopReason(reason);
}

/**
 * Builds a human-first progress update for one completed autonomous iteration.
 */
export function buildAutonomousIterationProgressMessage(
  iteration: number,
  approved: number,
  blocked: number,
  totalApproved: number,
  totalBlocked: number
): string {
  return (
    `Step ${iteration} finished. Approved ${approved} action(s), blocked ${blocked}. ` +
    `Total so far: ${totalApproved} approved, ${totalBlocked} blocked.`
  );
}

/**
 * Builds a human-first success update for an autonomous goal.
 */
export function buildAutonomousGoalMetProgressMessage(
  totalIterations: number,
  totalApproved: number,
  totalBlocked: number,
  reasoning: string
): string {
  const confidence = humanizeAutonomousSuccessReason(reasoning);
  return (
    `Finished after ${totalIterations} iteration(s). ` +
    `I completed the goal with ${totalApproved} approved action(s) and ${totalBlocked} blocked.` +
    (confidence ? `\nWhy I'm confident: ${confidence}` : "")
  );
}

/**
 * Builds a human-first stop update for an autonomous goal.
 */
export function buildAutonomousGoalAbortedProgressMessage(
  totalIterations: number,
  totalApproved: number,
  totalBlocked: number,
  reason: string
): string {
  return (
    `I started this, but I hit a blocker before I could finish it after ${totalIterations} iteration(s). ${humanizeAutonomousStopReason(reason)}\n` +
    `${totalApproved} action(s) approved, ${totalBlocked} blocked.`
  );
}

/**
 * Builds the final one-line autonomous summary returned to interface queue workers.
 */
export function buildAutonomousTerminalSummaryMessage(
  completed: boolean,
  totalIterations: number,
  totalApproved: number,
  totalBlocked: number,
  reason?: string
): string {
  if (!completed) {
    return (
      `I started this, but the run stopped before it finished after ${totalIterations} iteration(s). ` +
      `${humanizeAutonomousStopReason(reason ?? "Unknown stop reason.")} ` +
      `Approved ${totalApproved}, blocked ${totalBlocked}.`
    );
  }

  return (
    `Autonomous task completed after ${totalIterations} iteration(s). ` +
    `I finished the goal with ${totalApproved} approved action(s) and ${totalBlocked} blocked.`
  );
}

/**
 * Evaluates completed-task summary phrasing.
 */
export function isCompletedTaskSummary(summary: string): boolean {
  return summary.trim().toLowerCase().startsWith(COMPLETED_TASK_SUMMARY_PREFIX);
}

/**
 * Resolves the final fallback summary when no richer user-facing surface applies.
 */
export function resolveSummaryFallback(
  runResult: TaskRunResult,
  summary: string,
  options: NormalizedUserFacingSummaryOptions
): string {
  const truthSafeSummary = applyTruthPolicyV1ToOutcomeSummary(summary, runResult);
  if (options.showTechnicalSummary) {
    return truthSafeSummary;
  }

  if (isCompletedTaskSummary(truthSafeSummary)) {
    return "Done.";
  }

  return truthSafeSummary;
}

/**
 * Evaluates whether a line is a run-skill failure line.
 */
export function isRunSkillFailureLine(value: string): boolean {
  return /^run skill failed:/i.test(value.trim());
}

/**
 * Normalizes autonomous goal-met reasoning into user-facing confidence text.
 */
function humanizeAutonomousSuccessReason(reasoning: string): string | null {
  const normalized = reasoning.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  if (/^mock model decided the overarching goal is met\.?$/i.test(normalized)) {
    return "the completed work in this run satisfied the goal.";
  }

  let rendered = normalized
    .replace(/^the mock model decided\s+/i, "")
    .replace(/^mock model decided\s+/i, "")
    .replace(/^the overarching goal was\s+/i, "")
    .replace(/^the overarching goal is\s+/i, "")
    .replace(/^the goal was\s+/i, "")
    .replace(/^the goal is\s+/i, "")
    .replace(/^the last task\b/i, "The last step")
    .replace(/\bgoal is met\b/i, "goal was met")
    .replace(/\bgoal has been met\b/i, "goal was met");

  if (rendered.length === 0) {
    return null;
  }

  if (!/[.!?]$/.test(rendered)) {
    rendered += ".";
  }

  return rendered.length > 300 ? rendered.slice(0, 300) + "..." : rendered;
}
