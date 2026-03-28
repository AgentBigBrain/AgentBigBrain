/**
 * @fileoverview Deterministic command-policy helpers for ConversationManager slash and pulse command handling.
 */

import { ConversationSession } from "./sessionStore";
import {
  renderAgentPulseStatus,
  resetAgentPulseRuntimeStatus
} from "./conversationDraftStatusPolicy";

interface ConversationCheckpointReviewResultLike {
  checkpointId: string;
  overallPass: boolean;
  artifactPath: string;
  summaryLines: readonly string[];
}

type ConversationCheckpointReviewRunnerLike = (
  checkpointId: string
) => Promise<ConversationCheckpointReviewResultLike | null>;

const LIVE_REVIEW_SUPPORTED_CHECKPOINTS = [
  "6.11",
  "6.13",
  "6.75",
  "6.85.A",
  "6.85.B",
  "6.85.C",
  "6.85.D",
  "6.85.E",
  "6.85.F",
  "6.85.G",
  "6.85.H"
] as const;
const LIVE_REVIEW_SUPPORTED_CHECKPOINTS_RENDERED = LIVE_REVIEW_SUPPORTED_CHECKPOINTS.join(", ");
const LIVE_REVIEW_USAGE_EXAMPLE =
  "Usage: /review <checkpoint-id>. Example: /review 6.11, /review 6.75, or /review 6.85.A";

/**
 * Renders deterministic help text for slash-command users.
 *
 * **Why it exists:**
 * Keeps command-surface documentation centralized so help output stays consistent across command
 * paths and regression tests.
 *
 * **What it talks to:**
 * - Uses local command strings/constants only.
 *
 * @returns Multi-line help text rendered for `/help`.
 */
export function renderConversationCommandHelpText(): string {
  return [
    "Commands:",
    "/help - show this guide and examples",
    "/propose <task> - create a draft that requires explicit approval before execution",
    "/draft - show the active draft",
    "/adjust <changes> - modify the active draft",
    "/approve - execute the active draft",
    "/cancel - discard the active draft",
    "/chat <message> - queue/run a direct request (no draft required)",
    "/auto <goal> - run a multi-step autonomous loop for a complex goal",
    "/skills - list the reusable skills I currently have available",
    "/pulse <on|off|private|public|status> - control Agent Pulse proactive check-ins",
    "/memory [list|resolve|wrong|forget] - inspect or update remembered situations in this private conversation",
    "/review <checkpoint-id> - run a live checkpoint review command (supports 6.11, 6.13, 6.75, 6.85.A-6.85.H)",
    "/status [debug] - show plain-language job state; add debug for delivery internals",
    "Skill workflow:",
    "Use /skills to inspect the current skill inventory.",
    "There is no separate /skill command.",
    "Use /chat or /propose with natural-language intents like \"create skill ...\" or \"run skill ...\".",
    "Examples:",
    "/propose create a release checklist for this repo",
    "/chat summarize runtime/state.json",
    "/chat create skill repo_status that reads package.json and runtime/state.json and returns a repo summary",
    "/chat run skill repo_status on this repo",
    "/skills",
    "/auto create a React app at C:\\Users\\<you>\\Desktop\\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.",
    "Voice command tip: in a voice note, say \"command skills\" for /skills or \"command auto ...\" for /auto.",
    "/pulse on",
    "/memory",
    "/memory resolve episode_abc123 Owen recovered and is fine now",
    "/review 6.85.A",
    "/status",
    "/status debug",
    "Execution tip: for real side effects, say \"execute now\". Name your platform shell when you need a specific shell or for non-build shell tasks (PowerShell/cmd on Windows, Terminal/bash/zsh on macOS/Linux).",
    "Browser proof tip: ask me to run the app and verify the homepage UI. If Playwright is installed locally, I can use loopback browser verification after localhost readiness succeeds.",
    "Status tip: /status is the normal human view. Use /status debug only when you need ack/final-delivery lifecycle details.",
    "What I will tell you:",
    "- Executed: side-effect actions actually ran in this run.",
    "- Guidance only: the run produced instructions/analysis without side effects.",
    "- Blocked: safety/governance/runtime policy denied execution in this run.",
    "Autonomy note: /auto can still complete with guidance-only output unless your request explicitly requires executed side effects.",
    "If a draft is active, plain messages are treated as questions about that draft.",
    "If work is already running, new requests are queued with job IDs."
  ].join("\n");
}

/**
 * Resolves `/review` command output with deterministic usage, unsupported, pass/fail, and error text.
 *
 * **Why it exists:**
 * Review command formatting is reused in runtime and tests and should stay isolated from manager
 * orchestration details.
 *
 * **What it talks to:**
 * - Calls optional `runCheckpointReview` callback provided by conversation dependencies.
 * - Uses checkpoint support constants for unsupported-path messaging.
 *
 * @param argument - Raw checkpoint id argument text after `/review`.
 * @param runCheckpointReview - Optional live review runner callback.
 * @returns User-facing review command response text.
 */
export async function resolveReviewCommandResponse(
  argument: string,
  runCheckpointReview: ConversationCheckpointReviewRunnerLike | undefined
): Promise<string> {
  const normalized = argument.trim().toLowerCase();
  if (!normalized) {
    return LIVE_REVIEW_USAGE_EXAMPLE;
  }

  if (!runCheckpointReview) {
    return "Live review commands are unavailable in this runtime.";
  }

  try {
    const result = await runCheckpointReview(normalized);
    if (!result) {
      return `Unsupported checkpoint '${normalized}'. Currently supported: ${LIVE_REVIEW_SUPPORTED_CHECKPOINTS_RENDERED}.`;
    }

    return [
      `Checkpoint ${result.checkpointId} live review: ${result.overallPass ? "PASS" : "FAIL"}`,
      ...result.summaryLines,
      `Artifact: ${result.artifactPath}`
    ].join("\n");
  } catch (error) {
    return `Review command failed for checkpoint ${normalized}: ${(error as Error).message}`;
  }
}

/**
 * Resolves `/pulse` command behavior and updates pulse mode/runtime metadata.
 *
 * **Why it exists:**
 * Pulse command state transitions are governance-sensitive and should remain deterministic across
 * slash-command and natural-language pulse-control entry points.
 *
 * **What it talks to:**
 * - Mutates `session.agentPulse` mode/opt-in/route fields.
 * - Uses `resetAgentPulseRuntimeStatus` after setting changes.
 * - Uses `renderAgentPulseStatus` for user-facing status output.
 *
 * @param session - Mutable session state receiving pulse mode changes.
 * @param argument - Pulse subcommand argument (`on|off|private|public|status`).
 * @param receivedAt - Timestamp applied to persisted state updates.
 * @returns User-facing pulse command response text.
 */
export function resolvePulseCommandResponse(
  session: ConversationSession,
  argument: string,
  receivedAt: string
): string {
  const normalizedArgument = argument.trim().toLowerCase();
  if (!normalizedArgument || normalizedArgument === "status") {
    return renderAgentPulseStatus(session);
  }

  if (normalizedArgument === "on" || normalizedArgument === "private") {
    session.agentPulse.optIn = true;
    session.agentPulse.mode = "private";
    session.agentPulse.routeStrategy = "last_private_used";
    resetAgentPulseRuntimeStatus(session);
    session.updatedAt = receivedAt;
    return [
      normalizedArgument === "on"
        ? "Agent Pulse is now ON for this conversation."
        : "Agent Pulse is now PRIVATE for this conversation.",
      renderAgentPulseStatus(session)
    ].join("\n");
  }

  if (normalizedArgument === "public") {
    session.agentPulse.optIn = true;
    session.agentPulse.mode = "public";
    session.agentPulse.routeStrategy = "current_conversation";
    resetAgentPulseRuntimeStatus(session);
    session.updatedAt = receivedAt;
    return [
      "Agent Pulse is now PUBLIC for this conversation.",
      "Public mode sends generic check-ins only and avoids profile-derived details.",
      renderAgentPulseStatus(session)
    ].join("\n");
  }

  if (normalizedArgument === "off") {
    session.agentPulse.optIn = false;
    resetAgentPulseRuntimeStatus(session);
    session.updatedAt = receivedAt;
    return [
      "Agent Pulse is now OFF for this conversation.",
      renderAgentPulseStatus(session)
    ].join("\n");
  }

  return "Usage: /pulse <on|off|private|public|status>";
}
