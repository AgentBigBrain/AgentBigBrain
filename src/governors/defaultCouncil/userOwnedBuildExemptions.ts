/**
 * @fileoverview Detects explicit user-owned workspace build actions that should bypass advisory drift.
 */

import {
  isDeterministicFrameworkBuildLaneRequest,
  isExecutionStyleBuildRequest,
  isLocalWorkspaceOrganizationRequest
} from "../../organs/plannerPolicy/liveVerificationPolicy";
import { getParamString } from "./common";
import { DefaultGovernanceProposal } from "./contracts";
import {
  collectProposalFilesystemCandidateBuckets,
  collectProposalFilesystemCandidates,
  isAnyUserOwnedKnownFolderPath,
  isRequestedUserOwnedKnownFolderPath,
  normalizeFilesystemText,
  resolveRequestedFolderKinds
} from "./userOwnedBuildExemptionsSupport";
const SHELL_FOLDER_CREATE_PATTERN =
  /\b(?:mkdir|md)\b|\bnew-item\b[\s\S]{0,80}-itemtype\s+directory\b|\bif\s+not\s+exist\b[\s\S]{0,80}\b(?:mkdir|md)\b/i;
const SHELL_BUILD_TOOLCHAIN_PATTERN =
  /\b(?:(?:npm|npx|pnpm|yarn)(?:\.cmd)?)\b[\s\S]{0,120}\b(?:create|init|install|ci|run\s+(?:build|dev|preview|start)|build|dev|preview|start)\b/i;
const SHELL_FRAMEWORK_CLI_PATTERN =
  /\b(?:vite|create-vite|react-scripts|next|nextjs|create-next-app)\b[\s\S]{0,80}\b(?:build|dev|preview|start|create)\b/i;
const SHELL_WORKSPACE_READINESS_PROOF_PATTERN =
  /\b(?:test-path|get-item|resolve-path)\b[\s\S]{0,220}\b(?:package\.json|node_modules|\.next|build_id|dist(?:\\|\/|$)|app(?:\\|\/|$)|src(?:\\|\/)app(?:\\|\/|$))\b/i;
const SHELL_FILE_ORGANIZATION_PATTERN =
  /\b(?:mkdir|md|move-item|rename-item|copy-item|get-childitem|new-item|mv|cp|ls|dir|ren)\b/i;
const FRAMEWORK_TEMP_SCAFFOLD_ROOT_PATTERN = /agentbigbrain-framework-scaffold/i;

/**
 * Evaluates whether one normalized path belongs to the bounded temp scaffold root used by
 * framework-app fallback creation.
 *
 * @param candidate - Normalized filesystem path candidate.
 * @returns `true` when the path belongs to the temp scaffold workspace root.
 */
function isFrameworkTempScaffoldPath(candidate: string): boolean {
  return (
    candidate.includes("/agentbigbrain-framework-scaffold/") ||
    candidate.endsWith("/agentbigbrain-framework-scaffold")
  );
}

/**
 * Evaluates whether a proposal is a bounded user-owned workspace setup/edit action for an explicit
 * execution-style build request.
 *
 * @param proposal - Proposal under governor review.
 * @param taskUserInput - Raw current user request.
 * @returns `true` when the proposal stays within the explicitly requested user-owned workspace.
 */
export function isExplicitUserOwnedBuildWorkspaceAction(
  proposal: DefaultGovernanceProposal,
  taskUserInput: string
): boolean {
  const buildRequest = isExecutionStyleBuildRequest(taskUserInput);
  const frameworkBuildLaneRequest =
    !buildRequest && isDeterministicFrameworkBuildLaneRequest(taskUserInput);
  const organizationRequest = isLocalWorkspaceOrganizationRequest(taskUserInput);
  const buildScopedRequest = buildRequest || frameworkBuildLaneRequest;
  if (!buildScopedRequest && !organizationRequest) {
    return false;
  }

  const requestedKinds = resolveRequestedFolderKinds(taskUserInput);
  if (
    buildScopedRequest &&
    requestedKinds.length === 0 &&
    !collectProposalFilesystemCandidates(proposal)
      .map((candidate) => normalizeFilesystemText(candidate))
      .some((candidate) => isAnyUserOwnedKnownFolderPath(candidate))
  ) {
    return false;
  }

  if (
    proposal.action.type !== "shell_command" &&
    proposal.action.type !== "write_file" &&
    proposal.action.type !== "read_file" &&
    proposal.action.type !== "list_directory"
  ) {
    return false;
  }

  if (proposal.action.type === "shell_command") {
    const command = getParamString(proposal.action.params, "command");
    const candidateBuckets = collectProposalFilesystemCandidateBuckets(proposal);
    const scopedPathCandidates = candidateBuckets.scopedPathCandidates
      .map((candidate) => normalizeFilesystemText(candidate))
      .filter((candidate) => candidate.length > 0);
    const executionContextCandidates = candidateBuckets.executionContextCandidates
      .map((candidate) => normalizeFilesystemText(candidate))
      .filter((candidate) => candidate.length > 0);
    const filesystemCandidates = [...scopedPathCandidates, ...executionContextCandidates];
    const matchesFrameworkScaffoldFinalizePattern =
      buildScopedRequest &&
      Boolean(
        command &&
        FRAMEWORK_TEMP_SCAFFOLD_ROOT_PATTERN.test(command) &&
        SHELL_FILE_ORGANIZATION_PATTERN.test(command) &&
        scopedPathCandidates.some((candidate) => isFrameworkTempScaffoldPath(candidate)) &&
        filesystemCandidates.some((candidate) =>
          isRequestedUserOwnedKnownFolderPath(candidate, requestedKinds)
        )
      );
    const matchesBuildShellPattern =
      buildScopedRequest &&
      Boolean(
        command &&
        (
          SHELL_FOLDER_CREATE_PATTERN.test(command) ||
          SHELL_BUILD_TOOLCHAIN_PATTERN.test(command) ||
          SHELL_FRAMEWORK_CLI_PATTERN.test(command) ||
          SHELL_WORKSPACE_READINESS_PROOF_PATTERN.test(command) ||
          matchesFrameworkScaffoldFinalizePattern
        )
      );
    const matchesOrganizationShellPattern =
      organizationRequest &&
      Boolean(command && SHELL_FILE_ORGANIZATION_PATTERN.test(command));
    if (
      !command ||
      (!matchesBuildShellPattern && !matchesOrganizationShellPattern)
    ) {
      return false;
    }
  }

  const candidateBuckets = collectProposalFilesystemCandidateBuckets(proposal);
  const scopedPathCandidates = candidateBuckets.scopedPathCandidates
    .map((candidate) => normalizeFilesystemText(candidate))
    .filter((candidate) => candidate.length > 0);
  const executionContextCandidates = candidateBuckets.executionContextCandidates
    .map((candidate) => normalizeFilesystemText(candidate))
    .filter((candidate) => candidate.length > 0);
  const filesystemCandidates = [...scopedPathCandidates, ...executionContextCandidates];
  if (filesystemCandidates.length === 0) {
    return false;
  }

  if (organizationRequest) {
    if (scopedPathCandidates.length === 0) {
      return false;
    }
    return scopedPathCandidates.every((candidate) => isAnyUserOwnedKnownFolderPath(candidate));
  }

  if (requestedKinds.length === 0) {
    return filesystemCandidates.some((candidate) => isAnyUserOwnedKnownFolderPath(candidate));
  }

  return filesystemCandidates.some((candidate) =>
    isRequestedUserOwnedKnownFolderPath(candidate, requestedKinds)
  );
}
