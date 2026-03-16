/**
 * @fileoverview Shared human-facing narration helpers for workspace-recovery explanations.
 */

/**
 * Converts stored untracked-holder kinds into one short human-facing description.
 *
 * @param holderKinds - Parsed holder-kind labels from runtime inspection metadata.
 * @returns Short phrase suitable for recovery explanations.
 */
export function describeUntrackedHolderKinds(holderKinds: readonly string[]): string {
  if (holderKinds.includes("sync_client")) {
    return "local sync";
  }
  if (holderKinds.includes("editor_workspace")) {
    return "editor or IDE";
  }
  if (holderKinds.includes("shell_workspace")) {
    return "shell or file-window";
  }
  if (holderKinds.length > 0) {
    return "non-preview local";
  }
  return "local";
}

/**
 * Normalizes recovered process names into short user-facing labels.
 *
 * @param holderNames - Candidate process names recovered from inspection metadata.
 * @returns Stable display labels without empty values or repeated entries.
 */
function normalizeHolderDisplayNames(holderNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalizedNames: string[] = [];
  for (const holderName of holderNames) {
    const normalized = holderName.trim().replace(/\.exe$/i, "");
    if (!normalized) {
      continue;
    }
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalizedNames.push(normalized);
  }
  return normalizedNames;
}

/**
 * Renders one short natural-language list of holder display names.
 *
 * @param holderNames - Candidate process names recovered from inspection metadata.
 * @returns Human-facing list text, or an empty string when no names were available.
 */
function formatHolderDisplayNameList(holderNames: readonly string[]): string {
  const displayNames = normalizeHolderDisplayNames(holderNames);
  if (displayNames.length === 0) {
    return "";
  }
  if (displayNames.length === 1) {
    return displayNames[0];
  }
  if (displayNames.length === 2) {
    return `${displayNames[0]} and ${displayNames[1]}`;
  }
  return `${displayNames.slice(0, -1).join(", ")}, and ${displayNames[displayNames.length - 1]}`;
}

/**
 * Renders one exact holder label suitable for confirmation prompts and recovery instructions.
 *
 * @param holderName - Candidate process name recovered from runtime inspection metadata.
 * @param pid - Exact pid tied to the candidate holder.
 * @returns Short user-facing exact-holder label.
 */
export function formatExactHolderLabel(holderName: string | null, pid: number): string {
  const normalizedName = formatHolderDisplayNameList(holderName ? [holderName] : []);
  if (normalizedName) {
    return `${normalizedName} (pid ${pid})`;
  }
  return `pid ${pid}`;
}

/**
 * Renders a short human-facing example clause for named untracked holders.
 *
 * @param holderNames - Candidate process names recovered from inspection metadata.
 * @returns Example clause, or an empty string when no names were available.
 */
export function formatNamedHolderExamples(holderNames: readonly string[]): string {
  const examples = normalizeHolderDisplayNames(holderNames).slice(0, 3);
  if (examples.length === 0) {
    return "";
  }
  return ` Examples: ${examples.join(", ")}.`;
}

/**
 * Wraps a holder-kind description in a natural indefinite noun phrase.
 *
 * @param holderKindDescription - Human-facing holder-kind description.
 * @returns Indefinite noun phrase such as `an editor or IDE process`.
 */
export function formatIndefiniteHolderProcessPhrase(
  holderKindDescription: string
): string {
  const article = /^[aeiou]/i.test(holderKindDescription) ? "an" : "a";
  return `${article} ${holderKindDescription} process`;
}

/**
 * Builds the most useful next-step suggestion when a non-preview local holder still owns a folder.
 *
 * @param holderKinds - Parsed holder-kind labels from runtime inspection metadata.
 * @param holderNames - Candidate process names recovered from inspection metadata.
 * @returns Human-facing next-step sentence fragment.
 */
export function buildManualHolderReleaseGuidance(
  holderKinds: readonly string[],
  holderNames: readonly string[]
): string {
  const includesSync = holderKinds.includes("sync_client");
  const includesNonSync = holderKinds.some((holderKind) => holderKind !== "sync_client");
  const namedHolders = formatHolderDisplayNameList(holderNames);
  if (includesSync && includesNonSync) {
    if (namedHolders) {
      return `Close or pause ${namedHolders} if they are still tied to that project, then ask me to retry the move.`;
    }
    return "Close or pause the local tools still using that folder, then ask me to retry the move.";
  }
  if (holderKinds.includes("sync_client")) {
    if (namedHolders) {
      return `Pause or let ${namedHolders} finish with that folder, then ask me to retry the move.`;
    }
    return "Pause or let the local sync tool finish with that folder, then ask me to retry the move.";
  }
  if (holderKinds.includes("editor_workspace")) {
    if (namedHolders) {
      return `Close ${namedHolders} if that project is still open there, then ask me to retry the move.`;
    }
    return "Close the editor or IDE still using that folder, then ask me to retry the move.";
  }
  if (holderKinds.includes("shell_workspace")) {
    if (namedHolders) {
      return `Close the terminal or file window still pointed at that folder, then ask me to retry the move. Examples: ${namedHolders}.`;
    }
    return "Close the terminal or file window still pointed at that folder, then ask me to retry the move.";
  }
  if (namedHolders) {
    return `Close ${namedHolders} or otherwise free that folder, then ask me to retry the move.`;
  }
  return "Close the local process still using that folder, then ask me to retry the move.";
}

/**
 * Builds a short holder-set description for confirmation-gated non-preview shutdown prompts.
 *
 * @param holderKinds - Parsed holder-kind labels from runtime inspection metadata.
 * @param holderCount - Number of inspected holders in the bounded candidate set.
 * @returns Human-facing holder-set description.
 */
export function buildLikelyNonPreviewHolderSetDescription(
  holderKinds: readonly string[],
  holderCount: number
): string {
  const normalizedKinds = new Set(holderKinds);
  const lead = holderCount > 4 ? "a broader inspected " : "a small inspected ";
  const includesEditor = normalizedKinds.has("editor_workspace");
  const includesShell = normalizedKinds.has("shell_workspace");
  const includesSync = normalizedKinds.has("sync_client");
  const includesNearbyLocalProcess = normalizedKinds.has("unknown_local_process");
  if (includesSync && !includesEditor && !includesShell) {
    return `${lead}local sync holder set`;
  }
  if (includesNearbyLocalProcess && !includesSync && !includesEditor && !includesShell) {
    return `${lead}nearby local process holder set`;
  }
  if (includesNearbyLocalProcess && includesSync) {
    return `${lead}local holder set across editor, shell, sync, or nearby local processes`;
  }
  if (includesNearbyLocalProcess && (includesEditor || includesShell)) {
    return `${lead}local holder set across editor, shell, or nearby local processes`;
  }
  if (!includesSync && (includesEditor || includesShell)) {
    if (holderCount <= 4) {
      return "a small set of likely local editor or shell holders";
    }
    return `${lead}local editor or shell holder set`;
  }
  if (includesSync || includesEditor || includesShell) {
    return `${lead}local holder set across editor, shell, or sync processes`;
  }
  return `${lead}local non-preview holder set`;
}

/**
 * Builds a count-based holder summary for inspection output when a likely non-preview clarification
 * lane still applies.
 *
 * @param holderKinds - Parsed holder-kind labels from runtime inspection metadata.
 * @param holderCount - Number of inspected holders in the bounded candidate set.
 * @returns Human-facing holder-count summary.
 */
export function buildLikelyNonPreviewHolderCountSummary(
  holderKinds: readonly string[],
  holderCount: number
): string {
  const normalizedKinds = new Set(holderKinds);
  const plural = holderCount === 1 ? "" : "s";
  const includesEditor = normalizedKinds.has("editor_workspace");
  const includesShell = normalizedKinds.has("shell_workspace");
  const includesSync = normalizedKinds.has("sync_client");
  const includesNearbyLocalProcess = normalizedKinds.has("unknown_local_process");
  if (includesSync && !includesEditor && !includesShell) {
    return `${holderCount} likely local sync holder${plural}`;
  }
  if (includesNearbyLocalProcess && !includesSync && !includesEditor && !includesShell) {
    return `${holderCount} likely nearby local process holder${plural}`;
  }
  if (includesNearbyLocalProcess && includesSync) {
    return `${holderCount} likely local non-preview holder${plural} across editor, shell, sync, or nearby local processes`;
  }
  if (includesNearbyLocalProcess && (includesEditor || includesShell)) {
    return `${holderCount} likely local non-preview holder${plural} across editor, shell, or nearby local processes`;
  }
  if (!includesSync && (includesEditor || includesShell)) {
    return `${holderCount} likely local editor or shell holder${plural}`;
  }
  if (includesSync || includesEditor || includesShell) {
    return `${holderCount} likely local non-preview holder${plural} across editor, shell, or sync processes`;
  }
  return `${holderCount} likely local non-preview holder${plural}`;
}

/**
 * Formats blocked folder paths into stable bullet lines for marker-bearing retry prompts.
 *
 * @param blockedFolderPaths - Exact blocked folder paths parsed from task output.
 * @returns Prompt-ready lines, or an empty array when none were found.
 */
export function formatBlockedFolderPaths(blockedFolderPaths: readonly string[]): string[] {
  if (blockedFolderPaths.length === 0) {
    return [];
  }
  return ["Blocked folder paths:", ...blockedFolderPaths.map((entry) => `- ${entry}`)];
}
