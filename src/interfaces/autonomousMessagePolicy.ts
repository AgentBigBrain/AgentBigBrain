/**
 * @fileoverview Renders human-first autonomous progress and terminal messages for chat interfaces.
 */

import { humanizeAutonomousStopReason as humanizeSharedAutonomousStopReason } from "../core/autonomousReasonText";

/**
 * Renders a human-first explanation for autonomous stop/abort reasons.
 *
 * **Why it exists:**
 * Telegram/Discord users should get concise explanations of what went wrong without parsing raw
 * control-plane reason codes or implementation-specific diagnostics.
 *
 * **What it talks to:**
 * - Uses `humanizeAutonomousStopReason` (imported as `humanizeSharedAutonomousStopReason`) from `../core/autonomousReasonText`.
 *
 * @param reason - Raw autonomous-loop reason text.
 * @returns Human-readable stop explanation with no bracketed reason codes.
 */
export function humanizeAutonomousStopReason(reason: string): string {
  return humanizeSharedAutonomousStopReason(reason);
}

/**
 * Builds a human-first progress update for one completed autonomous iteration.
 *
 * **Why it exists:**
 * Progress pings should sound like active assistance instead of raw telemetry while still keeping
 * the concrete approval/block totals visible to the user.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param iteration - Completed iteration number.
 * @param approved - Approved action count for this iteration.
 * @param blocked - Blocked action count for this iteration.
 * @param totalApproved - Cumulative approved action count.
 * @param totalBlocked - Cumulative blocked action count.
 * @returns Human-readable progress line.
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
 * Normalizes autonomous goal-met reasoning into user-facing confidence text.
 *
 * **Why it exists:**
 * Autonomous success reasoning often contains model-evaluation or control-plane phrasing that is
 * technically accurate but awkward in chat. This helper keeps the message truthful while making it
 * sound like a human explanation instead of a system trace.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param reasoning - Raw goal-met reasoning text from the loop.
 * @returns Human-first confidence text, or `null` when nothing useful should be shown.
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

/**
 * Builds a human-first success update for an autonomous goal.
 *
 * **Why it exists:**
 * Terminal success output should summarize the work cleanly and include a short reasoning preview
 * without sounding like a control-plane status dump.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param totalIterations - Total autonomous iterations executed.
 * @param totalApproved - Total approved action count.
 * @param totalBlocked - Total blocked action count.
 * @param reasoning - Raw goal-met reasoning text from the loop.
 * @returns Human-readable terminal success update.
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
 *
 * **Why it exists:**
 * Terminal stop output should explain the stopping reason plainly and keep outcome totals visible
 * without exposing raw reason-code prefixes.
 *
 * **What it talks to:**
 * - Uses `humanizeAutonomousStopReason` from this module.
 *
 * @param totalIterations - Total autonomous iterations executed.
 * @param totalApproved - Total approved action count.
 * @param totalBlocked - Total blocked action count.
 * @param reason - Raw autonomous-loop stop reason.
 * @returns Human-readable terminal stop update.
 */
export function buildAutonomousGoalAbortedProgressMessage(
  totalIterations: number,
  totalApproved: number,
  totalBlocked: number,
  reason: string
): string {
  return (
    `Stopped after ${totalIterations} iteration(s). ${humanizeAutonomousStopReason(reason)}\n` +
    `${totalApproved} action(s) approved, ${totalBlocked} blocked.`
  );
}

/**
 * Builds the final one-line autonomous summary returned to interface queue workers.
 *
 * **Why it exists:**
 * Queue workers need a stable terminal summary string for session history and final delivery while
 * keeping autonomous stop reasons human-readable.
 *
 * **What it talks to:**
 * - Uses `humanizeAutonomousStopReason` from this module.
 *
 * @param completed - Whether the autonomous loop reached goal completion.
 * @param totalIterations - Total autonomous iterations executed.
 * @param totalApproved - Total approved action count.
 * @param totalBlocked - Total blocked action count.
 * @param reason - Optional raw stop reason for aborted runs.
 * @returns Final autonomous summary text.
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
      `Autonomous task stopped after ${totalIterations} iteration(s). ` +
      `${totalApproved} approved, ${totalBlocked} blocked. ` +
      `Why it stopped: ${humanizeAutonomousStopReason(reason ?? "Unknown stop reason.")}`
    );
  }

  return (
    `Autonomous task completed after ${totalIterations} iteration(s). ` +
    `I finished the goal with ${totalApproved} approved action(s) and ${totalBlocked} blocked.`
  );
}
