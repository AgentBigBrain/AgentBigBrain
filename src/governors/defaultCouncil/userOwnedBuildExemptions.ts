/**
 * @fileoverview Detects explicit user-owned workspace build actions that should bypass advisory drift.
 */

import {
  isExecutionStyleBuildRequest,
  isLocalWorkspaceOrganizationRequest
} from "../../organs/plannerPolicy/liveVerificationPolicy";
import { getParamString } from "./common";
import { DefaultGovernanceProposal } from "./contracts";

const WINDOWS_PUBLIC_FOLDER_PATTERN =
  /^[a-z]:\/users\/public\/(?:desktop|documents|downloads)(?:\/|$)/i;
const WINDOWS_USER_FOLDER_PATTERN =
  /^[a-z]:\/users\/[^/]+\/(?:(?:onedrive(?:[^/]+)?)\/)?(desktop|documents|downloads)(?:\/|$)/i;
const WINDOWS_USER_FOLDER_INLINE_PATTERN =
  /[a-z]:\\users\\[^\\]+\\(?:(?:onedrive(?:[^\\]*)?)\\)?(desktop|documents|downloads)(?:\\|$)/ig;
const WINDOWS_PUBLIC_FOLDER_INLINE_PATTERN =
  /[a-z]:\\users\\public\\(?:desktop|documents|downloads)(?:\\|$)/ig;
const MAC_USER_FOLDER_PATTERN = /^\/users\/[^/]+\/(desktop|documents|downloads)(?:\/|$)/i;
const LINUX_USER_FOLDER_PATTERN = /^\/home\/[^/]+\/(desktop|documents|downloads)(?:\/|$)/i;
const SHELL_FOLDER_CREATE_PATTERN =
  /\b(?:mkdir|md)\b|\bnew-item\b[\s\S]{0,80}-itemtype\s+directory\b|\bif\s+not\s+exist\b[\s\S]{0,80}\b(?:mkdir|md)\b/i;
const SHELL_BUILD_TOOLCHAIN_PATTERN =
  /\b(?:(?:npm|npx|pnpm|yarn)(?:\.cmd)?)\b[\s\S]{0,120}\b(?:create|init|install|ci|run\s+(?:build|dev|preview|start)|build|dev|preview|start)\b/i;
const SHELL_FRAMEWORK_CLI_PATTERN =
  /\b(?:vite|create-vite|react-scripts|next|nextjs|create-next-app)\b[\s\S]{0,80}\b(?:build|dev|preview|start|create)\b/i;
const SHELL_FILE_ORGANIZATION_PATTERN =
  /\b(?:mkdir|md|move-item|rename-item|copy-item|get-childitem|new-item|mv|cp|ls|dir|ren)\b/i;

type UserOwnedFolderKind = "desktop" | "documents" | "downloads";

/**
 * Resolves a known-folder kind from one normalized filesystem path candidate.
 *
 * @param candidate - Normalized filesystem path candidate.
 * @returns Matched known-folder kind, or `null` when the path is not user-owned.
 */
function resolveKnownFolderKindFromPath(candidate: string): UserOwnedFolderKind | null {
  if (!candidate || WINDOWS_PUBLIC_FOLDER_PATTERN.test(candidate)) {
    return null;
  }

  const match =
    candidate.match(WINDOWS_USER_FOLDER_PATTERN) ??
    candidate.match(MAC_USER_FOLDER_PATTERN) ??
    candidate.match(LINUX_USER_FOLDER_PATTERN);
  const matchedKind = match?.[1]?.toLowerCase() as UserOwnedFolderKind | undefined;
  return matchedKind ?? null;
}

/**
 * Resolves which user-owned known folder kinds the user explicitly requested in this turn.
 *
 * @param taskUserInput - Raw current user request.
 * @returns Requested known-folder kinds.
 */
function resolveRequestedFolderKinds(taskUserInput: string): readonly UserOwnedFolderKind[] {
  const requestedKinds = new Set<UserOwnedFolderKind>();
  if (/\bon\s+my\s+desktop\b/i.test(taskUserInput)) {
    requestedKinds.add("desktop");
  }
  if (/\bin\s+my\s+documents\b/i.test(taskUserInput)) {
    requestedKinds.add("documents");
  }
  if (/\bin\s+my\s+downloads\b/i.test(taskUserInput)) {
    requestedKinds.add("downloads");
  }

  for (const match of taskUserInput.matchAll(WINDOWS_USER_FOLDER_INLINE_PATTERN)) {
    const rawMatch = match[0]?.trim() ?? "";
    if (!rawMatch || WINDOWS_PUBLIC_FOLDER_INLINE_PATTERN.test(rawMatch)) {
      continue;
    }
    WINDOWS_PUBLIC_FOLDER_INLINE_PATTERN.lastIndex = 0;
    const matchedKind = match[1]?.toLowerCase() as UserOwnedFolderKind | undefined;
    if (matchedKind) {
      requestedKinds.add(matchedKind);
    }
  }

  for (const candidate of extractFilesystemCandidatesFromCommand(taskUserInput)) {
    const matchedKind = resolveKnownFolderKindFromPath(normalizeFilesystemText(candidate));
    if (matchedKind) {
      requestedKinds.add(matchedKind);
    }
  }

  return [...requestedKinds];
}

/**
 * Normalizes filesystem-like text for cross-platform comparison.
 *
 * @param value - Raw path or command fragment.
 * @returns Normalized lowercase string with forward slashes.
 */
function normalizeFilesystemText(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/**
 * Reads filesystem-like path fragments from a shell command.
 *
 * @param command - Raw shell command text.
 * @returns Distinct filesystem-like path fragments discovered inside the command.
 */
function extractFilesystemCandidatesFromCommand(command: string): readonly string[] {
  const candidates = new Set<string>();
  for (const match of command.matchAll(/([a-z]:\\[^"'`\r\n]+|\/(?:Users|users|home)\/[^"'`\r\n]+)/g)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.add(candidate);
    }
  }
  return [...candidates];
}

/**
 * Evaluates whether one normalized path belongs to a per-user known folder and matches the request.
 *
 * @param candidate - Normalized filesystem path candidate.
 * @param requestedKinds - Folder kinds explicitly requested by the user.
 * @returns `true` when the path belongs to the requested user-owned known folder.
 */
function isRequestedUserOwnedKnownFolderPath(
  candidate: string,
  requestedKinds: readonly UserOwnedFolderKind[]
): boolean {
  const matchedKind = resolveKnownFolderKindFromPath(candidate);
  return matchedKind !== null && requestedKinds.includes(matchedKind);
}

/**
 * Evaluates whether one normalized path belongs to any per-user known folder.
 *
 * @param candidate - Normalized filesystem path candidate.
 * @returns `true` when the path belongs to a user-owned Desktop/Documents/Downloads tree.
 */
function isAnyUserOwnedKnownFolderPath(candidate: string): boolean {
  return resolveKnownFolderKindFromPath(candidate) !== null;
}

/**
 * Collects filesystem-like candidates from proposal params that may identify a user-owned workspace.
 *
 * @param proposal - Proposal under governor review.
 * @returns Distinct raw filesystem-like candidates from supported params.
 */
function collectProposalFilesystemCandidates(
  proposal: DefaultGovernanceProposal
): readonly string[] {
  const candidates = new Set<string>();
  const maybeAdd = (value: string | null | undefined): void => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      candidates.add(trimmed);
    }
  };

  maybeAdd(getParamString(proposal.action.params, "path"));
  maybeAdd(getParamString(proposal.action.params, "cwd"));
  maybeAdd(getParamString(proposal.action.params, "workdir"));

  const command = getParamString(proposal.action.params, "command");
  if (command) {
    for (const candidate of extractFilesystemCandidatesFromCommand(command)) {
      candidates.add(candidate);
    }
  }

  return [...candidates];
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
  const organizationRequest = isLocalWorkspaceOrganizationRequest(taskUserInput);
  if (!buildRequest && !organizationRequest) {
    return false;
  }

  const requestedKinds = resolveRequestedFolderKinds(taskUserInput);
  if (buildRequest && requestedKinds.length === 0) {
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
      buildRequest &&
      Boolean(
        command &&
        (
          SHELL_FOLDER_CREATE_PATTERN.test(command) ||
          SHELL_BUILD_TOOLCHAIN_PATTERN.test(command) ||
          SHELL_FRAMEWORK_CLI_PATTERN.test(command)
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

  const filesystemCandidates = collectProposalFilesystemCandidates(proposal)
    .map((candidate) => normalizeFilesystemText(candidate))
    .filter((candidate) => candidate.length > 0);
  if (filesystemCandidates.length === 0) {
    return false;
  }

  if (organizationRequest) {
    return filesystemCandidates.every((candidate) => isAnyUserOwnedKnownFolderPath(candidate));
  }

  return filesystemCandidates.some((candidate) =>
    isRequestedUserOwnedKnownFolderPath(candidate, requestedKinds)
  );
}
