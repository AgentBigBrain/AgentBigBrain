/**
 * @fileoverview Runs model-advisory governor checks while preserving bounded localhost live-run exemptions.
 */

import { GovernorModelOutput } from "../../models/types";
import { getParamString, normalizeConfidence, rejectWithCategory } from "./common";
import {
  DefaultGovernorContext,
  DefaultGovernorId,
  DefaultGovernanceProposal,
  DefaultGovernorVote
} from "./contracts";
import { isLoopbackProofAction, isManagedProcessLiveRunAction } from "./liveRunExemptions";
import { isTrackedArtifactContinuityAction } from "./trackedArtifactExemptions";
import { isExplicitUserOwnedBuildWorkspaceAction } from "./userOwnedBuildExemptions";

/**
 * Reads model advisory rejection needed for this execution step.
 *
 * **Why it exists:**
 * Separates model-advisory rejection read-path handling from the per-governor deterministic policy
 * checks so the council can share one bounded exemption contract.
 *
 * **What it talks to:**
 * - Uses `GovernorModelOutput` (import `GovernorModelOutput`) from `../../models/types`.
 * - Uses default governor contract types within this subsystem.
 * - Uses live-run exemption helpers within this subsystem.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param proposal - Value for proposal.
 * @param context - Message/text content processed by this function.
 * @returns Promise resolving to `DefaultGovernorVote | null`.
 */
export async function getModelAdvisoryRejection(
  governorId: DefaultGovernorId,
  proposal: DefaultGovernanceProposal,
  context: DefaultGovernorContext
): Promise<DefaultGovernorVote | null> {
  if (
    isLoopbackProofAction(proposal) ||
    isManagedProcessLiveRunAction(proposal) ||
    isTrackedArtifactContinuityAction(proposal, context.task.userInput) ||
    isExplicitUserOwnedBuildWorkspaceAction(proposal, context.task.userInput)
  ) {
    return null;
  }

  try {
    const output = await context.modelClient.completeJson<GovernorModelOutput>({
      model: context.model,
      schemaName: "governor_v1",
      temperature: 0,
      systemPrompt:
        "You are a strict policy evaluator. Return JSON with approve:boolean, reason:string, confidence:number.",
      userPrompt: JSON.stringify({
        governorId,
        goal: context.task.goal,
        actionType: proposal.action.type,
        actionDescription: proposal.action.description,
        rationale: proposal.rationale,
        path: getParamString(proposal.action.params, "path") ?? "",
        target: getParamString(proposal.action.params, "target") ?? ""
      })
    });

    if (output.approve === false) {
      return rejectWithCategory(
        governorId,
        `Model advisory block: ${output.reason}`,
        "MODEL_ADVISORY_BLOCK",
        normalizeConfidence(output.confidence)
      );
    }
  } catch {
    // Model outages should not break governance. Deterministic policy remains authoritative.
  }

  return null;
}
