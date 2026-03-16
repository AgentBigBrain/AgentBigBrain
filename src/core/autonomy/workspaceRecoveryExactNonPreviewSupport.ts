/**
 * @fileoverview Shared exact non-preview holder wording for bounded workspace-recovery clarification.
 */

import { formatExactHolderLabel } from "./workspaceRecoveryNarration";

export interface WorkspaceRecoveryExactNonPreviewHolder {
  pid: number;
  kind: string | null;
  name: string | null;
}

/**
 * Formats exact holder labels into one natural-language list for clarification prompts.
 *
 * @param candidates - Exact confirmed non-preview holder metadata.
 * @returns User-facing label list.
 */
export function formatExactNonPreviewHolderLabels(
  candidates: readonly WorkspaceRecoveryExactNonPreviewHolder[]
): string {
  const labels = candidates.map((candidate) =>
    formatExactHolderLabel(candidate.name, candidate.pid)
  );
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Builds the exact recovery instruction that stops one or more confirmed high-confidence
 * non-preview holders after the user has approved that precise shutdown.
 *
 * @param overarchingGoal - Original folder-organization goal being continued.
 * @param candidates - Exact confirmed holder metadata to stop.
 * @returns Marker-bearing recovery input for the next bounded step.
 */
export function buildWorkspaceRecoveryExactNonPreviewShutdownInput(
  overarchingGoal: string,
  candidates: readonly WorkspaceRecoveryExactNonPreviewHolder[]
): string {
  const holderLabels = candidates.map((candidate) =>
    formatExactHolderLabel(candidate.name, candidate.pid)
  );
  const holderTargetList = holderLabels.map((holderLabel) => `"${holderLabel}"`).join(", ");
  return [
    "[WORKSPACE_RECOVERY_STOP_EXACT]",
    `A folder move was blocked because ${
      candidates.length > 1
        ? "high-confidence local holders still own the target folders"
        : "one high-confidence local holder still owns the target folders"
    }. Stop only ${
      candidates.length > 1
        ? "these exact confirmed local holders"
        : "this exact confirmed local holder"
    } if ${
      candidates.length > 1 ? "they are" : "it is"
    } still active: ${holderTargetList}. ` +
      `Verify ${
        candidates.length > 1 ? "they stopped" : "it stopped"
      }, then retry this original folder-organization goal: "${overarchingGoal}". ` +
      "Do not stop unrelated apps by name. If those exact holders are already gone, inspect the path holders once and explain the remaining blocker plainly instead of claiming the move worked."
  ].join("\n");
}
