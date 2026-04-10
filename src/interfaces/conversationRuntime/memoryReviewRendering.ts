/**
 * @fileoverview Renders bounded user-facing remembered-situation review output.
 */

import type {
  ConversationMemoryFactReviewRecord,
  ConversationMemoryFactReviewResult,
  ConversationMemoryReviewRecord
} from "./managerContracts";

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
    "Usage: /memory fact <query>",
    "Usage: /memory fact list <query>",
    "Usage: /memory fact correct <fact-id> <replacement value>",
    "Usage: /memory fact forget <fact-id>",
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
 * Classifies one remembered-fact review record into current, historical, or ambiguity output.
 *
 * @param fact - Fact review record under classification.
 * @returns Output lane for the rendered review block.
 */
function classifyFactReviewRecord(
  fact: ConversationMemoryFactReviewRecord
): "current" | "historical" | "ambiguity" {
  switch (fact.decisionRecord?.disposition) {
    case "selected_supporting_history":
      return "historical";
    case "ambiguous_contested":
    case "insufficient_evidence":
    case "needs_corroboration":
    case "quarantined":
      return "ambiguity";
    default:
      return "current";
  }
}

/**
 * Renders one remembered fact line for review output.
 *
 * @param fact - Fact review record to render.
 * @returns One bounded review line.
 */
function renderFactReviewLine(fact: ConversationMemoryFactReviewRecord): string {
  return `- ${fact.key}: ${fact.value} (${fact.factId})`;
}

/**
 * Renders one fact review section with a fail-closed `none` placeholder.
 *
 * @param label - Output section label.
 * @param facts - Facts belonging to that section.
 * @returns Bounded review lines for the section.
 */
function renderFactReviewSection(
  label: "Current State" | "Historical Context",
  facts: readonly ConversationMemoryFactReviewRecord[]
): readonly string[] {
  return [
    `${label}:`,
    ...(facts.length > 0 ? facts.map(renderFactReviewLine) : ["- none"])
  ];
}

/**
 * Describes why one remembered fact is being held back from current-state output.
 *
 * @param disposition - Query decision disposition for the reviewed fact.
 * @returns Human-readable ambiguity explanation.
 */
function describeFactReviewAmbiguity(
  disposition: NonNullable<ConversationMemoryFactReviewRecord["decisionRecord"]>["disposition"] | undefined
): string {
  switch (disposition) {
    case "ambiguous_contested":
      return "is still contested, so it is not being treated as current truth.";
    case "insufficient_evidence":
      return "does not have enough support to treat as current truth yet.";
    case "needs_corroboration":
      return "is being held back until it has stronger corroboration.";
    case "quarantined":
      return "is quarantined until the identity or alignment issue is resolved.";
    default:
      return "is not being surfaced as current truth.";
  }
}

/**
 * Renders one ambiguity line for a remembered fact held back from current-state output.
 *
 * @param fact - Fact review record to describe.
 * @returns One bounded ambiguity line.
 */
function renderFactReviewAmbiguityLine(
  fact: ConversationMemoryFactReviewRecord
): string {
  return `- ${fact.key}: ${fact.value} ${describeFactReviewAmbiguity(
    fact.decisionRecord?.disposition
  )}`;
}

/**
 * Renders one hidden-decision fallback line when the review holds back supporting evidence.
 *
 * @param disposition - Hidden decision-record disposition.
 * @returns One bounded ambiguity line.
 */
function renderHiddenDecisionRecordLine(
  disposition: ConversationMemoryFactReviewResult["hiddenDecisionRecords"][number]["disposition"]
): string {
  switch (disposition) {
    case "ambiguous_contested":
      return "- Some related evidence is still contested, so it is not being surfaced as current truth.";
    case "insufficient_evidence":
      return "- Some related evidence is still too weak to surface as current truth.";
    case "needs_corroboration":
      return "- Some related evidence is being held back until it has stronger corroboration.";
    case "quarantined":
      return "- Some related evidence is quarantined until the identity or alignment issue is resolved.";
    default:
      return "- none";
  }
}

/**
 * Renders a bounded remembered-fact review block with explicit current, historical, and ambiguity
 * sections.
 *
 * @param review - Fact review result to render.
 * @returns Human-facing fact review block.
 */
export function renderMemoryReviewFactList(
  review: ConversationMemoryFactReviewResult
): string {
  if (review.length === 0 && review.hiddenDecisionRecords.length === 0) {
    return "I couldn't find any remembered facts worth surfacing for that query.";
  }

  const currentFacts = review.filter((fact) => classifyFactReviewRecord(fact) === "current");
  const historicalFacts = review.filter((fact) => classifyFactReviewRecord(fact) === "historical");
  const ambiguousFacts = review.filter((fact) => classifyFactReviewRecord(fact) === "ambiguity");
  const ambiguityLines = [
    ...ambiguousFacts.map(renderFactReviewAmbiguityLine),
    ...review.hiddenDecisionRecords.map((record) => renderHiddenDecisionRecordLine(record.disposition))
  ];
  const lines = [
    "Remembered facts:",
    ...renderFactReviewSection("Current State", currentFacts),
    ...renderFactReviewSection("Historical Context", historicalFacts),
    "Ambiguity Notes:",
    ...(ambiguityLines.length > 0 ? ambiguityLines : ["- none"]),
    "",
    "You can say:",
    "- /memory fact correct <fact-id> <replacement value>",
    "- /memory fact forget <fact-id>"
  ];
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

/**
 * Renders the user-facing response after a remembered-fact mutation.
 *
 * @param action - Fact mutation that was attempted.
 * @param fact - Updated or removed remembered fact.
 * @returns Human-facing fact mutation result text.
 */
export function renderMemoryReviewFactMutationResult(
  action: "correct" | "forget",
  fact: ConversationMemoryFactReviewRecord | null
): string {
  if (!fact) {
    return "I couldn't find that remembered fact. Use /memory fact <query> to review the current bounded list.";
  }

  if (action === "correct") {
    return `Updated remembered fact "${fact.key}" to "${fact.value}".`;
  }
  return `Forgot remembered fact "${fact.key}".`;
}
