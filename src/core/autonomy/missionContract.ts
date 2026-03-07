/**
 * @fileoverview Builds deterministic mission-completion contracts for autonomous execution goals.
 */

import {
  classifyRoutingIntentV1,
  isExecutionSurfaceRoutingClassification
} from "../../interfaces/routingMap";
import type { MissionCompletionContract } from "./contracts";

/**
 * Normalizes text for deterministic case-insensitive mission checks.
 *
 * **Why it exists:**
 * Mission contract detection should not vary across platform casing or whitespace differences.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param input - Source text to normalize.
 * @returns Lower-cased normalized text.
 */
function normalizeEvidenceText(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Normalizes path-like text for deterministic evidence comparisons.
 *
 * **Why it exists:**
 * Mission path hints can come from quoted strings, Windows paths, or slash-variant forms. This
 * helper collapses those shapes into one canonical token set.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Path-like text candidate.
 * @returns Canonical normalized path token.
 */
function normalizePathHint(value: string): string {
  return normalizeEvidenceText(value)
    .replace(/^["'\s(]+/, "")
    .replace(/["'\s),.;:]+$/, "")
    .replace(/\//g, "\\")
    .replace(/\\+/g, "\\");
}

/**
 * Extracts explicit target path hints from a mission goal.
 *
 * **Why it exists:**
 * Deterministic completion should stay anchored to the user-requested path when the goal includes
 * one, instead of letting later subtasks drift to an arbitrary directory.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns Canonical explicit path hints found in the goal.
 */
function extractGoalPathHints(goal: string): string[] {
  const candidates: string[] = [];
  const quotedPathPattern = /["']([^"']*(?:[a-z]:\\|\/)[^"']*)["']/gi;
  const windowsPathPattern = /\b[a-z]:\\[^\s"']+/gi;
  const unixPathPattern = /(?:^|\s)(\/(?:users|home|tmp|var|opt|mnt)[^\s"']*)/gi;

  let match: RegExpExecArray | null = null;
  while ((match = quotedPathPattern.exec(goal)) !== null) {
    candidates.push(match[1]);
  }
  while ((match = windowsPathPattern.exec(goal)) !== null) {
    candidates.push(match[0]);
  }
  while ((match = unixPathPattern.exec(goal)) !== null) {
    candidates.push(match[1]);
  }

  const deduped = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizePathHint(candidate);
    if (normalized.length >= 5) {
      deduped.add(normalized);
    }
  }

  return [...deduped];
}

/**
 * Evaluates whether a mission goal requires artifact-mutation evidence.
 *
 * **Why it exists:**
 * Some execution-style goals are only satisfied when project files or artifacts were actually
 * changed, not merely inspected or scaffolded.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires at least one real mutation action.
 */
function requiresArtifactMutationEvidence(goal: string): boolean {
  const normalized = normalizeEvidenceText(goal);
  const mutationIntentPattern =
    /\b(customi[sz]e|replace|modify|edit|redesign|restyle|theme|style|component|components|layout|ui|interface|chart|charts|portfolio|homepage|page)\b/;
  const artifactSurfacePattern =
    /\b(app|application|project|frontend|backend|website|dashboard|file|files|document|template|content|css|html|jsx|tsx)\b/;
  return mutationIntentPattern.test(normalized) && artifactSurfacePattern.test(normalized);
}

/**
 * Evaluates whether a mission goal requires local readiness-proof evidence.
 *
 * **Why it exists:**
 * Live-run goals are not complete just because files changed; they need proof that the local app
 * or service actually came up.
 *
 * **What it talks to:**
 * - Uses `isExecutionStyleInput` from this module.
 * - Uses local normalization helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires a local readiness probe to pass.
 */
function requiresReadinessEvidence(goal: string): boolean {
  if (!isExecutionStyleInput(goal)) {
    return false;
  }
  const normalized = normalizeEvidenceText(goal);
  return (
    /\bnpm\s+start\b/.test(normalized) ||
    /\bnpm\s+run\s+dev\b/.test(normalized) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/.test(normalized) ||
    /\b(?:next|vite)\s+dev\b/.test(normalized) ||
    /\bdev\s+server\b/.test(normalized) ||
    /\b(localhost|127\.0\.0\.1|::1)\b/.test(normalized) ||
    /\b(run|start|launch|open|serve)\b[\s\S]{0,80}\b(app|site|server|service|project|frontend|backend|api)\b/.test(
      normalized
    ) ||
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering|server|service|endpoint|port)\b/.test(
      normalized
    )
  );
}

/**
 * Evaluates whether a mission goal requires browser/UI proof beyond localhost readiness.
 *
 * **Why it exists:**
 * Browser verification is a different contract than raw readiness. This helper keeps those two
 * requirements separate so completion stays truthful.
 *
 * **What it talks to:**
 * - Uses `requiresReadinessEvidence` from this module.
 * - Uses local normalization helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires successful browser-verification evidence.
 */
function requiresBrowserVerificationEvidence(goal: string): boolean {
  if (!requiresReadinessEvidence(goal)) {
    return false;
  }
  const normalized = normalizeEvidenceText(goal);
  return (
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/.test(
      normalized
    ) ||
    /\b(open|check|inspect|review)\b[\s\S]{0,80}\b(browser|homepage|ui|page|render|rendering)\b/.test(
      normalized
    ) ||
    /\b(screenshot|visual(?:ly)?\s+confirm)\b/.test(normalized)
  );
}

/**
 * Evaluates whether a mission goal requires proof that a managed local process was stopped cleanly.
 *
 * **Why it exists:**
 * Finite live-run goals should not claim success while the spawned process is still running when
 * the user explicitly asked for cleanup or a bounded flow.
 *
 * **What it talks to:**
 * - Uses `requiresReadinessEvidence` from this module.
 * - Uses local normalization helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires stop-proof evidence.
 */
function requiresManagedProcessStopEvidence(goal: string): boolean {
  if (!requiresReadinessEvidence(goal)) {
    return false;
  }
  const normalized = normalizeEvidenceText(goal);
  return (
    /\b(stop|terminate|shut\s+down|cleanup|clean\s+up)\b[\s\S]{0,80}\b(process|server|app|site|service|session)\b/.test(
      normalized
    ) ||
    /\bkeep\b[\s\S]{0,40}\bflow\b[\s\S]{0,40}\bfinite\b/.test(normalized)
  );
}

/**
 * Evaluates execution-style mission intent and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Completion rules need one shared test for whether a mission is asking for real execution rather
 * than guidance-only advice.
 *
 * **What it talks to:**
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../../interfaces/routingMap`.
 * - Uses `isExecutionSurfaceRoutingClassification` (import `isExecutionSurfaceRoutingClassification`) from `../../interfaces/routingMap`.
 * - Uses local normalization helpers within this module.
 *
 * @param input - Goal or subtask request text.
 * @returns `true` when this text indicates side-effect execution intent.
 */
export function isExecutionStyleInput(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (
    /\b(guidance\s+only|instructions?\s+only|without\s+executing|do\s+not\s+execute|don't\s+execute|explain\s+how)\b/.test(
      normalized
    )
  ) {
    return false;
  }

  if (isExecutionSurfaceRoutingClassification(classifyRoutingIntentV1(input))) {
    return true;
  }

  const executionVerb =
    /\b(create|build|scaffold|generate|write|delete|modify|run|execute|install|deploy|open|launch)\b/;
  if (!executionVerb.test(normalized)) {
    return false;
  }

  const sideEffectTarget =
    /\b(app|application|project|dashboard|site|website|frontend|backend|api|file|folder|directory|repo|repository|script|command|powershell|terminal|bash|zsh|cmd)\b/;
  const explicitPath = /([a-z]:\\|\/|\\)/i;
  return sideEffectTarget.test(normalized) || explicitPath.test(normalized);
}

/**
 * Builds a mission completion contract from mission-level goal text.
 *
 * **Why it exists:**
 * Autonomous completion should be gated by deterministic mission requirements, not only by model
 * confidence that the goal sounds complete.
 *
 * **What it talks to:**
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../../interfaces/routingMap`.
 * - Uses `isExecutionSurfaceRoutingClassification` (import `isExecutionSurfaceRoutingClassification`) from `../../interfaces/routingMap`.
 * - Uses `isExecutionStyleInput` from this module.
 * - Uses local mission-contract helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns Deterministic mission completion contract.
 */
export function buildMissionCompletionContract(goal: string): MissionCompletionContract {
  const routingClassification = classifyRoutingIntentV1(goal);
  const executionStyle =
    isExecutionStyleInput(goal) ||
    isExecutionSurfaceRoutingClassification(routingClassification);
  const targetPathHints = extractGoalPathHints(goal);

  return {
    executionStyle,
    requireRealSideEffect: executionStyle,
    requireTargetPathTouch: executionStyle && targetPathHints.length > 0,
    requireArtifactMutation: executionStyle && requiresArtifactMutationEvidence(goal),
    requireReadinessProof: executionStyle && requiresReadinessEvidence(goal),
    requireBrowserProof: executionStyle && requiresBrowserVerificationEvidence(goal),
    requireProcessStopProof: executionStyle && requiresManagedProcessStopEvidence(goal),
    targetPathHints
  };
}
