/**
 * @fileoverview Shared gateway helpers for session-aware task execution closures.
 */

import { selectUserFacingSummary } from "./userFacingResult";
import type { InterfaceSessionStore } from "./sessionStore";
import type { InterfaceBrainRegistry } from "./interfaceBrainRegistry";

export interface GatewayTextExecutionSummaryOptions {
  showTechnicalSummary: boolean;
  showSafetyCodes: boolean;
}

/**
 * Runs one governed text task for the current gateway session using the selected backend/profile.
 *
 * @param sessionStore - Session store used to resolve session override state.
 * @param brainRegistry - Shared backend-aware runtime registry.
 * @param sessionKey - Canonical conversation session key.
 * @param input - User input to execute.
 * @param receivedAt - Timestamp for deterministic task metadata.
 * @param summaryOptions - User-facing summary rendering options.
 * @returns User-facing summary plus the raw governed task result when available.
 */
export async function runGatewaySessionTextTask(
  sessionStore: InterfaceSessionStore,
  brainRegistry: InterfaceBrainRegistry,
  sessionKey: string,
  input: string,
  receivedAt: string,
  summaryOptions: GatewayTextExecutionSummaryOptions
): Promise<{
  summary: string;
  taskRunResult: Awaited<ReturnType<InterfaceBrainRegistry["runTaskForSession"]>>["taskRunResult"];
}> {
  const session = await sessionStore.getSession(sessionKey);
  const execution = await brainRegistry.runTaskForSession(session, input, receivedAt);
  return {
    summary: execution.taskRunResult
      ? selectUserFacingSummary(execution.taskRunResult, summaryOptions)
      : execution.summary,
    taskRunResult: execution.taskRunResult ?? null
  };
}

/**
 * Runs one autonomous task for the current gateway session using the selected backend/profile.
 *
 * @param sessionStore - Session store used to resolve session override state.
 * @param brainRegistry - Shared backend-aware runtime registry.
 * @param sessionKey - Canonical conversation session key.
 * @param goal - Autonomous goal to pursue.
 * @param timestamp - Timestamp for deterministic loop metadata.
 * @param progressSender - Transport-facing progress callback.
 * @param signal - Optional cancellation signal.
 * @param initialExecutionInput - Optional richer first-turn execution prompt.
 * @returns Autonomous execution result routed through the selected session backend.
 */
export async function runGatewaySessionAutonomousTask(
  sessionStore: InterfaceSessionStore,
  brainRegistry: InterfaceBrainRegistry,
  sessionKey: string,
  goal: string,
  timestamp: string,
  progressSender: (message: string) => Promise<void>,
  signal?: AbortSignal,
  initialExecutionInput?: string | null
) {
  const session = await sessionStore.getSession(sessionKey);
  return brainRegistry.runAutonomousTaskForSession(
    session,
    goal,
    timestamp,
    progressSender,
    signal,
    initialExecutionInput
  );
}
