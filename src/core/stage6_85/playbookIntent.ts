/**
 * @fileoverview Canonical Stage 6.85 playbook-intent helpers for extracting the current request and deterministic intent tags.
 */

export interface RequestedPlaybookIntent {
  requestedTags: readonly string[];
  requiredInputSchema: string;
}

const CURRENT_USER_REQUEST_MARKER = "Current user request:";
const STRUCTURED_PROMPT_SCAFFOLD_HINTS = [
  "recent conversation context",
  "assistant:",
  "user:",
  "current user request:"
] as const;

/**
 * Normalizes raw prompt text before deterministic playbook-intent matching.
 *
 * @param userInput - Raw planner input.
 * @returns Lowercased trimmed input for intent matching.
 */
function normalizeInputForPlaybookMatching(userInput: string): string {
  return userInput.trim().toLowerCase();
}

/**
 * Returns the first non-empty line from a structured prompt scaffold.
 *
 * @param value - Structured prompt text.
 * @returns First non-empty line or an empty string when none exists.
 */
function extractFirstNonEmptyLine(value: string): string {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "";
}

/**
 * Checks whether input appears to contain the surrounding planner scaffold.
 *
 * @param value - Structured prompt text.
 * @returns `true` when the scaffold markers are present.
 */
function containsStructuredPromptScaffold(value: string): boolean {
  const normalized = value.toLowerCase();
  return STRUCTURED_PROMPT_SCAFFOLD_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Extracts the current-user request segment that should drive playbook intent matching.
 *
 * @param userInput - Raw planner input, possibly with multi-turn prompt scaffolding.
 * @returns Normalized current-request text used for deterministic intent derivation.
 */
export function extractCurrentRequestForPlaybookIntent(userInput: string): string {
  const normalized = userInput.trim();
  if (!normalized) {
    return "";
  }

  const markerIndex = normalized
    .toLowerCase()
    .lastIndexOf(CURRENT_USER_REQUEST_MARKER.toLowerCase());
  if (markerIndex < 0) {
    if (containsStructuredPromptScaffold(normalized)) {
      const firstLine = extractFirstNonEmptyLine(normalized);
      return firstLine || normalized;
    }
    return normalized;
  }

  const extracted = normalized.slice(markerIndex + CURRENT_USER_REQUEST_MARKER.length).trim();
  return extracted || normalized;
}

/**
 * Detects build-oriented intent keywords in normalized request text.
 *
 * @param normalizedInput - Lowercased normalized request text.
 * @returns `true` when build-oriented intent is present.
 */
function isBuildIntent(normalizedInput: string): boolean {
  return /\b(build|scaffold|typescript\s+cli|runbook|tests?)\b/.test(normalizedInput);
}

/**
 * Detects research-oriented intent keywords in normalized request text.
 *
 * @param normalizedInput - Lowercased normalized request text.
 * @returns `true` when research-oriented intent is present.
 */
function isResearchIntent(normalizedInput: string): boolean {
  return (
    /\b(research|findings|proof\s+refs?|sources?)\b/.test(normalizedInput) ||
    /\bsandboxing\s+controls?\b/.test(normalizedInput)
  );
}

/**
 * Detects workflow-oriented intent keywords in normalized request text.
 *
 * @param normalizedInput - Lowercased normalized request text.
 * @returns `true` when workflow-oriented intent is present.
 */
function isWorkflowIntent(normalizedInput: string): boolean {
  return /\b(workflow|replay|selector\s+drift|browser\s+workflow|capture)\b/.test(normalizedInput);
}

/**
 * Derives deterministic Stage 6.85 playbook intent tags and required schema from user input.
 *
 * @param userInput - Raw planner input used for playbook selection gates.
 * @returns Requested playbook intent tags plus required input-schema gate.
 */
export function deriveRequestedPlaybookIntent(userInput: string): RequestedPlaybookIntent {
  const currentRequest = extractCurrentRequestForPlaybookIntent(userInput);
  const normalizedInput = normalizeInputForPlaybookMatching(currentRequest);
  const requestedTags = new Set<string>();
  const buildIntent = isBuildIntent(normalizedInput);
  const researchIntent = isResearchIntent(normalizedInput);
  const workflowIntent = isWorkflowIntent(normalizedInput);

  if (buildIntent) {
    requestedTags.add("build");
    requestedTags.add("cli");
    requestedTags.add("verify");
  }
  if (researchIntent) {
    requestedTags.add("research");
    requestedTags.add("security");
  }
  if (workflowIntent) {
    requestedTags.add("workflow");
    requestedTags.add("replay");
    requestedTags.add("computer_use");
  }

  let requiredInputSchema = "unknown_input_schema";
  if (buildIntent && !researchIntent && !workflowIntent) {
    requiredInputSchema = "build_cli_v1";
  } else if (researchIntent && !buildIntent && !workflowIntent) {
    requiredInputSchema = "research_v1";
  } else if (workflowIntent && !buildIntent && !researchIntent) {
    requiredInputSchema = "workflow_replay_v1";
  } else if (buildIntent || researchIntent || workflowIntent) {
    requiredInputSchema = "multi_intent_v1";
  }

  return {
    requestedTags: [...requestedTags].sort((left, right) => left.localeCompare(right)),
    requiredInputSchema
  };
}
