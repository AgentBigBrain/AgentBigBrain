/**
 * @fileoverview Provides deterministic abort helpers for governed runtime cancellation flow.
 */

/**
 * Creates a stable abort error used by runtime cancellation paths.
 *
 * **Why it exists:**
 * Keeps cancellation signaling consistent across autonomous loop, orchestrator, task runner, and
 * executor code paths so callers can distinguish user-initiated aborts from ordinary failures.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param message - Human-readable cancellation detail.
 * @returns Error tagged with `AbortError` name.
 */
export function createAbortError(message = "Cancelled by user."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Evaluates unknown error input and returns a deterministic abort signal.
 *
 * **Why it exists:**
 * Centralizes abort-error detection so higher-level control flow can render user cancellation
 * cleanly without relying on ad hoc message parsing.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param error - Unknown thrown value from runtime execution.
 * @returns `true` when the error represents cancellation.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Throws deterministic abort error when the provided signal is already cancelled.
 *
 * **Why it exists:**
 * Allows runtime layers to fail fast before planning or execution work proceeds after explicit
 * user cancellation.
 *
 * **What it talks to:**
 * - Uses `createAbortError` in this module.
 *
 * @param signal - Optional abort signal propagated from interface/runtime caller.
 * @param message - Human-readable cancellation detail.
 * @returns Nothing; throws when `signal.aborted` is `true`.
 */
export function throwIfAborted(signal?: AbortSignal, message = "Cancelled by user."): void {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}
