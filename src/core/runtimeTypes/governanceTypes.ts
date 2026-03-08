/**
 * @fileoverview Canonical governor and council contracts extracted from the shared runtime type surface.
 */

export type GovernorId =
  | "ethics"
  | "logic"
  | "resource"
  | "security"
  | "continuity"
  | "utility"
  | "compliance"
  | "codeReview";

export const ALL_GOVERNOR_IDS: readonly GovernorId[] = [
  "ethics",
  "logic",
  "resource",
  "security",
  "continuity",
  "utility",
  "compliance",
  "codeReview"
] as const;

export const FULL_COUNCIL_GOVERNOR_IDS: GovernorId[] = [
  "ethics",
  "logic",
  "resource",
  "security",
  "continuity",
  "utility",
  "compliance"
];

/**
 * Evaluates governor id and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the governor id policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is GovernorId` result.
 */
export function isGovernorId(value: unknown): value is GovernorId {
  return typeof value === "string" && ALL_GOVERNOR_IDS.includes(value as GovernorId);
}
