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

export type UserOwnedFolderKind = "desktop" | "documents" | "downloads";

export interface ProposalFilesystemCandidateBuckets {
  scopedPathCandidates: readonly string[];
  executionContextCandidates: readonly string[];
}

/** Resolves a known-folder kind from one normalized filesystem path candidate. */
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

/** Resolves which user-owned known folder kinds the user explicitly requested in this turn. */
export function resolveRequestedFolderKinds(
  taskUserInput: string
): readonly UserOwnedFolderKind[] {
  const requestedKinds = new Set<UserOwnedFolderKind>();
  if (/\b(?:on|to)\s+(?:my|the)\s+desktop\b/i.test(taskUserInput)) {
    requestedKinds.add("desktop");
  }
  if (/\b(?:in|to)\s+(?:my|the)\s+documents\b/i.test(taskUserInput)) {
    requestedKinds.add("documents");
  }
  if (/\b(?:in|to)\s+(?:my|the)\s+downloads\b/i.test(taskUserInput)) {
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

/** Normalizes filesystem-like text for cross-platform comparison. */
export function normalizeFilesystemText(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/** Reads filesystem-like path fragments from one command or free-form request. */
function extractFilesystemCandidatesFromCommand(command: string): readonly string[] {
  const candidates = new Set<string>();
  for (const match of command.matchAll(/([a-z]:\\[^"'`\r\n]+|\/(?:Users|users|home)\/[^"'`\r\n]+)/ig)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.add(candidate);
    }
  }
  return [...candidates];
}

/** Checks whether one normalized path matches the specific user-owned folder kind requested. */
export function isRequestedUserOwnedKnownFolderPath(
  candidate: string,
  requestedKinds: readonly UserOwnedFolderKind[]
): boolean {
  const matchedKind = resolveKnownFolderKindFromPath(candidate);
  return matchedKind !== null && requestedKinds.includes(matchedKind);
}

/** Checks whether one normalized path belongs to any supported user-owned known folder tree. */
export function isAnyUserOwnedKnownFolderPath(candidate: string): boolean {
  return resolveKnownFolderKindFromPath(candidate) !== null;
}

/** Collects proposal filesystem-like candidates across direct path fields and embedded commands. */
export function collectProposalFilesystemCandidates(
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

/** Buckets proposal filesystem-like candidates by scoped target versus ambient execution context. */
export function collectProposalFilesystemCandidateBuckets(
  proposal: DefaultGovernanceProposal
): ProposalFilesystemCandidateBuckets {
  const scopedPathCandidates = new Set<string>();
  const executionContextCandidates = new Set<string>();
  const maybeAdd = (target: Set<string>, value: string | null | undefined): void => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      target.add(trimmed);
    }
  };
  maybeAdd(scopedPathCandidates, getParamString(proposal.action.params, "path"));
  maybeAdd(executionContextCandidates, getParamString(proposal.action.params, "cwd"));
  maybeAdd(executionContextCandidates, getParamString(proposal.action.params, "workdir"));
  const command = getParamString(proposal.action.params, "command");
  if (command) {
    for (const candidate of extractFilesystemCandidatesFromCommand(command)) {
      scopedPathCandidates.add(candidate);
    }
  }
  return {
    scopedPathCandidates: [...scopedPathCandidates],
    executionContextCandidates: [...executionContextCandidates]
  };
}
