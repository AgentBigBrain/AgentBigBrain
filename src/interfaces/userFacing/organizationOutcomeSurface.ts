/**
 * @fileoverview Human-first outcome rendering helpers for local folder-organization work.
 */

import { basenameCrossPlatformPath } from "../../core/crossPlatformPath";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { extractBlockedFolderPaths } from "../../core/autonomy/workspaceRecoveryBlockedPathParsing";
import { TaskRunResult } from "../../core/types";
import { isSimulatedOutput } from "../trustLexicalClassifier";
import { DEFAULT_TRUST_LEXICAL_RULE_CONTEXT } from "./trustSurface";

const LOCAL_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|move|group|gather|sort|clean up|put|collect|tidy)\b/i;
const LOCAL_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|desktop|documents|downloads|workspace|workspaces|project|projects)\b/i;
const LOCAL_ORGANIZATION_DESTINATION_PATTERN =
  /\bfolder\s+called\s+["']?([^"'.,!?`\r\n]+(?:\s+[^"'.,!?`\r\n]+)*)["']?/i;
const LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN = /\b(?:move-item|mv|move)\b/i;
const LOCAL_ORGANIZATION_EXACT_SOURCE_PATTERN =
  /\b(?:move|moving|put|placing)\b[\s\S]{0,48}\bonly\s+(?:the\s+)?(?:folder|directory|project|workspace)\s+(?:named|called)\s+["'`]?([a-z0-9][a-z0-9._ -]{1,120}?)(?=["'`]?(?:\s+(?:in|into|to|under)\b|[.?!,]|$))/i;
const NON_ENTRY_PROOF_TOKEN_PATTERN = /^(?:true|false|null|undefined)$/i;

interface OrganizationMoveOutputEvidence {
  destinationPath: string | null;
  movedEntries: readonly string[];
  remainingEntries: readonly string[];
}

type OrganizationOutputSectionKey =
  | "moved"
  | "destination"
  | "remaining"
  | "failed";

/**
 * Collapses arbitrary user text into a stable single-space form for bounded organization checks.
 *
 * @param value - Raw user text to normalize.
 * @returns Single-space trimmed text.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Renders a small natural-language list without pulling in broader conversation helpers.
 *
 * @param values - Human-facing values to render.
 * @returns Natural-language list text.
 */
function joinNaturalList(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0];
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

/**
 * Returns `true` when the user is asking to reorganize local folders or project workspaces.
 *
 * @param userInput - Raw user wording.
 * @returns `true` when the wording points at local folder organization.
 */
function isLocalOrganizationRequest(userInput: string): boolean {
  const normalized = normalizeWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  return (
    LOCAL_ORGANIZATION_VERB_PATTERN.test(normalized) &&
    LOCAL_ORGANIZATION_TARGET_PATTERN.test(normalized)
  );
}

/**
 * Extracts the human-named destination folder from one organization request.
 *
 * @param userInput - Raw user wording.
 * @returns Requested destination folder label, or `null` when none is named directly.
 */
function extractOrganizationDestinationName(userInput: string): string | null {
  const match = normalizeWhitespace(userInput).match(LOCAL_ORGANIZATION_DESTINATION_PATTERN);
  return match?.[1]?.trim() ?? null;
}

/** Extracts an exact source folder name from bounded `move only the folder named ...` wording. */
function extractExactOrganizationSourceName(userInput: string): string | null {
  const match = normalizeWhitespace(userInput).match(LOCAL_ORGANIZATION_EXACT_SOURCE_PATTERN);
  return match?.[1]?.trim() ?? null;
}

/** Removes proof booleans/placeholders that are not human-facing moved entry names. */
function sanitizeOrganizationMoveOutputEntries(entries: readonly string[]): readonly string[] {
  return entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "<none>")
    .filter((entry) => !NON_ENTRY_PROOF_TOKEN_PATTERN.test(entry));
}

/**
 * Resolves the strongest verified destination path for one successful organization run.
 *
 * @param runResult - Completed task result being summarized.
 * @param destinationName - Human-named destination folder, when present.
 * @returns Verified destination path, or `null` when no bounded path was proven.
 */
function resolveOrganizationDestinationPath(
  runResult: TaskRunResult,
  destinationName: string | null
): string | null {
  const approvedDirectoryChecks = [...runResult.actionResults]
    .reverse()
    .filter(
      (result) => {
        if (!result.approved || result.action.type !== "list_directory") {
          return false;
        }
        const targetPath = result.action.params.path;
        return typeof targetPath === "string" && targetPath.trim().length > 0;
      }
    );
  if (approvedDirectoryChecks.length === 0) {
    return null;
  }
  if (destinationName) {
    const normalizedDestination = destinationName.toLowerCase();
    const exactDestination = approvedDirectoryChecks.find((result) => {
      const targetPath = result.action.params.path;
      return (
        typeof targetPath === "string" &&
        targetPath.trim().toLowerCase().includes(normalizedDestination)
      );
    });
    if (exactDestination) {
      const exactDestinationPath = exactDestination.action.params.path;
      return typeof exactDestinationPath === "string"
        ? exactDestinationPath.trim()
        : null;
    }
    return null;
  }
  const fallbackPath = approvedDirectoryChecks[0]?.action.params.path;
  return typeof fallbackPath === "string" ? fallbackPath.trim() : null;
}

/**
 * Returns the visible destination entries from one verified directory listing.
 *
 * @param output - List-directory output text.
 * @returns Non-empty destination entry lines.
 */
function extractDirectoryListingEntries(output: string | undefined): readonly string[] {
  if (typeof output !== "string") {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Directory contents:\s*$/i.test(line));
}

/**
 * Returns the latest verified destination entries for one organization run.
 *
 * @param runResult - Completed task result being summarized.
 * @param destinationPath - Verified destination path for this run.
 * @returns Destination entries from the newest matching directory listing.
 */
function resolveOrganizationDestinationEntries(
  runResult: TaskRunResult,
  destinationPath: string | null
): readonly string[] {
  if (!destinationPath) {
    return [];
  }
  const matchingListings = [...runResult.actionResults]
    .reverse()
    .filter((result) => {
      if (!result.approved || result.action.type !== "list_directory") {
        return false;
      }
      const targetPath = result.action.params.path;
      return typeof targetPath === "string" && targetPath.trim() === destinationPath;
    });
  const newestListing = matchingListings[0];
  return newestListing ? extractDirectoryListingEntries(newestListing.output) : [];
}

/**
 * Returns the bounded section key for one governed organization-output marker line.
 *
 * @param line - Trimmed output line from one organization shell command.
 * @returns Matching section key, or `null` when the line is plain content.
 */
function classifyOrganizationOutputSectionMarker(
  line: string
): OrganizationOutputSectionKey | null {
  if (/^MOVED_TO_DEST:?$/i.test(line) || /^MOVED_TARGETS:?$/i.test(line) || /^MOVED:?$/i.test(line)) {
    return "moved";
  }
  if (/^DEST_CONTENTS:?$/i.test(line) || /^DEST_CONTENT_MATCHES:?$/i.test(line)) {
    return "destination";
  }
  if (/^REMAINING_AT_DESKTOP:?$/i.test(line) || /^ROOT_REMAINING_MATCHES:?$/i.test(line)) {
    return "remaining";
  }
  if (/^FAILED:?$/i.test(line)) {
    return "failed";
  }
  return null;
}

/**
 * Parses one inline organization-proof assignment such as `MOVED_TO_DEST=a,b`.
 *
 * @param line - Trimmed output line from one organization shell command.
 * @returns Section key plus parsed entries, or `null` when the line is not an inline marker.
 */
function parseInlineOrganizationOutputSectionAssignment(
  line: string
): { section: OrganizationOutputSectionKey; entries: readonly string[] } | null {
  const assignmentMatch = line.match(
    /^(MOVED_TO_DEST|MOVED_TARGETS|MOVED|DEST_CONTENTS|DEST_CONTENT_MATCHES|REMAINING_AT_DESKTOP|ROOT_REMAINING_MATCHES|FAILED)=(.*)$/i
  );
  if (!assignmentMatch) {
    return null;
  }
  const [, rawMarker, rawEntries] = assignmentMatch;
  const section = classifyOrganizationOutputSectionMarker(rawMarker) ?? (() => {
    throw new Error("Unreachable organization output marker assignment.");
  })();
  const entries = rawEntries
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "<none>");
  return {
    section,
    entries: sanitizeOrganizationMoveOutputEntries(entries)
  };
}

/**
 * Extracts governed organization proof sections from shell output that may use one of several
 * bounded marker families.
 *
 * @param output - Raw shell output to inspect.
 * @returns Parsed section entries, or `null` when the output contains no known organization markers.
 */
function parseOrganizationOutputSections(
  output: string
): Record<OrganizationOutputSectionKey, readonly string[]> | null {
  const strippedOutput = output.replace(/^Shell (?:success|failed):\s*/i, "");
  const lines = strippedOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const sections: Record<OrganizationOutputSectionKey, string[]> = {
    moved: [],
    destination: [],
    remaining: [],
    failed: []
  };
  let currentSection: OrganizationOutputSectionKey | null = null;
  let sawMarker = false;

  for (const line of lines) {
    const inlineAssignment = parseInlineOrganizationOutputSectionAssignment(line);
    if (inlineAssignment) {
      sections[inlineAssignment.section].push(...inlineAssignment.entries);
      currentSection = inlineAssignment.section;
      sawMarker = true;
      continue;
    }
    const nextSection = classifyOrganizationOutputSectionMarker(line);
    if (nextSection) {
      currentSection = nextSection;
      sawMarker = true;
      continue;
    }
    if (!currentSection || line === "<none>") {
      continue;
    }
    sections[currentSection].push(...sanitizeOrganizationMoveOutputEntries([line]));
  }

  return sawMarker ? sections : null;
}

/**
 * Extracts bounded move-proof entries from the governed workspace-recovery shell output.
 *
 * @param output - Shell-command output to inspect.
 * @returns Structured moved/remaining entries, or `null` when the output is not one of the
 * governed move-verification formats.
 */
function parseOrganizationMoveOutputEvidence(
  output: string | undefined
): OrganizationMoveOutputEvidence | null {
  if (typeof output !== "string") {
    return null;
  }
  const strippedOutput = output.replace(/^Shell (?:success|failed):\s*/i, "").trim();
  if (strippedOutput.startsWith("{")) {
    try {
      const parsed = JSON.parse(strippedOutput) as {
        destination?: unknown;
        moved?: unknown;
        failed?: unknown;
      };
      const movedEntries = Array.isArray(parsed.moved)
        ? sanitizeOrganizationMoveOutputEntries(
            parsed.moved
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter((entry) => entry.length > 0)
          )
        : [];
      const remainingEntries = Array.isArray(parsed.failed)
        ? sanitizeOrganizationMoveOutputEntries(
            parsed.failed
              .map((entry) => {
                if (typeof entry !== "string") {
                  return "";
                }
                const [name] = entry.split(":");
                return name?.trim() ?? "";
              })
              .filter((entry) => entry.length > 0)
          )
        : [];
      const destinationPath =
        typeof parsed.destination === "string" && parsed.destination.trim().length > 0
          ? parsed.destination.trim()
          : null;
      if (Array.isArray(parsed.moved) || Array.isArray(parsed.failed)) {
        return {
          destinationPath,
          movedEntries,
          remainingEntries
        };
      }
    } catch {
      // Fall through to the bounded marker parser below.
    }
  }
  const parsedSections = parseOrganizationOutputSections(output);
  if (!parsedSections) {
    return null;
  }
  const movedEntries = parsedSections.destination.length > 0
    ? parsedSections.destination
    : parsedSections.moved;
  const remainingEntries = parsedSections.remaining.length > 0
    ? parsedSections.remaining
    : parsedSections.failed;
  return {
    destinationPath: null,
    movedEntries,
    remainingEntries
  };
}

/**
 * Returns the newest bounded shell-output proof for one governed organization move.
 *
 * @param runResult - Completed task result being summarized.
 * @returns Parsed move-proof output, or `null` when no governed move output is available.
 */
function resolveOrganizationMoveOutputEvidence(
  runResult: TaskRunResult
): OrganizationMoveOutputEvidence | null {
  const approvedMoveOutputs = [...runResult.actionResults]
    .reverse()
    .filter(
      (result) =>
        result.approved &&
        result.action.type === "shell_command" &&
        typeof result.action.params.command === "string" &&
        LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN.test(result.action.params.command)
    );
  for (const actionResult of approvedMoveOutputs) {
    const evidence = parseOrganizationMoveOutputEvidence(actionResult.output);
    if (evidence) {
      return evidence;
    }
  }
  return null;
}

/**
 * Returns `true` when the run includes a real folder-move shell command for local organization.
 *
 * @param runResult - Completed task result being summarized.
 * @returns `true` when a real move command executed.
 */
function hasApprovedOrganizationMoveShellAction(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      result.approved &&
      result.action.type === "shell_command" &&
      typeof result.action.params.command === "string" &&
      LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN.test(result.action.params.command) &&
      !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Returns `true` when the destination listing proves at least one folder landed in the target root.
 *
 * @param runResult - Completed task result being summarized.
 * @param destinationPath - Verified destination path for this run.
 * @returns `true` when the destination listing is non-empty.
 */
function hasVerifiedOrganizationDestinationContents(
  runResult: TaskRunResult,
  destinationPath: string | null
): boolean {
  if (!destinationPath) {
    return false;
  }
  return runResult.actionResults.some((result) => {
    if (!result.approved || result.action.type !== "list_directory") {
      return false;
    }
    const targetPath = result.action.params.path;
    if (typeof targetPath !== "string" || targetPath.trim() !== destinationPath) {
      return false;
    }
    return extractDirectoryListingEntries(result.output).length > 0;
  });
}

/**
 * Returns `true` when the run still represents recovered local organization work even if the
 * current user wording was only a short clarification answer.
 *
 * @param runResult - Completed task result being summarized.
 * @returns `true` when the action pattern still proves a local organization recovery run.
 */
function isRecoveredLocalOrganizationRun(runResult: TaskRunResult): boolean {
  return (
    hasApprovedOrganizationMoveShellAction(runResult) &&
    runResult.actionResults.some(
      (result) => result.approved && result.action.type === "stop_process"
    )
  );
}

/**
 * Builds a human-first summary for successful local folder organization work.
 *
 * @param runResult - Completed task result being summarized.
 * @returns Human-facing organization summary, or `null` when the run does not match the pattern.
 */
export function resolveLocalOrganizationOutcomeLine(
  runResult: TaskRunResult
): string | null {
  const activeRequest = extractActiveRequestSegment(runResult.task.userInput);
  if (
    !isLocalOrganizationRequest(activeRequest) &&
    !isRecoveredLocalOrganizationRun(runResult)
  ) {
    return null;
  }

  if (!hasApprovedOrganizationMoveShellAction(runResult)) {
    return null;
  }

  if (extractBlockedFolderPaths(runResult).length > 0) {
    return null;
  }

  const moveOutputEvidence = resolveOrganizationMoveOutputEvidence(runResult);
  const destinationName = extractOrganizationDestinationName(activeRequest);
  const destinationPath =
    resolveOrganizationDestinationPath(
      runResult,
      destinationName
    ) ?? moveOutputEvidence?.destinationPath ?? null;
  const destinationEntries = hasVerifiedOrganizationDestinationContents(runResult, destinationPath)
    ? resolveOrganizationDestinationEntries(runResult, destinationPath)
    : [];
  const exactSourceName = extractExactOrganizationSourceName(activeRequest);
  const movedEntries =
    destinationEntries.length > 0 ? destinationEntries : moveOutputEvidence?.movedEntries ?? [];
  const effectiveMovedEntries =
    movedEntries.length > 0
      ? movedEntries
      : moveOutputEvidence && exactSourceName
        ? [exactSourceName]
        : [];
  if (effectiveMovedEntries.length === 0) {
    return null;
  }
  const stoppedPreviewHolderCount = runResult.actionResults.filter(
    (result) => result.approved && result.action.type === "stop_process"
  ).length;
  const useExplicitMovedEntryPhrase =
    destinationEntries.length === 0 &&
    effectiveMovedEntries.length > 0 &&
    effectiveMovedEntries.length <= 4;
  const entryPhrase = useExplicitMovedEntryPhrase
    ? `${joinNaturalList(effectiveMovedEntries)} into `
    : "the matching folders into ";
  const moveSummary = destinationPath
    ? `I moved ${entryPhrase}${destinationPath}.`
    : destinationName
      ? `I moved ${entryPhrase}${destinationName}.`
      : `I moved ${entryPhrase}the requested folder.`;

  if (stoppedPreviewHolderCount === 0) {
    return moveSummary;
  }

  const holderPhrase =
    stoppedPreviewHolderCount === 1
      ? "1 exact tracked preview holder"
      : `${stoppedPreviewHolderCount} exact tracked preview holders`;
  return `${moveSummary} I shut down ${holderPhrase} first so the move could finish.`;
}

/**
 * Builds a truthful partial-success summary for organization runs that moved some folders but left
 * others outside the destination because a local lock remained.
 *
 * @param runResult - Completed task result being summarized.
 * @returns Human-facing partial-success summary, or `null` when the run lacks enough proof.
 */
export function resolvePartialLocalOrganizationOutcomeLine(
  runResult: TaskRunResult
): string | null {
  const activeRequest = extractActiveRequestSegment(runResult.task.userInput);
  if (
    !isLocalOrganizationRequest(activeRequest) &&
    !isRecoveredLocalOrganizationRun(runResult)
  ) {
    return null;
  }

  if (!hasApprovedOrganizationMoveShellAction(runResult)) {
    return null;
  }

  const blockedFolderPaths = extractBlockedFolderPaths(runResult);
  if (blockedFolderPaths.length === 0) {
    return null;
  }

  const moveOutputEvidence = resolveOrganizationMoveOutputEvidence(runResult);
  const destinationName = extractOrganizationDestinationName(activeRequest);
  const destinationPath =
    resolveOrganizationDestinationPath(
      runResult,
      destinationName
    ) ?? moveOutputEvidence?.destinationPath ?? null;
  const resolvedDestinationEntries = resolveOrganizationDestinationEntries(
    runResult,
    destinationPath
  );
  const destinationEntries = (
    resolvedDestinationEntries.length > 0
      ? resolvedDestinationEntries
      : moveOutputEvidence?.movedEntries ?? []
  ).slice(0, 4);
  const blockedFolderNames = Array.from(
    new Set(
      blockedFolderPaths
        .map((folderPath) => basenameCrossPlatformPath(folderPath.trim()))
        .filter((entry) => entry.length > 0)
    )
  );
  const remainingEntries = (
    moveOutputEvidence?.remainingEntries.length
      ? moveOutputEvidence.remainingEntries
      : blockedFolderNames
  ).slice(0, 4);
  if (destinationEntries.length === 0 || remainingEntries.length === 0) {
    return null;
  }

  const stoppedPreviewHolderCount = runResult.actionResults.filter(
    (result) => result.approved && result.action.type === "stop_process"
  ).length;
  const lines = [
    destinationPath
      ? `The destination now contains ${joinNaturalList(destinationEntries)} in ${destinationPath}.`
      : destinationName
        ? `The destination now contains ${joinNaturalList(destinationEntries)} in ${destinationName}.`
        : `The destination now contains ${joinNaturalList(destinationEntries)}.`
  ];

  lines.push(`These still stayed outside it: ${joinNaturalList(blockedFolderNames)}.`);
  if (
    remainingEntries.length > 0 &&
    joinNaturalList(remainingEntries) !== joinNaturalList(blockedFolderNames.slice(0, 4))
  ) {
    lines[1] = `These still stayed outside it: ${joinNaturalList(remainingEntries)}.`;
  }

  if (stoppedPreviewHolderCount > 0) {
    const holderPhrase =
      stoppedPreviewHolderCount === 1
        ? "1 exact tracked preview holder"
        : `${stoppedPreviewHolderCount} exact tracked preview holders`;
    lines.push(
      `I had already shut down ${holderPhrase} first, but another local process is still using the remaining folders.`
    );
  } else {
    lines.push(
      "Another local process is still using the remaining folders, so I stopped there."
    );
  }

  lines.push(
    "Ask me to inspect the remaining holder and retry the move when you want to continue."
  );
  return lines.join(" ");
}
