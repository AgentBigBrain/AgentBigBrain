/**
 * @fileoverview Narrow local-organization classification helpers for workspace-recovery policy.
 */

import type { TaskRunResult } from "../types";
import { extractActiveRequestSegment } from "../currentRequestExtraction";

const LOCAL_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|move|group|gather|sort|clean up|put|collect|tidy)\b/i;
const LOCAL_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|desktop|documents|downloads|workspace|workspaces|project|projects)\b/i;
const LOCAL_ORGANIZATION_DESTINATION_PATTERN =
  /\b(?:go|belongs?)\b[\s\S]{0,20}\b(?:in|into|under)\b/i;

/**
 * Collapses arbitrary user text into a stable single-space form for narrow local-organization
 * recovery classification.
 *
 * @param value - Raw user-facing text to normalize.
 * @returns Single-space trimmed text.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Detects whether a request is a local workspace-organization goal relevant to folder-lock recovery.
 *
 * @param userInput - Original task input being evaluated.
 * @returns `true` when the wording points at organizing local project folders or workspaces.
 */
export function isLocalOrganizationRequest(userInput: string): boolean {
  const normalized = normalizeWhitespace(extractActiveRequestSegment(userInput));
  if (!normalized) {
    return false;
  }
  return (
    (
      LOCAL_ORGANIZATION_VERB_PATTERN.test(normalized) ||
      LOCAL_ORGANIZATION_DESTINATION_PATTERN.test(normalized)
    ) &&
    LOCAL_ORGANIZATION_TARGET_PATTERN.test(normalized)
  );
}

/**
 * Returns whether the completed task belongs to the bounded local-organization recovery surface.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns `true` when folder-organization recovery rules should apply.
 */
export function isLocalOrganizationRecoveryContext(taskRunResult: TaskRunResult): boolean {
  const normalizedGoal =
    typeof taskRunResult.task.goal === "string" ? taskRunResult.task.goal.trim() : "";
  if (normalizedGoal.length > 0) {
    return (
      isLocalOrganizationRequest(normalizedGoal) ||
      /\bworkspace-recovery\b/i.test(normalizedGoal)
    );
  }
  return (
    isLocalOrganizationRequest(taskRunResult.task.userInput) ||
    isLocalOrganizationRequest(taskRunResult.task.goal) ||
    /\bworkspace-recovery\b/i.test(taskRunResult.task.userInput)
  );
}
