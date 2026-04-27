/**
 * @fileoverview Builds route metadata overrides from deterministic front-door safety signals.
 */

import { parseExplicitExecutionConstraints } from "../../core/explicitExecutionConstraints";
import type {
  ConversationRuntimeControlIntent,
  ConversationSemanticRouteMetadataOverrides
} from "./intentModeContracts";

const EXACT_RUNTIME_CONTROL_COMMAND_PATTERN =
  /^\s*(open_browser|close_browser|verify_browser|inspect_workspace_resources|stop_process)\b/i;
const NATURAL_CLOSE_BROWSER_CONTROL_PATTERN =
  /\b(?:close|shut|dismiss|hide)\b[\s\S]{0,80}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_OPEN_BROWSER_CONTROL_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up)\b[\s\S]{0,80}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_VERIFY_BROWSER_CONTROL_PATTERN =
  /\b(?:verify|check|inspect|review)\b[\s\S]{0,80}\b(?:browser|homepage|ui|page|render|rendering)\b|\b(?:screenshot|visual(?:ly)?\s+confirm)\b/i;
const NATURAL_STOP_RUNTIME_CONTROL_PATTERN =
  /\b(?:stop|shut\s+down|turn\s+off|kill)\b[\s\S]{0,80}\b(?:server|servers|preview(?:\s+stack|\s+server)?|process(?:es)?|localhost|loopback|port|dev\s+server)\b/i;
const NATURAL_INSPECT_RUNTIME_CONTROL_PATTERN =
  /\b(?:inspect|check|verify|confirm|make sure|find out|see if|look at)\b[\s\S]{0,80}\b(?:still\s+running|running|server|servers|preview(?:\s+stack|\s+server)?|process(?:es)?|localhost|loopback|port|dev\s+server)\b/i;
const USER_OWNED_LOCATION_PATTERN =
  /\b(?:my|the)\s+(?:desktop|documents|downloads)\b/i;

/**
 * Resolves exact runtime-control metadata from machine-facing commands.
 *
 * **Why it exists:**
 * Runtime control intent should flow as typed metadata for planner policy, while broad natural
 * browser wording remains subject to model interpretation or active runtime ownership checks.
 *
 * **What it talks to:**
 * - Uses local exact command pattern constants within this module.
 *
 * @param userInput - Current normalized user request.
 * @returns Runtime-control intent for exact commands, or `none`.
 */
function resolveExactRuntimeControlIntent(
  userInput: string
): ConversationRuntimeControlIntent {
  const match = EXACT_RUNTIME_CONTROL_COMMAND_PATTERN.exec(userInput);
  const command = match?.[1]?.toLowerCase() ?? "";
  switch (command) {
    case "open_browser":
      return "open_browser";
    case "close_browser":
      return "close_browser";
    case "verify_browser":
      return "verify_browser";
    case "inspect_workspace_resources":
      return "inspect_runtime";
    case "stop_process":
      return "stop_runtime";
    default:
      return "none";
  }
}

/**
 * Resolves bounded natural runtime-control metadata during the migration.
 *
 * This centralizes compatibility wording in the front-door route contract so planner policy no
 * longer owns separate browser/process side-effect meaning.
 *
 * @param userInput - Current normalized user request.
 * @returns Runtime-control intent for clear natural runtime-control requests, or `none`.
 */
function resolveCompatibilityRuntimeControlIntent(
  userInput: string
): ConversationRuntimeControlIntent {
  if (NATURAL_CLOSE_BROWSER_CONTROL_PATTERN.test(userInput)) {
    return "close_browser";
  }
  if (NATURAL_OPEN_BROWSER_CONTROL_PATTERN.test(userInput)) {
    return "open_browser";
  }
  if (NATURAL_VERIFY_BROWSER_CONTROL_PATTERN.test(userInput)) {
    return "verify_browser";
  }
  if (NATURAL_STOP_RUNTIME_CONTROL_PATTERN.test(userInput)) {
    return "stop_runtime";
  }
  if (NATURAL_INSPECT_RUNTIME_CONTROL_PATTERN.test(userInput)) {
    return "inspect_runtime";
  }
  return "none";
}

/**
 * Builds route metadata overrides from deterministic constraints that are allowed to stay lexical.
 *
 * **Why it exists:**
 * Explicit user constraints like not opening a browser or not starting a server are safety
 * restrictions, not semantic permission. Carrying them with the route prevents downstream helpers
 * from re-parsing them independently.
 *
 * **What it talks to:**
 * - Uses `parseExplicitExecutionConstraints` from `../../core/explicitExecutionConstraints`.
 *
 * @param userInput - Current normalized user request.
 * @returns Route metadata overrides for safety constraints and exact runtime commands.
 */
export function buildRouteMetadataOverridesFromInput(
  userInput: string
): ConversationSemanticRouteMetadataOverrides {
  const constraints = parseExplicitExecutionConstraints(userInput);
  const exactRuntimeControlIntent = resolveExactRuntimeControlIntent(userInput);
  return {
    runtimeControlIntent:
      exactRuntimeControlIntent !== "none"
        ? exactRuntimeControlIntent
        : resolveCompatibilityRuntimeControlIntent(userInput),
    explicitConstraints: {
      disallowBrowserOpen: constraints.disallowVisibleBrowserOpen,
      disallowServerStart: constraints.disallowPreviewStart,
      requiresUserOwnedLocation: USER_OWNED_LOCATION_PATTERN.test(userInput)
    }
  };
}
