/**
 * @fileoverview Shared support for broader contextual manual-cleanup workspace-recovery stops.
 */

import type { WorkspaceRecoverySignal } from "./workspaceRecoveryPolicy";
import type { RuntimeInspectionUntrackedHolderKind } from "../../organs/liveRun/untrackedPreviewCandidateInspection";
import { selectContextualManualCleanupLikelyNonPreviewCandidates } from "../../organs/liveRun/untrackedPreviewCandidateRecoverySelectors";
import {
  buildLikelyNonPreviewHolderCountSummary,
  buildLikelyNonPreviewHolderSetDescription,
  formatNamedHolderExamples
} from "./workspaceRecoveryNarration";
import { buildStopNoLiveHoldersSignal } from "./workspaceRecoverySignalBuilders";

interface PersistedInspectionCandidate {
  pid: number;
  kind: string | null;
  name: string | null;
  confidence: "high" | "medium" | "low" | null;
  reason: string | null;
}

interface BuildContextualManualCleanupSignalArgs {
  matchedRuleId: string;
  leadingQuestionClause: string;
  untrackedCandidates: readonly PersistedInspectionCandidate[];
  untrackedCandidatePids: readonly number[];
  untrackedCandidateKinds: readonly string[];
  untrackedCandidateNames: readonly string[];
  manualCleanupGuidance: string;
  blockedFolderPaths?: readonly string[];
}

/**
 * Normalizes persisted inspection holder kinds into the live-run union used by selector helpers.
 *
 * @param holderKind - Candidate holder kind from persisted inspection metadata.
 * @returns Runtime holder kind union value.
 */
function normalizeRecoveryHolderKind(
  holderKind: string | null
): RuntimeInspectionUntrackedHolderKind {
  if (
    holderKind === "preview_server" ||
    holderKind === "editor_workspace" ||
    holderKind === "shell_workspace" ||
    holderKind === "sync_client" ||
    holderKind === "unknown_local_process"
  ) {
    return holderKind;
  }
  return "unknown_local_process";
}

/**
 * Builds a broader contextual manual-cleanup stop signal when the inspected local holder family is
 * still bounded enough to explain but too broad for the confirmation lane.
 *
 * @param args - Structured persisted inspection metadata and wording inputs.
 * @returns Stop signal for the broader contextual manual-cleanup lane, or `null` when it does not apply.
 */
export function buildContextualManualCleanupSignal(
  args: BuildContextualManualCleanupSignalArgs
): WorkspaceRecoverySignal | null {
  const contextualManualCleanupInspectionCandidates = args.untrackedCandidates.map((candidate) => ({
    pid: candidate.pid,
    port: null,
    processName: candidate.name,
    commandLine: null,
    confidence: candidate.confidence ?? "low",
    reason: candidate.reason ?? "unknown",
    holderKind: normalizeRecoveryHolderKind(candidate.kind)
  }));
  const contextualManualCleanupCandidates =
    selectContextualManualCleanupLikelyNonPreviewCandidates(
      contextualManualCleanupInspectionCandidates
    );
  if (contextualManualCleanupCandidates.length === 0) {
    return null;
  }
  const contextualHolderKinds = contextualManualCleanupCandidates.map(
    (candidate) => candidate.holderKind ?? "unknown_local_process"
  );
  const contextualHolderCountSummary = buildLikelyNonPreviewHolderCountSummary(
    contextualHolderKinds,
    contextualManualCleanupCandidates.length
  );
  const holderExamples = formatNamedHolderExamples(args.untrackedCandidateNames);
  return buildStopNoLiveHoldersSignal({
    matchedRuleId: args.matchedRuleId,
    reasoning:
      `Inspection found ${buildLikelyNonPreviewHolderSetDescription(
        contextualHolderKinds,
        contextualManualCleanupCandidates.length
      )} tied to the blocked folders, but that broader local set is outside the confirmation lane and no exact preview holder was proven safely.`,
    question:
      `${args.leadingQuestionClause} ${contextualHolderCountSummary} still look tied to them.${holderExamples} ` +
      `That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. ${args.manualCleanupGuidance}`,
    recoveryInstruction:
      "Recovery instruction: stop and explain that only a broader still-local non-preview holder family was found, and that set is outside the confirmation lane. " +
      `Recommend this next step instead: ${args.manualCleanupGuidance}`,
    untrackedCandidatePids: args.untrackedCandidatePids,
    untrackedCandidateKinds: args.untrackedCandidateKinds,
    untrackedCandidateNames: args.untrackedCandidateNames,
    blockedFolderPaths: args.blockedFolderPaths
  });
}
