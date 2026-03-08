/**
 * @fileoverview Owns shared transport-facing rejection policy helpers for interface gateways.
 */

/**
 * Returns `true` when validation rejects should still produce a user-facing transport reply.
 *
 * @param code - Stable validation/error code emitted by an interface adapter.
 * @returns `true` when the gateway should send the rejection summary back to the user.
 */
export function shouldNotifyRejectedInvocation(code: string): boolean {
  return code === "RATE_LIMITED" || code === "EMPTY_MESSAGE";
}
