/**
 * @fileoverview Converts autonomous runtime stop reasons into human-first plain-language summaries.
 */

import {
  EXECUTION_STYLE_BROWSER_GATING_REASON_CODE,
  EXECUTION_STYLE_GOAL_GATING_REASON_CODE,
  EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE,
  EXECUTION_STYLE_MUTATION_GATING_REASON_CODE,
  EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE,
  EXECUTION_STYLE_READINESS_GATING_REASON_CODE,
  EXECUTION_STYLE_STALL_REASON_CODE,
  EXECUTION_STYLE_TARGET_PATH_GATING_REASON_CODE,
  MAX_ITERATIONS_REASON_CODE,
  TASK_EXECUTION_FAILED_REASON_CODE
} from "./contracts";

const AUTONOMOUS_REASON_CODE_PATTERN = /^\[reasonCode=([A-Z0-9_]+)\]\s*/i;

/**
 * Appends a concrete next step to a human-first stop explanation.
 *
 * **Why it exists:**
 * Plain-language failure text is still frustrating if it only explains what went wrong. This
 * helper standardizes the "what happened + what to do next" shape across autonomous surfaces.
 *
 * **What it talks to:**
 * - Uses local string helpers within this module.
 *
 * @param summary - Human-first explanation of what happened.
 * @param nextStep - Concrete recovery guidance for the user.
 * @returns Combined explanation and next-step guidance.
 */
function appendActionableNextStep(summary: string, nextStep: string): string {
  return `${summary} Next step: ${nextStep}`;
}

/**
 * Extracts a typed autonomous reason code from prefixed runtime text.
 *
 * **Why it exists:**
 * Keeps reason-code parsing deterministic and reusable so the autonomous loop and interface
 * adapters can share one humanization path instead of maintaining separate regex logic.
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
 * User-facing summaries should not lead with bracketed machine codes, but the rest of the text
 * still needs deterministic cleanup before it is translated into plain language.
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
 * users understand what proof was still missing when the loop stopped.
 *
 * **What it talks to:**
 * - Uses local deterministic regex helpers within this module.
 *
 * @param reason - Autonomous stall reason with any reason-code prefix already stripped.
 * @returns Human-readable stalled-run explanation.
 */
function humanizeAutonomousStallReason(reason: string): string {
  if (/\bBROWSER_PROOF\b/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because I still did not get browser or UI proof that the page rendered as expected.",
      "keep the app running, prove localhost readiness, and then rerun the browser verification step."
    );
  }
  if (/\bREADINESS_PROOF\b/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because I still did not get readiness proof that the app or service was running.",
      "start or inspect the local app, then rerun with a probe_http or verify_browser step that proves it is reachable."
    );
  }
  if (/\bARTIFACT_MUTATION\b/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because I still did not get proof that the requested project files or artifacts were changed.",
      "rerun with an explicit file-change, build, or write action instead of inspection-only steps."
    );
  }
  if (/\bTARGET_PATH_TOUCH\b/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because I still did not get proof that the requested target path was touched.",
      "rerun with actions that create or modify files in the requested target path."
    );
  }
  return appendActionableNextStep(
    "I stopped because I could not verify enough real execution progress to prove the goal happened in this run.",
    "retry with a narrower execution request or clearer concrete steps."
  );
}

/**
 * Renders a human-first explanation for autonomous execution failures.
 *
 * **Why it exists:**
 * Planner and loop failures often surface as internal validator phrases that make sense to
 * developers but not to normal users. This helper keeps the stop reason truthful while translating
 * those internal phrases into practical language.
 *
 * **What it talks to:**
 * - Uses local deterministic regex helpers within this module.
 *
 * @param reason - Autonomous execution failure text with any reason-code prefix already stripped.
 * @returns Human-readable execution failure explanation.
 */
function humanizeAutonomousExecutionFailureReason(reason: string): string {
  if (/Retrieval quarantine blocked lesson .*PRIVATE_RANGE_TARGET_DENIED/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because an internal saved lesson about localhost was filtered out. That internal note should have been ignored instead of stopping your task.",
      "retry the same request; this was an internal runtime fault, not something you need to rewrite."
    );
  }

  if (/Planner model returned no live-verification actions for execution-style live-run request\.?/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because the planner never produced a valid live-run verification plan. It did not include the run, readiness-check, or browser-proof steps needed to verify the app.",
      "retry with an explicit request to start the app, prove readiness with probe_http, and then verify the page with verify_browser."
    );
  }

  if (/Planner model returned no verify_browser action for explicit browser\/UI verification request\.?/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because the planner never produced the browser-check step needed to verify the page in a real browser.",
      "retry with an explicit request to run verify_browser after readiness passes."
    );
  }

  if (/Planner model returned inspection-only actions for execution-style build request\.?/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because the planner only proposed inspection steps, not the real execution steps needed to build or run the requested work.",
      "retry with explicit build, write, install, or run steps instead of asking only for inspection."
    );
  }

  if (/Planner model returned no executable non-respond actions for execution-style build request\.?/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because the planner did not produce any executable steps. It only produced a response instead of actions that could do the work.",
      "retry with execute-now wording and a concrete write, build, or run step."
    );
  }

  if (/Planner model started a managed process without a readiness or browser proof action in the same plan\.?/i.test(reason)) {
    return appendActionableNextStep(
      "I stopped because the planner tried to start a process without also planning the readiness or browser-proof steps needed to verify it.",
      "retry with one finite flow that includes start_process, probe_http, and verify_browser."
    );
  }

  return appendActionableNextStep(
    reason.replace(
      /^Iteration\s+\d+\s+failed\s+before\s+completion:\s*/i,
      "I hit an execution failure: "
    ),
    "inspect the failing step and retry with a narrower request if the same error repeats."
  );
}

/**
 * Renders a human-first explanation for autonomous stop or abort reasons.
 *
 * **Why it exists:**
 * The autonomous loop, CLI, and chat adapters all surface the same runtime reasons. This helper
 * keeps those surfaces consistent so the user sees one clear explanation instead of raw control
 * plane diagnostics.
 *
 * **What it talks to:**
 * - Uses autonomy reason contracts from `./contracts`.
 * - Uses local deterministic helpers within this module.
 *
 * @param reason - Raw autonomous-loop reason text.
 * @returns Human-readable stop explanation with no bracketed reason codes.
 */
export function humanizeAutonomousStopReason(reason: string): string {
  const reasonCode = extractAutonomousReasonCode(reason);
  const strippedReason = stripAutonomousReasonCode(reason);

  if (!reasonCode) {
    if (/^cancelled by user\.?$/i.test(strippedReason)) {
      return appendActionableNextStep(
        "Stopped because you cancelled the run.",
        "restart the run when you are ready to continue."
      );
    }
    return strippedReason;
  }

  switch (reasonCode) {
    case EXECUTION_STYLE_STALL_REASON_CODE:
      return humanizeAutonomousStallReason(strippedReason);
    case EXECUTION_STYLE_GOAL_GATING_REASON_CODE:
      return appendActionableNextStep(
        "I need real executed side effects before I can call this goal done.",
        "rerun with an explicit execute-now request that includes at least one real write, build, or run step."
      );
    case EXECUTION_STYLE_TARGET_PATH_GATING_REASON_CODE:
      return appendActionableNextStep(
        "I need evidence that the requested target path was actually touched.",
        "rerun with actions that create or modify files directly in the requested path."
      );
    case EXECUTION_STYLE_MUTATION_GATING_REASON_CODE:
      return appendActionableNextStep(
        "I need evidence that the requested project files or artifacts were actually changed.",
        "rerun with explicit mutation steps such as write_file, build output, or another real artifact-changing action."
      );
    case EXECUTION_STYLE_READINESS_GATING_REASON_CODE:
      return appendActionableNextStep(
        "I need readiness proof before I can say the app or service is running.",
        "start the app or service, then prove it with probe_http or another readiness check before asking for completion."
      );
    case EXECUTION_STYLE_BROWSER_GATING_REASON_CODE:
      return appendActionableNextStep(
        "I need browser or UI proof before I can say the page rendered as expected.",
        "keep the app running and add verify_browser after readiness passes."
      );
    case EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE:
      return appendActionableNextStep(
        "I stopped because this environment blocked the localhost readiness or browser verification steps, so I could not truthfully confirm the app or page in this run.",
        "allow local process and browser verification in this environment, or rerun where localhost checks are permitted."
      );
    case EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE:
      return appendActionableNextStep(
        "I stopped because the local server process kept running but never became HTTP-ready, so I could not truthfully verify the app or page in this run.",
        "inspect the server command, chosen port, and startup logs, then retry once the app serves HTTP on localhost."
      );
    case MAX_ITERATIONS_REASON_CODE:
      return appendActionableNextStep(
        "I hit the configured iteration limit before I could finish.",
        "narrow the goal or raise the iteration limit if this task legitimately needs more steps."
      );
    case TASK_EXECUTION_FAILED_REASON_CODE:
      return humanizeAutonomousExecutionFailureReason(strippedReason);
    case "AUTONOMOUS_LOOP_RUNTIME_ERROR":
      return appendActionableNextStep(
        strippedReason.replace(
          /^Autonomous loop runtime failure:\s*/i,
          "I hit a runtime error: "
        ),
        "retry the run, and if it repeats, inspect the runtime or provider logs for the failing dependency."
      );
    default:
      return strippedReason;
  }
}
