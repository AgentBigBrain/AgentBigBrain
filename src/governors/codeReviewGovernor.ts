/**
 * @fileoverview Inspects dynamically generated auto-skills to block dangerous patterns or core modifications.
 */

import { Governor, GovernorContext } from "./types";
import { GovernanceProposal, GovernorVote } from "../core/types";

/**
 * Builds an approval outcome for input with typed metadata.
 *
 * **Why it exists:**
 * Standardizes input vote/result construction so downstream governance handling stays uniform.
 *
 * **What it talks to:**
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param reason - Value for reason.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @returns Computed `GovernorVote` result.
 */
function approve(governorId: "codeReview", reason: string, confidence = 0.85): GovernorVote {
  return { governorId, approve: true, reason, confidence };
}

/**
 * Builds a rejection outcome for input with typed metadata.
 *
 * **Why it exists:**
 * Standardizes input vote/result construction so downstream governance handling stays uniform.
 *
 * **What it talks to:**
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param reason - Value for reason.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @returns Computed `GovernorVote` result.
 */
function reject(governorId: "codeReview", reason: string, confidence = 0.9): GovernorVote {
  return { governorId, approve: false, reason, confidence };
}

/**
 * Reads string param needed for this execution step.
 *
 * **Why it exists:**
 * Separates string param read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param params - Structured input object for this operation.
 * @param key - Lookup key or map field identifier.
 * @returns Computed `string | undefined` result.
 */
function getStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

export const codeReviewGovernor: Governor = {
  id: "codeReview",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `GovernanceProposal` (import `GovernanceProposal`) from `../core/types`.
   * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
   * - Uses `GovernorContext` (import `GovernorContext`) from `./types`.
   *
   * @param proposal - Value for proposal.
   * @param _context - Message/text content processed by this function.
   * @returns Promise resolving to GovernorVote.
   */
  async evaluate(proposal: GovernanceProposal, _context: GovernorContext): Promise<GovernorVote> {
    if (proposal.action.type !== "create_skill") {
      return approve("codeReview", "Action is not a skill creation, skipping review.");
    }

    const code = getStringParam(proposal.action.params, "code") ?? "";

    // Block obvious dynamic-code execution and process-control escape patterns.
    const blockedConstructs = [
      /eval\s*\(/i,
      /new\s+Function\s*\(/i,
      /setTimeout\s*\(\s*['"]/i,
      /setInterval\s*\(\s*['"]/i,
      /child_process/i,
      /process\.env/i,
      /process\.exit\s*\(/i
    ];

    for (const pattern of blockedConstructs) {
      if (pattern.test(code)) {
        return reject(
          "codeReview",
          "Generated skill contains blocked dangerous constructs."
        );
      }
    }

    // Block imports/requires that target protected engine modules.
    const blockedImports = [
      /import.*from.*['"]\.\.\/core\/.*['"]/i,
      /require\(['"]\.\.\/core\/.*['"]\)/i,
      /import.*from.*['"]\.\.\/governors\/.*['"]/i,
      /require\(['"]\.\.\/governors\/.*['"]\)/i,
      /import.*from.*['"]src\/core\/.*['"]/i,
      /import.*from.*['"]src\/governors\/.*['"]/i
    ];

    for (const pattern of blockedImports) {
      if (pattern.test(code)) {
        return reject(
          "codeReview",
          "Generated skill attempts to import from protected engine modules."
        );
      }
    }

    return approve("codeReview", "Skill code passed code-review policy checks.");
  }
};
