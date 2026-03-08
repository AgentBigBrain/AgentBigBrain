/**
 * @fileoverview Renders bounded user-facing remembered-situation review output.
 */

import type { ConversationMemoryReviewRecord } from "./managerContracts";

/**
 * Renders help text for `/memory` review commands.
 *
 * @returns Multi-line usage guidance for memory review commands.
 */
export function renderMemoryReviewHelpText(): string {
  return [
    "Usage: /memory [list]",
    "Usage: /memory resolve <episode-id> [outcome note]",
    "Usage: /memory wrong <episode-id> [correction note]",
    "Usage: /memory forget <episode-id>",
    "This command is private-only and shows a bounded list of remembered situations."
  ].join("\n");
}

/**
 * Renders a bounded list of remembered situations for direct user review.
 *
 * @param episodes - Readable remembered situations to render.
 * @returns Human-facing review block.
 */
export function renderMemoryReviewList(
  episodes: readonly ConversationMemoryReviewRecord[]
): string {
  if (episodes.length === 0) {
    return "I don't currently have any remembered situations worth surfacing here.";
  }

  const lines = ["Remembered situations:"];
  for (const episode of episodes) {
    lines.push(`- ${episode.title} (${episode.episodeId})`);
    lines.push(`  Status: ${episode.status}`);
    lines.push(`  Last mentioned: ${episode.lastMentionedAt}`);
    lines.push(`  Summary: ${episode.summary}`);
  }
  lines.push("");
  lines.push("You can say:");
  lines.push("- /memory resolve <episode-id> [outcome note]");
  lines.push("- /memory wrong <episode-id> [correction note]");
  lines.push("- /memory forget <episode-id>");
  return lines.join("\n");
}

/**
 * Renders the user-facing response after a remembered-situation mutation.
 *
 * @param action - Mutation that was attempted.
 * @param episode - Updated or removed remembered situation.
 * @returns Human-facing mutation result text.
 */
export function renderMemoryReviewMutationResult(
  action: "resolve" | "wrong" | "forget",
  episode: ConversationMemoryReviewRecord | null
): string {
  if (!episode) {
    return "I couldn't find that remembered situation. Use /memory to see the current bounded list.";
  }

  if (action === "resolve") {
    return `Marked "${episode.title}" as resolved.`;
  }
  if (action === "wrong") {
    return `Marked "${episode.title}" as no longer relevant.`;
  }
  return `Forgot "${episode.title}".`;
}
