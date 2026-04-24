/**
 * @fileoverview Renders grouped execution-receipt notes for the Obsidian projection sink.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";

/**
 * Renders one grouped execution-receipt note from approved action provenance.
 *
 * **Why it exists:**
 * Receipts are important for auditability, but the first mirror release stays readable by grouping
 * them into one operator-facing note instead of exploding the vault with one note per receipt.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Grouped receipt notes for the vault mirror.
 */
export function renderObsidianReceiptNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  return [
    {
      relativePath: "21 Receipts/Approved Actions.md",
      content: [
        renderObsidianFrontmatter({
          abb_type: "execution_receipt_summary",
          updated_at: snapshot.generatedAt,
          receipt_count: snapshot.executionReceipts.length
        }),
        "# Approved Action Receipts",
        "",
        renderMarkdownList(
          snapshot.executionReceipts.map((receipt) =>
            `${receipt.recordedAt}: ${receipt.actionType} (${receipt.actionId}) receipt=${receipt.receiptHash.slice(0, 12)}`
          )
        )
      ].join("\n")
    }
  ];
}
