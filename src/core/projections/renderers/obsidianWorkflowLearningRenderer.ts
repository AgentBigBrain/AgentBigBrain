/**
 * @fileoverview Renders grouped workflow-learning notes for the Obsidian projection sink.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";

/**
 * Renders one grouped workflow-learning note from persisted workflow patterns.
 *
 * **Why it exists:**
 * Workflow learning is useful to inspect at a summary level, and grouping patterns into one note
 * keeps the first mirror release readable without sacrificing operator visibility.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Grouped workflow-learning notes for the vault mirror.
 */
export function renderObsidianWorkflowLearningNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  return [
    {
      relativePath: "31 Workflow Learning/Patterns.md",
      content: [
        renderObsidianFrontmatter({
          abb_type: "workflow_learning_summary",
          updated_at: snapshot.generatedAt,
          pattern_count: snapshot.workflowPatterns.length
        }),
        "# Workflow Learning Patterns",
        "",
        renderMarkdownList(
          snapshot.workflowPatterns.map((pattern) =>
            `${pattern.workflowKey} (${pattern.status}, confidence=${pattern.confidence})`
          )
        )
      ].join("\n")
    }
  ];
}
