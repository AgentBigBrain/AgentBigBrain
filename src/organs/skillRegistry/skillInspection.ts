/**
 * @fileoverview User-facing rendering helpers for governed skill inventory inspection.
 */

import type { SkillInventoryEntry } from "./contracts";

/**
 * Renders the current skill inventory for slash, voice-command, and natural-language discovery.
 *
 * @param skills - Available skill entries from the registry.
 * @returns Human-readable inventory text.
 */
export function renderSkillInventory(skills: readonly SkillInventoryEntry[]): string {
  if (skills.length === 0) {
    return "I do not have any saved skills yet.";
  }

  const lines = ["Available skills:"];
  for (const skill of skills) {
    const firstHint = skill.invocationHints[0];
    const suffix = firstHint ? ` Hint: ${firstHint}` : "";
    const summary = skill.userSummary.replace(/[.?!]+$/u, "");
    lines.push(
      `- ${skill.name} (${skill.verificationStatus}, ${skill.riskLevel} risk): ${summary}.${suffix}`
    );
  }
  return lines.join("\n");
}
