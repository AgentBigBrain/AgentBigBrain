/**
 * @fileoverview Shared typed signal builders for workspace-recovery clarification, retry, and stop outcomes.
 */

import type { WorkspaceRecoverySignal } from "./workspaceRecoveryPolicy";
import {
  buildLikelyNonPreviewHolderCountSummary,
  buildLikelyNonPreviewHolderSetDescription,
  formatExactHolderLabel,
  formatNamedHolderExamples
} from "./workspaceRecoveryNarration";

export interface ExactNonPreviewHolderCandidate {
  pid: number;
  kind: string | null;
  name: string | null;
}

/**
 * Formats one short natural-language list of exact holder labels.
 *
 * @param holders - Exact local holders recovered from runtime inspection.
 * @returns Human-facing label list.
 */
function formatExactHolderLabelList(
  holders: readonly ExactNonPreviewHolderCandidate[]
): string {
  const labels = holders.map((holder) => formatExactHolderLabel(holder.name, holder.pid));
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

interface BaseWorkspaceRecoverySignalArgs {
  recommendedAction: WorkspaceRecoverySignal["recommendedAction"];
  matchedRuleId: string;
  reasoning: string;
  question: string;
  recoveryInstruction: string;
  trackedPreviewProcessLeaseIds?: readonly string[];
  recoveredExactHolderPids?: readonly number[];
  untrackedCandidatePids?: readonly number[];
  untrackedCandidateKinds?: readonly string[];
  untrackedCandidateNames?: readonly string[];
  blockedFolderPaths?: readonly string[];
  exactNonPreviewHolders?: readonly ExactNonPreviewHolderCandidate[];
  exactNonPreviewHolderPid?: number | null;
  exactNonPreviewHolderKind?: string | null;
  exactNonPreviewHolderName?: string | null;
}

/**
 * Selects one single high-confidence non-preview holder candidate when runtime inspection proved a
 * narrow confirmation-gated shutdown target.
 *
 * @param untrackedCandidates - Structured untracked-holder metadata recovered from inspection.
 * @returns Exact candidate to confirm, or `null` when the evidence is broader or lower-confidence.
 */
export function selectExactNonPreviewHolderCandidate(
  untrackedCandidates: readonly {
    pid: number;
    kind: string | null;
    name: string | null;
    confidence: "high" | "medium" | "low" | null;
    reason: string | null;
  }[]
): ExactNonPreviewHolderCandidate | null {
  const exactCandidates = selectExactNonPreviewHolderCandidates(untrackedCandidates);
  if (exactCandidates.length !== 1) {
    return null;
  }
  return exactCandidates[0];
}

/**
 * Selects the exact-path high-confidence non-preview holders that are still narrow enough for one
 * targeted confirmation step.
 *
 * @param untrackedCandidates - Structured untracked-holder metadata recovered from inspection.
 * @returns Exact holder candidates, or an empty array when the evidence is broader.
 */
export function selectExactNonPreviewHolderCandidates(
  untrackedCandidates: readonly {
    pid: number;
    kind: string | null;
    name: string | null;
    confidence: "high" | "medium" | "low" | null;
    reason: string | null;
  }[]
): readonly ExactNonPreviewHolderCandidate[] {
  const exactCandidates = untrackedCandidates.filter(
    (candidate) =>
      candidate.confidence === "high" &&
      candidate.reason === "command_line_matches_target_path" &&
      candidate.kind !== "preview_server"
  );
  if (exactCandidates.length === 0) {
    return [];
  }
  if (untrackedCandidates.some((candidate) => candidate.kind === "preview_server")) {
    return [];
  }
  return exactCandidates.map((candidate) => ({
    pid: candidate.pid,
    kind: candidate.kind,
    name: candidate.name
  }));
}

/**
 * Builds one canonical workspace-recovery signal with fail-closed defaults for optional evidence.
 *
 * @param args - Structured signal fields for this recovery outcome.
 * @returns Normalized recovery signal ready for autonomous or conversation use.
 */
function buildWorkspaceRecoverySignal(args: BaseWorkspaceRecoverySignalArgs): WorkspaceRecoverySignal {
  const exactNonPreviewHolders =
    args.exactNonPreviewHolders && args.exactNonPreviewHolders.length > 0
      ? args.exactNonPreviewHolders
      : typeof args.exactNonPreviewHolderPid === "number"
        ? [
            {
              pid: args.exactNonPreviewHolderPid,
              kind: args.exactNonPreviewHolderKind ?? null,
              name: args.exactNonPreviewHolderName ?? null
            }
          ]
        : [];
  const singleExactNonPreviewHolder =
    exactNonPreviewHolders.length === 1 ? exactNonPreviewHolders[0] : null;
  return {
    recommendedAction: args.recommendedAction,
    matchedRuleId: args.matchedRuleId,
    reasoning: args.reasoning,
    question: args.question,
    recoveryInstruction: args.recoveryInstruction,
    trackedPreviewProcessLeaseIds: args.trackedPreviewProcessLeaseIds ?? [],
    recoveredExactHolderPids: args.recoveredExactHolderPids ?? [],
    untrackedCandidatePids: args.untrackedCandidatePids ?? [],
    untrackedCandidateKinds: args.untrackedCandidateKinds ?? [],
    untrackedCandidateNames: args.untrackedCandidateNames ?? [],
    blockedFolderPaths: args.blockedFolderPaths ?? [],
    exactNonPreviewHolders,
    exactNonPreviewHolderPid: args.exactNonPreviewHolderPid ?? singleExactNonPreviewHolder?.pid ?? null,
    exactNonPreviewHolderKind: args.exactNonPreviewHolderKind ?? singleExactNonPreviewHolder?.kind ?? null,
    exactNonPreviewHolderName: args.exactNonPreviewHolderName ?? singleExactNonPreviewHolder?.name ?? null
  };
}

/**
 * Builds one exact-tracked-holder recovery signal.
 *
 * @param args - Structured exact-holder recovery fields.
 * @returns Normalized exact-holder recovery signal.
 */
export function buildStopExactTrackedRecoverySignal(
  args: Omit<BaseWorkspaceRecoverySignalArgs, "recommendedAction">
): WorkspaceRecoverySignal {
  return buildWorkspaceRecoverySignal({
    ...args,
    recommendedAction: "stop_exact_tracked_holders"
  });
}

/**
 * Builds one targeted exact non-preview holder clarification signal.
 *
 * @param args - Structured targeted-holder clarification fields.
 * @returns Normalized clarification signal.
 */
export function buildExactNonPreviewClarificationSignal(
  args: Omit<BaseWorkspaceRecoverySignalArgs, "recommendedAction">
): WorkspaceRecoverySignal {
  return buildWorkspaceRecoverySignal({
    ...args,
    recommendedAction: "clarify_before_exact_non_preview_shutdown"
  });
}

/**
 * Builds one likely non-preview holder clarification signal.
 *
 * @param args - Structured likely-holder clarification fields.
 * @returns Normalized clarification signal.
 */
export function buildLikelyNonPreviewClarificationSignal(
  args: Omit<BaseWorkspaceRecoverySignalArgs, "recommendedAction">
): WorkspaceRecoverySignal {
  return buildWorkspaceRecoverySignal({
    ...args,
    recommendedAction: "clarify_before_likely_non_preview_shutdown"
  });
}

/**
 * Builds one preview-candidate clarification signal.
 *
 * @param args - Structured preview-candidate clarification fields.
 * @returns Normalized clarification signal.
 */
export function buildPreviewClarificationSignal(
  args: Omit<BaseWorkspaceRecoverySignalArgs, "recommendedAction">
): WorkspaceRecoverySignal {
  return buildWorkspaceRecoverySignal({
    ...args,
    recommendedAction: "clarify_before_untracked_shutdown"
  });
}

/**
 * Builds one stop-with-explanation signal when no safe live holder remains.
 *
 * @param args - Structured stop signal fields.
 * @returns Normalized stop signal.
 */
export function buildStopNoLiveHoldersSignal(
  args: Omit<BaseWorkspaceRecoverySignalArgs, "recommendedAction">
): WorkspaceRecoverySignal {
  return buildWorkspaceRecoverySignal({
    ...args,
    recommendedAction: "stop_no_live_holders_found"
  });
}

/**
 * Builds one bounded retry-after-inspection signal.
 *
 * @param args - Structured retry signal fields.
 * @returns Normalized retry signal.
 */
export function buildRetryAfterInspectionSignal(
  args: Omit<BaseWorkspaceRecoverySignalArgs, "recommendedAction">
): WorkspaceRecoverySignal {
  return buildWorkspaceRecoverySignal({
    ...args,
    recommendedAction: "retry_after_inspection"
  });
}

/**
 * Builds one inspect-first recovery signal.
 *
 * @param args - Structured inspect-first signal fields.
 * @returns Normalized inspect-first signal.
 */
export function buildInspectFirstRecoverySignal(
  args: Omit<BaseWorkspaceRecoverySignalArgs, "recommendedAction">
): WorkspaceRecoverySignal {
  return buildWorkspaceRecoverySignal({
    ...args,
    recommendedAction: "inspect_first"
  });
}

/**
 * Builds the human-facing autonomous abort reason when only confirmation-gated or manual holder
 * evidence remains.
 *
 * @param signal - Structured workspace-recovery signal for the latest task result.
 * @returns Truthful abort reason explaining why confirmation is still required.
 */
export function buildWorkspaceRecoveryAbortReasonFromSignal(
  signal: WorkspaceRecoverySignal
): string {
  if (signal.matchedRuleId === "post_execution_orphaned_browser_cleanup_required") {
    return (
      "Autonomous recovery stopped because I found older assistant browser windows still tied to that workspace, but I no longer have direct runtime control over them and did not prove a live holder I can shut down safely."
    );
  }
  if (
    signal.matchedRuleId ===
      "post_execution_exact_non_preview_holder_recovery_clarification" ||
    signal.matchedRuleId ===
      "inspection_only_exact_non_preview_holder_recovery_clarification"
  ) {
    const exactNonPreviewHolders = signal.exactNonPreviewHolders ?? [];
    const holderLabel =
      exactNonPreviewHolders.length > 0
        ? formatExactHolderLabelList(exactNonPreviewHolders)
        : typeof signal.exactNonPreviewHolderPid === "number"
          ? formatExactHolderLabel(
              signal.exactNonPreviewHolderName,
              signal.exactNonPreviewHolderPid
            )
          : null;
    return (
      `Autonomous recovery stopped because inspection found ${
        exactNonPreviewHolders.length > 1
          ? `${exactNonPreviewHolders.length} high-confidence local holders tied to the blocked folders, but I still need your confirmation before I stop those exact processes.`
          : "one high-confidence local holder tied to the blocked folders, but I still need your confirmation before I stop that exact process."
      }` +
      (holderLabel
        ? ` Likely holder${exactNonPreviewHolders.length > 1 ? "s" : ""}: ${holderLabel}.`
        : "")
    );
  }
  if (
    signal.matchedRuleId ===
      "post_execution_likely_non_preview_holder_recovery_clarification" ||
    signal.matchedRuleId ===
      "inspection_only_likely_non_preview_holder_recovery_clarification"
  ) {
    const candidateSummary =
      signal.untrackedCandidatePids.length > 0
        ? ` Likely holder pid(s): ${signal.untrackedCandidatePids.join(", ")}.`
        : "";
    const holderSetDescription = buildLikelyNonPreviewHolderSetDescription(
      signal.untrackedCandidateKinds ?? [],
      signal.untrackedCandidatePids.length
    );
    return (
      `Autonomous recovery stopped because inspection found ${holderSetDescription} tied to the blocked folders, but I still need your confirmation before I stop those likely processes.` +
      candidateSummary
    );
  }
  if (
    signal.matchedRuleId === "post_execution_non_preview_holder_cleanup_required" ||
    signal.matchedRuleId ===
      "post_execution_contextual_non_preview_holder_cleanup_required" ||
    signal.matchedRuleId === "inspection_only_non_preview_holder_cleanup_required"
    || signal.matchedRuleId ===
      "inspection_only_contextual_non_preview_holder_cleanup_required"
  ) {
    const contextualHolderSummary =
      signal.untrackedCandidatePids.length > 8 && signal.untrackedCandidateKinds.length > 0
        ? buildLikelyNonPreviewHolderCountSummary(
            signal.untrackedCandidateKinds,
            signal.untrackedCandidatePids.length
          )
        : null;
    const holderExamples = formatNamedHolderExamples(signal.untrackedCandidateNames ?? []);
    const candidateSummary =
      signal.untrackedCandidatePids.length > 0
        ? ` Candidate pid(s): ${signal.untrackedCandidatePids.join(", ")}.`
        : "";
    if (contextualHolderSummary) {
      return (
        `Autonomous recovery stopped because inspection found ${contextualHolderSummary} tied to the blocked folders, but that broader local set is outside the confirmation lane and I did not prove an exact preview holder I can shut down safely from runtime evidence alone.` +
        holderExamples +
        candidateSummary +
        " Close or narrow that local holder set first, then ask me to retry."
      );
    }
    return (
      "Autonomous recovery stopped because inspection found likely non-preview local holders, such as editor, shell, or sync processes, and I did not prove an exact preview holder I can shut down safely from runtime evidence alone. Close that local holder first, then ask me to retry."
    );
  }
  if (signal.recommendedAction === "stop_no_live_holders_found") {
    return (
      "Autonomous recovery stopped because inspection found only stale assistant-owned workspace records, not a live holder that could be shut down safely. The remaining blocker is still unknown."
    );
  }
  const candidateSummary =
    signal.untrackedCandidatePids.length > 0
      ? ` Likely holder pid(s): ${signal.untrackedCandidatePids.join(", ")}.`
      : "";
  return (
    "Autonomous recovery stopped because the blocked folders appear to be held by likely local preview processes that are not exact tracked runtime resources." +
    candidateSummary +
    " I need your confirmation before shutting those down."
  );
}
