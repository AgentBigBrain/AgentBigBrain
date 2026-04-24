/**
 * @fileoverview Capability, plan, status, and reuse signal extraction for deterministic execution
 * preference handling.
 */

import {
  hasAnyToken,
  hasAnyTokenSequence,
  hasNegatedAction
} from "./executionPreferenceCommon";
import { hasTokenSequence } from "./chatTurnSignalShapes";

const CAPABILITY_DISCOVERY_LEAD_TOKENS = new Set([
  "what",
  "which",
  "show",
  "list",
  "tell"
]);
const CAPABILITY_DISCOVERY_SUBJECT_TOKENS = new Set(["skill", "skills", "tool", "tools"]);
const CAPABILITY_DISCOVERY_INVENTORY_TOKENS = new Set([
  "available",
  "have",
  "know",
  "reusable",
  "trust",
  "already"
]);
const REUSE_TOKENS = new Set([
  "approach",
  "before",
  "last",
  "reuse",
  "same",
  "use",
  "way",
  "worked",
  "workflow",
  "tool"
]);

const DIRECT_CAPABILITY_DISCOVERY_SEQUENCES: readonly (readonly string[])[] = [
  ["what", "can", "you", "do"],
  ["what", "can", "you", "help", "with"],
  ["what", "can", "you", "help", "me", "with"],
  ["how", "can", "you", "help"],
  ["how", "can", "you", "help", "me"],
  ["what", "can", "i", "ask", "you", "to", "do"],
  ["what", "are", "you", "able", "to", "do"],
  ["what", "do", "you", "support"],
  ["which", "capabilities"],
  ["what", "capabilities"],
  ["why", "can't", "you"],
  ["why", "cannot", "you"],
  ["why", "can", "not", "you"]
] as const;
const PLAN_ONLY_SEQUENCES: readonly (readonly string[])[] = [
  ["plan", "it"],
  ["plan", "first"],
  ["walk", "me", "through"],
  ["outline", "it"],
  ["proposal", "first"],
  ["just", "plan"],
  ["explain", "first"],
  ["talk", "me", "through"],
  ["guide", "me", "first"],
  ["without", "executing"],
  ["guidance", "only"],
  ["instructions", "only"]
] as const;
const CHANGE_SUMMARY_SEQUENCES: readonly (readonly string[])[] = [
  ["what", "did", "you", "do"],
  ["what", "did", "you", "just", "do"],
  ["what", "did", "you", "make"],
  ["what", "did", "you", "create"],
  ["what", "did", "you", "change"],
  ["tell", "me", "about", "your", "changes"],
  ["tell", "me", "about", "the", "changes"],
  ["tell", "me", "what", "you", "changed"],
  ["so", "i", "know", "what", "you", "changed"],
  ["change", "summary"]
] as const;
const REVIEW_READY_SEQUENCES: readonly (readonly string[])[] = [
  ["what", "is", "ready"],
  ["what's", "ready"],
  ["show", "me", "what", "is", "ready"],
  ["show", "me", "what's", "ready"],
  ["show", "me", "the", "draft"],
  ["show", "me", "rough", "draft"],
  ["show", "me", "current", "draft"],
  ["what", "do", "you", "have", "ready"],
  ["show", "me", "what", "you've", "got"],
  ["show", "me", "what", "you", "have", "got"],
  ["what", "should", "i", "look", "at", "first"],
  ["what", "should", "i", "review", "first"],
  ["where", "should", "i", "start"],
  ["show", "me", "what", "i", "should", "look", "at", "first"],
  ["what", "do", "you", "want", "me", "to", "look", "at", "first"]
] as const;
const WHILE_AWAY_RECALL_SEQUENCES: readonly (readonly string[])[] = [
  ["what", "did", "you", "finish", "while", "i", "was", "away"],
  ["what", "did", "you", "finish", "while", "i", "was", "gone"],
  ["what", "did", "you", "finish", "while", "i", "was", "out"],
  ["what", "did", "you", "complete", "while", "i", "was", "away"],
  ["what", "did", "you", "complete", "while", "i", "was", "gone"],
  ["what", "did", "you", "complete", "while", "i", "was", "out"],
  ["what", "got", "finished", "while", "i", "was", "away"],
  ["what", "got", "finished", "while", "i", "was", "gone"],
  ["what", "got", "finished", "while", "i", "was", "out"],
  ["what", "got", "completed", "while", "i", "was", "away"],
  ["what", "got", "completed", "while", "i", "was", "gone"],
  ["what", "got", "completed", "while", "i", "was", "out"]
] as const;
const LOCATION_RECALL_SEQUENCES: readonly (readonly string[])[] = [
  ["where", "did", "you", "put", "it"],
  ["where", "did", "you", "put", "that"],
  ["where", "did", "you", "put", "this"],
  ["where", "is", "it"],
  ["where", "is", "that"],
  ["where", "is", "the", "file"],
  ["where", "is", "the", "folder"]
] as const;
const STATUS_RECALL_SEQUENCES: readonly (readonly string[])[] = [
  ["what", "is", "the", "status"],
  ["what's", "the", "status"],
  ["what", "is", "status"],
  ["what's", "status"],
  ["what", "is", "happening", "right", "now"],
  ["what's", "happening", "right", "now"],
  ["what", "are", "you", "doing"],
  ["what", "did", "you", "leave", "open"]
] as const;
const REUSE_SEQUENCES: readonly (readonly string[])[] = [
  ["same", "as", "before"],
  ["same", "way", "as", "before"],
  ["same", "approach", "as", "before"],
  ["same", "as", "last", "time"],
  ["use", "the", "same", "approach"],
  ["use", "what", "worked"],
  ["reuse", "the", "same", "approach"],
  ["reuse", "the", "same", "tool"],
  ["reuse", "the", "same", "workflow"],
  ["do", "it", "the", "same", "way"],
  ["do", "it", "same", "way"]
] as const;

/**
 * Evaluates whether natural capability discovery shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasTokenSequence` (import `hasTokenSequence`) from `./chatTurnSignalShapes`.
 * - Uses `hasAnyToken` (import `hasAnyToken`) from `./executionPreferenceCommon`.
 * - Uses `hasAnyTokenSequence` (import `hasAnyTokenSequence`) from `./executionPreferenceCommon`.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasNaturalCapabilityDiscoveryShape(tokens: readonly string[]): boolean {
  if (hasAnyTokenSequence(tokens, DIRECT_CAPABILITY_DISCOVERY_SEQUENCES)) {
    return true;
  }
  const hasLead = hasAnyToken(tokens, CAPABILITY_DISCOVERY_LEAD_TOKENS);
  const hasSubject = hasAnyToken(tokens, CAPABILITY_DISCOVERY_SUBJECT_TOKENS);
  const hasInventoryCue = hasAnyToken(tokens, CAPABILITY_DISCOVERY_INVENTORY_TOKENS);
  if (hasLead && hasSubject && hasInventoryCue) {
    return true;
  }
  return (
    tokens.includes("why") &&
    hasAnyToken(tokens, CAPABILITY_DISCOVERY_INVENTORY_TOKENS) &&
    (tokens.includes("can't")
      || hasTokenSequence(tokens, ["can", "not"])
      || tokens.includes("cannot"))
  );
}

/**
 * Evaluates whether plan only shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasAnyTokenSequence` (import `hasAnyTokenSequence`) from `./executionPreferenceCommon`.
 * - Uses `hasNegatedAction` (import `hasNegatedAction`) from `./executionPreferenceCommon`.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasPlanOnlyShape(tokens: readonly string[]): boolean {
  return (
    hasAnyTokenSequence(tokens, PLAN_ONLY_SEQUENCES)
    || hasNegatedAction(tokens, "execute")
    || hasNegatedAction(tokens, "build")
  );
}

/**
 * Evaluates whether status or recall shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasAnyTokenSequence` (import `hasAnyTokenSequence`) from `./executionPreferenceCommon`.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasStatusOrRecallShape(tokens: readonly string[]): boolean {
  if (
    hasAnyTokenSequence(tokens, CHANGE_SUMMARY_SEQUENCES)
    || hasAnyTokenSequence(tokens, REVIEW_READY_SEQUENCES)
    || hasAnyTokenSequence(tokens, WHILE_AWAY_RECALL_SEQUENCES)
    || hasAnyTokenSequence(tokens, LOCATION_RECALL_SEQUENCES)
    || hasAnyTokenSequence(tokens, STATUS_RECALL_SEQUENCES)
  ) {
    return true;
  }
  return tokens.includes("status") && (tokens.includes("what") || tokens.includes("what's"));
}

/**
 * Evaluates whether reuse prior approach shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasAnyToken` (import `hasAnyToken`) from `./executionPreferenceCommon`.
 * - Uses `hasAnyTokenSequence` (import `hasAnyTokenSequence`) from `./executionPreferenceCommon`.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasReusePriorApproachShape(tokens: readonly string[]): boolean {
  return (
    hasAnyTokenSequence(tokens, REUSE_SEQUENCES)
    || (hasAnyToken(tokens, REUSE_TOKENS) && tokens.includes("same"))
  );
}
