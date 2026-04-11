/**
 * @fileoverview Builds deterministic mission-completion contracts for autonomous execution goals.
 */

import {
  classifyRoutingIntentV1,
  isExecutionSurfaceRoutingClassification
} from "../../interfaces/routingMap";
import type { MissionCompletionContract } from "./contracts";

const NEGATED_LIVE_RUN_PATTERN =
  /\bdo\s+not\s+(?:start|run|launch|serve)\b[\s\S]{0,80}\b(?:localhost|127\.0\.0\.1|::1|loopback|server|service|api|backend|dev\s+server|preview\s+server|preview\/dev\s+server|preview)\b|\bdo\s+not\s+(?:probe|check|confirm|verify)\b[\s\S]{0,80}\b(?:localhost|127\.0\.0\.1|::1|loopback|http|port|ready|readiness)\b/i;
const NEGATED_BROWSER_OPEN_PATTERN =
  /\bdo\s+not\s+open\b[\s\S]{0,60}\b(?:browser|tab|window|page|site|preview|it)\b/i;
const NATURAL_BROWSER_OPEN_PATTERN =
  /\bopen\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bin\s+my\s+browser\b/i;
const NATURAL_BROWSER_LEAVE_UP_PATTERN =
  /\bleave\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bup\b[\s\S]{0,24}\b(?:for me to|so i can)\s+(?:see|view|look)\b/i;
const DIRECT_BROWSER_OPEN_PATTERN =
  /\bopen\b[\s\S]{0,40}\b(?:browser|tab|window|page|site|preview)\b/i;
const KEEP_BROWSER_OPEN_PATTERN =
  /\b(?:leave|keep)\b[\s\S]{0,40}\b(?:browser|page|site|window|preview|it)\b[\s\S]{0,24}\bopen\b/i;
const RUN_AND_LEAVE_OPEN_PATTERN =
  /\b(?:run|start|launch|serve)\b[\s\S]{0,120}\b(?:browser|page|site|preview|it)\b[\s\S]{0,40}\bopen\b/i;

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
 * Detects explicit user intent to leave a live preview open in a browser.
 *
 * @param normalizedGoal - Normalized mission goal text.
 * @returns `true` when the user explicitly wants a browser window left open for review.
 */
function hasBrowserOpenIntent(normalizedGoal: string): boolean {
  return (
    DIRECT_BROWSER_OPEN_PATTERN.test(normalizedGoal) ||
    KEEP_BROWSER_OPEN_PATTERN.test(normalizedGoal) ||
    NATURAL_BROWSER_OPEN_PATTERN.test(normalizedGoal) ||
    NATURAL_BROWSER_LEAVE_UP_PATTERN.test(normalizedGoal) ||
    RUN_AND_LEAVE_OPEN_PATTERN.test(normalizedGoal) ||
    /\blet me (?:see|view)\b/.test(normalizedGoal) ||
    /\bso i can (?:see|view|review)\b/.test(normalizedGoal)
  );
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
  const normalized = normalizeEvidenceText(value).replace(/\//g, "\\");
  let start = 0;
  let end = normalized.length;
  while (start < end && ["\"", "'", " ", "("].includes(normalized[start]!)) {
    start += 1;
  }
  while (end > start && ["\"", "'", " ", ")", ",", ".", ";", ":"].includes(normalized[end - 1]!)) {
    end -= 1;
  }
  let collapsed = "";
  for (let index = start; index < end; index += 1) {
    const currentChar = normalized[index]!;
    if (currentChar === "\\" && collapsed.endsWith("\\")) {
      continue;
    }
    collapsed += currentChar;
  }
  return collapsed;
}

/**
 * Returns whether one token is a Windows-style absolute path.
 *
 * @param value - Path-like token candidate.
 * @returns `true` when the token is an absolute Windows path.
 */
function looksLikeWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:\\/i.test(value);
}

/**
 * Returns whether one token is a Unix-style absolute path in the allowed user/runtime roots.
 *
 * @param value - Path-like token candidate.
 * @returns `true` when the token is an allowed Unix absolute path.
 */
function looksLikeUnixAbsolutePath(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.startsWith("/users/") ||
    normalized.startsWith("/home/") ||
    normalized.startsWith("/tmp/") ||
    normalized.startsWith("/var/") ||
    normalized.startsWith("/opt/") ||
    normalized.startsWith("/mnt/")
  );
}

/**
 * Extracts quoted path-like tokens from one mission goal.
 *
 * @param goal - Mission goal text.
 * @returns Raw quoted path candidates.
 */
function extractQuotedPathCandidates(goal: string): string[] {
  const candidates: string[] = [];
  let activeQuote: "\"" | "'" | null = null;
  let current = "";
  for (const currentChar of goal) {
    if (activeQuote === null && (currentChar === "\"" || currentChar === "'")) {
      activeQuote = currentChar;
      current = "";
      continue;
    }
    if (activeQuote !== null && currentChar === activeQuote) {
      if (looksLikeWindowsAbsolutePath(current) || looksLikeUnixAbsolutePath(current)) {
        candidates.push(current);
      }
      activeQuote = null;
      current = "";
      continue;
    }
    if (activeQuote !== null) {
      current += currentChar;
    }
  }
  return candidates;
}

/**
 * Extracts whitespace-delimited path-like tokens from one mission goal.
 *
 * @param goal - Mission goal text.
 * @returns Raw unquoted path candidates.
 */
function extractTokenPathCandidates(goal: string): string[] {
  return goal
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => looksLikeWindowsAbsolutePath(token) || looksLikeUnixAbsolutePath(token));
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
  const candidates = [
    ...extractQuotedPathCandidates(goal),
    ...extractTokenPathCandidates(goal)
  ];
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
  const workspaceBootstrapPreparationPattern =
    /\b(?:scaffold|bootstrap|install\s+dependencies|node_modules|package\.json|ready\s+for\s+edits|workspace\s+is\s+ready)\b/;
  const directContentMutationPattern =
    /\b(customi[sz]e|replace|modify|edit|redesign|restyle|theme|style|component|components|layout|ui|interface|chart|charts|portfolio|homepage|hero|section|footer|navigation|copy|headline)\b/;
  if (
    workspaceBootstrapPreparationPattern.test(normalized) &&
    !directContentMutationPattern.test(normalized)
  ) {
    return false;
  }
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
  if (NEGATED_LIVE_RUN_PATTERN.test(normalized)) {
    return false;
  }
  return (
    /\bnpm\s+start\b/.test(normalized) ||
    /\bnpm\s+run\s+dev\b/.test(normalized) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/.test(normalized) ||
    /\b(?:next|vite)\s+dev\b/.test(normalized) ||
    /\bdev\s+server\b/.test(normalized) ||
    /\b(localhost|127\.0\.0\.1|::1)\b/.test(normalized) ||
    /\b(run|start|launch|serve)\b[\s\S]{0,80}\b(server|service|backend|api|dev\s+server)\b/.test(
      normalized
    ) ||
    (
      /\b(run|start|launch|serve)\b/.test(normalized) &&
      hasBrowserOpenIntent(normalized)
    ) ||
    /\b(?:probe|check|confirm|wait\s+until)\b[\s\S]{0,80}\b(?:localhost|http|port|ready|readiness)\b/.test(
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
    /\bverify\b[\s\S]{0,80}\b(playwright|page|screenshot)\b/.test(normalized) ||
    /\b(check|inspect|review)\b[\s\S]{0,80}\b(browser|homepage|ui|page|render|rendering)\b/.test(
      normalized
    ) ||
    /\b(playwright|browser)\b[\s\S]{0,80}\b(verify|verification|proof|check|inspect)\b/.test(
      normalized
    ) ||
    /\b(screenshot|visual(?:ly)?\s+confirm)\b/.test(normalized)
  );
}

/**
 * Evaluates whether a mission goal requires proof that the live page was opened in a visible
 * browser window and left available for review.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires browser-open evidence.
 */
function requiresBrowserOpenEvidence(goal: string): boolean {
  if (!requiresReadinessEvidence(goal)) {
    return false;
  }
  const normalized = normalizeEvidenceText(goal);
  if (NEGATED_BROWSER_OPEN_PATTERN.test(normalized)) {
    return false;
  }
  return hasBrowserOpenIntent(normalized);
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
    requireBrowserOpenProof: executionStyle && requiresBrowserOpenEvidence(goal),
    requireProcessStopProof: executionStyle && requiresManagedProcessStopEvidence(goal),
    targetPathHints
  };
}
