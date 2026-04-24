/**
 * @fileoverview Direct execution, browser-control, and autonomous-ownership signals for the
 * conversation front door.
 */

import type { AutonomousExecutionSignalStrength } from "./executionPreferenceTypes";
import {
  directEditTargetsConversation,
  hasAnyToken,
  hasAnyTokenSequence,
  hasLeadRequestForAction,
  startsWithImperativeAction
} from "./executionPreferenceCommon";

const EXECUTION_ACTION_TOKENS = new Set([
  "add",
  "build",
  "change",
  "clean",
  "create",
  "do",
  "edit",
  "execute",
  "fix",
  "gather",
  "implement",
  "move",
  "organize",
  "put",
  "remove",
  "repair",
  "revise",
  "rewrite",
  "run",
  "ship",
  "tidy",
  "update"
]);
const DIRECT_EDIT_ACTION_TOKENS = new Set([
  "add",
  "change",
  "clean",
  "edit",
  "fix",
  "gather",
  "move",
  "organize",
  "put",
  "remove",
  "repair",
  "revise",
  "rewrite",
  "tidy",
  "update"
]);
const BROWSER_CONTROL_SURFACE_TOKENS = new Set([
  "browser",
  "tab",
  "window",
  "preview",
  "url"
]);
const WORKSPACE_ARTIFACT_TOKENS = new Set([
  "desktop",
  "file",
  "folder",
  "folders",
  "hero",
  "headline",
  "section",
  "trust",
  "bar",
  "cta",
  "copy",
  "text",
  "landing",
  "project",
  "projects",
  "page"
]);
const DIRECT_EXECUTION_SEQUENCES: readonly (readonly string[])[] = [
  ["execute", "now"],
  ["build", "now"],
  ["build", "this", "now"],
  ["do", "it", "now"],
  ["fix", "it", "now"],
  ["fix", "this", "now"],
  ["repair", "it", "now"],
  ["repair", "this", "now"],
  ["run", "it", "now"],
  ["ship", "it", "now"],
  ["go", "ahead", "and"]
] as const;
const DIRECT_EXECUTION_NOW_TOKENS = new Set(["now"]);
const BROWSER_CONTROL_LEAD_SEQUENCES: readonly (readonly string[])[] = [
  ["pull", "up"],
  ["turn", "on"],
  ["bring", "up"],
  ["bring", "back"]
] as const;
const STRONG_AUTONOMOUS_SEQUENCES: readonly (readonly string[])[] = [
  ["keep", "going"],
  ["see", "it", "through"],
  ["see", "this", "through"],
  ["see", "that", "through"],
  ["finish", "the", "whole", "thing"],
  ["finish", "everything"],
  ["finish", "it"],
  ["finish", "this"],
  ["finish", "that"]
] as const;
const AMBIGUOUS_AUTONOMOUS_SEQUENCES: readonly (readonly string[])[] = [
  ["end", "to", "end"],
  ["start", "to", "finish"],
  ["all", "the", "way", "through"],
  ["the", "whole", "thing"]
] as const;

export const hasDirectExecutionShape = (tokens: readonly string[]): boolean => {
  if (
    hasAnyTokenSequence(tokens, DIRECT_EXECUTION_SEQUENCES) &&
    (hasAnyToken(tokens, EXECUTION_ACTION_TOKENS) || hasAnyToken(tokens, DIRECT_EXECUTION_NOW_TOKENS))
  ) {
    return true;
  }
  if (
    startsWithImperativeAction(tokens, DIRECT_EDIT_ACTION_TOKENS) &&
    !directEditTargetsConversation(tokens)
  ) {
    return true;
  }
  if (
    hasLeadRequestForAction(tokens, DIRECT_EDIT_ACTION_TOKENS) &&
    hasAnyToken(tokens, WORKSPACE_ARTIFACT_TOKENS)
  ) {
    return true;
  }
  return false;
};

export const hasBrowserControlExecutionShape = (tokens: readonly string[]): boolean => {
  if (
    !hasAnyToken(tokens, BROWSER_CONTROL_SURFACE_TOKENS) &&
    !hasAnyTokenSequence(tokens, [
      ["in", "my", "browser"],
      ["in", "the", "browser"]
    ])
  ) {
    return false;
  }
  if (tokens.some((token) => token === "open" || token === "close" || token === "reopen")) {
    return true;
  }
  if (
    hasAnyTokenSequence(tokens, BROWSER_CONTROL_LEAD_SEQUENCES) ||
    (tokens.includes("show") && hasAnyToken(tokens, BROWSER_CONTROL_SURFACE_TOKENS))
  ) {
    return true;
  }
  return (
    (tokens.includes("bring") || tokens.includes("leave") || tokens.includes("keep")) &&
    tokens.includes("open")
  );
};

export const resolveAutonomousExecutionSignalStrengthFromTokens = (
  tokens: readonly string[]
): AutonomousExecutionSignalStrength => {
  if (
    hasAnyTokenSequence(tokens, STRONG_AUTONOMOUS_SEQUENCES) ||
    (tokens.includes("until") && (tokens.includes("finish") || tokens.includes("done")))
  ) {
    return "strong";
  }
  if (
    hasAnyTokenSequence(tokens, AMBIGUOUS_AUTONOMOUS_SEQUENCES) ||
    ((tokens.includes("take") || tokens.includes("handle")) &&
      (tokens.includes("this") || tokens.includes("it") || tokens.includes("that")) &&
      (hasAnyTokenSequence(tokens, AMBIGUOUS_AUTONOMOUS_SEQUENCES) || tokens.includes("everything")))
  ) {
    return "ambiguous";
  }
  return "none";
};
