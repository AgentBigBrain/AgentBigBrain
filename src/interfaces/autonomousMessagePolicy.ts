/**
 * @fileoverview Renders human-first autonomous progress and terminal messages for chat interfaces.
 */

const AUTONOMOUS_REASON_CODE_PATTERN = /^\[reasonCode=([A-Z0-9_]+)\]\s*/i;

/**
 * Extracts a typed autonomous reason code from prefixed runtime text.
 *
 * **Why it exists:**
 * Keeps reason-code parsing deterministic and reusable so adapters can render human-first summaries
 * without duplicating regex logic.
 *
 * **What it talks to:**
 * - Uses local deterministic regex helpers within this module.
 *
 * @param reason - Raw autonomous-loop reason text.
 * @returns Parsed reason code, or `null` when no prefixed code exists.
 */
function extractAutonomousReasonCode(reason: string): string | null {
  const match = reason.match(AUTONOMOUS_REASON_CODE_PATTERN);
  return match?.[1] ?? null;
}

/**
 * Removes the typed autonomous reason-code prefix from runtime text.
 *
 * **Why it exists:**
 * User-facing chat summaries should not lead with bracketed machine codes, but the underlying text
 * still needs to be available for deterministic humanization.
 *
 * **What it talks to:**
 * - Uses local deterministic regex helpers within this module.
 *
 * @param reason - Raw autonomous-loop reason text.
 * @returns Reason text without the leading reason-code prefix.
 */
function stripAutonomousReasonCode(reason: string): string {
  return reason.replace(AUTONOMOUS_REASON_CODE_PATTERN, "").trim();
}

/**
 * Renders a human-first explanation for stalled autonomous runs based on missing evidence.
 *
 * **Why it exists:**
 * Stalled autonomous-loop reasons include deterministic requirement tokens such as `BROWSER_PROOF`
 * and `READINESS_PROOF`. This helper translates those machine-readable hints into plain language so
 * chat interfaces explain what proof was still missing when the loop stopped.
 *
 * **What it talks to:**
 * - Uses local deterministic regex helpers within this module.
 *
 * @param reason - Autonomous stall reason with any reason-code prefix already stripped.
 * @returns Human-readable stalled-run explanation.
 */
function humanizeAutonomousStallReason(reason: string): string {
  if (/\bBROWSER_PROOF\b/i.test(reason)) {
    return "I stopped because I still did not get browser or UI proof that the page rendered as expected.";
  }
  if (/\bREADINESS_PROOF\b/i.test(reason)) {
    return "I stopped because I still did not get readiness proof that the app or service was running.";
  }
  if (/\bARTIFACT_MUTATION\b/i.test(reason)) {
    return "I stopped because I still did not get proof that the requested project files or artifacts were changed.";
  }
  if (/\bTARGET_PATH_TOUCH\b/i.test(reason)) {
    return "I stopped because I still did not get proof that the requested target path was touched.";
  }
  return (
    "I stopped because I could not verify enough real execution progress to prove the goal " +
    "happened in this run."
  );
}

/**
 * Renders a human-first explanation for autonomous execution failures.
 *
 * **Why it exists:**
 * Some autonomous aborts come from internal planner or learning-path faults that should be
 * described plainly instead of echoed back as raw infrastructure jargon in chat.
 *
 * **What it talks to:**
 * - Uses local regex helpers within this module.
 *
 * @param reason - Autonomous execution failure text with any reason-code prefix already stripped.
 * @returns Human-readable execution failure explanation.
 */
function humanizeAutonomousExecutionFailureReason(reason: string): string {
  if (/Retrieval quarantine blocked lesson .*PRIVATE_RANGE_TARGET_DENIED/i.test(reason)) {
    return (
      "I stopped because an internal saved lesson about localhost was filtered out. " +
      "That internal note should have been ignored instead of stopping your task."
    );
  }

  return reason.replace(
    /^Iteration\s+\d+\s+failed\s+before\s+completion:\s*/i,
    "I hit an execution failure: "
  );
}

/**
 * Renders a human-first explanation for autonomous stop/abort reasons.
 *
 * **Why it exists:**
 * Telegram/Discord users should get concise explanations of what went wrong without parsing raw
 * control-plane reason codes or implementation-specific diagnostics.
 *
 * **What it talks to:**
 * - Uses local reason-code parsing helpers within this module.
 *
 * @param reason - Raw autonomous-loop reason text.
 * @returns Human-readable stop explanation with no bracketed reason codes.
 */
export function humanizeAutonomousStopReason(reason: string): string {
  const reasonCode = extractAutonomousReasonCode(reason);
  const strippedReason = stripAutonomousReasonCode(reason);

  if (!reasonCode) {
    if (/^cancelled by user\.?$/i.test(strippedReason)) {
      return "Stopped because you cancelled the run.";
    }
    return strippedReason;
  }

  switch (reasonCode) {
    case "AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT":
      return humanizeAutonomousStallReason(strippedReason);
    case "AUTONOMOUS_EXECUTION_STYLE_SIDE_EFFECT_REQUIRED":
      return "I need real executed side effects before I can call this goal done.";
    case "AUTONOMOUS_EXECUTION_STYLE_TARGET_PATH_EVIDENCE_REQUIRED":
      return "I need evidence that the requested target path was actually touched.";
    case "AUTONOMOUS_EXECUTION_STYLE_MUTATION_EVIDENCE_REQUIRED":
      return "I need evidence that the requested project files or artifacts were actually changed.";
    case "AUTONOMOUS_EXECUTION_STYLE_READINESS_EVIDENCE_REQUIRED":
      return "I need readiness proof before I can say the app or service is running.";
    case "AUTONOMOUS_EXECUTION_STYLE_BROWSER_EVIDENCE_REQUIRED":
      return "I need browser or UI proof before I can say the page rendered as expected.";
    case "AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED":
      return (
        "I stopped because this environment blocked the localhost readiness or browser verification steps, " +
        "so I could not truthfully confirm the app or page in this run."
      );
    case "AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY":
      return (
        "I stopped because the local server process kept running but never became HTTP-ready, " +
        "so I could not truthfully verify the app or page in this run."
      );
    case "AUTONOMOUS_MAX_ITERATIONS_REACHED":
      return "I hit the configured iteration limit before I could finish.";
    case "AUTONOMOUS_TASK_EXECUTION_FAILED":
      return humanizeAutonomousExecutionFailureReason(strippedReason);
    case "AUTONOMOUS_LOOP_RUNTIME_ERROR":
      return strippedReason.replace(
        /^Autonomous loop runtime failure:\s*/i,
        "I hit a runtime error: "
      );
    default:
      return strippedReason;
  }
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
