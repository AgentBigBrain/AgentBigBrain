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
  collectTaskFilesystemContextCandidates,
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
const ORGANIZATION_EXACT_FOLDER_NAME_PATTERN =
  /\b(?:move|moving|put|placing)\b[\s\S]{0,48}\bonly\s+(?:the\s+)?(?:folder|directory|project|workspace)\s+(?:named|called)\s+["'`]?([a-z0-9][a-z0-9._ -]{1,120}?)(?=["'`]?(?:\s+(?:in|into|to|under)\b|[.?!,]|$))/i;
const SIMPLE_DESTINATION_NAME_PATTERN =
  /\b(?:into|inside|under|to)\s+(?:a\s+folder\s+called\s+)?["'`]?([a-z0-9][a-z0-9_-]{0,80})["'`]?(?=\s+(?:on|in|under)\s+my\s+(?:desktop|documents|downloads)\b|[.?!,]|$)/i;
const ORGANIZATION_MOVE_COMMAND_PATTERN = /\b(?:move-item|mv|move)\b/i;

/** Escapes a user-supplied folder name for literal command matching. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extracts exact source and destination names from a bounded organization request. */
function extractExactOrganizationNames(
  taskUserInput: string
): { sourceName: string; destinationName: string } | null {
  const sourceName = taskUserInput.match(ORGANIZATION_EXACT_FOLDER_NAME_PATTERN)?.[1]?.trim();
  const destinationName = taskUserInput.match(SIMPLE_DESTINATION_NAME_PATTERN)?.[1]?.trim();
  if (!sourceName || !destinationName) {
    return null;
  }
  return { sourceName, destinationName };
}

/**
 * Evaluates whether a relative organization command is still bounded by an exact user-owned
 * Desktop/source/destination contract from the execution context.
 */
function isExactRelativeUserOwnedOrganizationAction(
  command: string | null | undefined,
  taskUserInput: string,
  executionContextCandidates: readonly string[]
): boolean {
  if (!command || !ORGANIZATION_MOVE_COMMAND_PATTERN.test(command)) {
    return false;
  }
  const exactNames = extractExactOrganizationNames(taskUserInput);
  if (!exactNames) {
    return false;
  }
  if (
    !executionContextCandidates
      .map((candidate) => normalizeFilesystemText(candidate))
      .some((candidate) => isAnyUserOwnedKnownFolderPath(candidate))
  ) {
    return false;
  }
  return (
    new RegExp(escapeRegExp(exactNames.sourceName), "i").test(command) &&
    new RegExp(escapeRegExp(exactNames.destinationName), "i").test(command)
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
    const matchesBuildShellPattern =
      buildScopedRequest &&
      Boolean(
        command &&
        (
          SHELL_FOLDER_CREATE_PATTERN.test(command) ||
          SHELL_BUILD_TOOLCHAIN_PATTERN.test(command) ||
          SHELL_FRAMEWORK_CLI_PATTERN.test(command) ||
          SHELL_WORKSPACE_READINESS_PROOF_PATTERN.test(command)
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
    .concat(collectTaskFilesystemContextCandidates(taskUserInput))
    .map((candidate) => normalizeFilesystemText(candidate))
    .filter((candidate) => candidate.length > 0);
  const filesystemCandidates = [...scopedPathCandidates, ...executionContextCandidates];
  if (filesystemCandidates.length === 0) {
    return false;
  }

  if (organizationRequest) {
    if (scopedPathCandidates.length === 0) {
      return isExactRelativeUserOwnedOrganizationAction(
        proposal.action.type === "shell_command"
          ? getParamString(proposal.action.params, "command")
          : null,
        taskUserInput,
        executionContextCandidates
      );
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
