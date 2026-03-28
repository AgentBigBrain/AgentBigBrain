/**
 * @fileoverview Deterministic natural-language preference extraction for the conversation front door.
 */

import {
  resolvePresentationPreferences,
  type PresentationPreferences
} from "./presentationPreferenceResolution";

export type AutonomousExecutionSignalStrength = "none" | "ambiguous" | "strong";

export interface ExtractedExecutionPreferences {
  planOnly: boolean;
  executeNow: boolean;
  autonomousExecution: boolean;
  autonomousExecutionStrength: AutonomousExecutionSignalStrength;
  naturalSkillDiscovery: boolean;
  statusOrRecall: boolean;
  reusePriorApproach: boolean;
  presentation: PresentationPreferences;
}

const NATURAL_SKILL_DISCOVERY_LEAD_PATTERNS: readonly RegExp[] = [
  /\bwhat\b/i,
  /\bwhich\b/i,
  /\bshow\b/i,
  /\blist\b/i,
  /\btell me\b/i
] as const;

const NATURAL_SKILL_DISCOVERY_SUBJECT_PATTERNS: readonly RegExp[] = [
  /\bskills?\b/i,
  /\btools?\b/i
] as const;

const NATURAL_SKILL_DISCOVERY_INVENTORY_PATTERNS: readonly RegExp[] = [
  /\bavailable\b/i,
  /\bhave\b/i,
  /\bknow\b/i,
  /\breusable\b/i,
  /\btrust\b/i,
  /\balready\b/i
] as const;

const NATURAL_CAPABILITY_DISCOVERY_DIRECT_PATTERNS: readonly RegExp[] = [
  /\bwhat can you do(?:\s+here|\s+in this setup)?\b/i,
  /\bwhat can you help with\b/i,
  /\bwhat can you help me with\b/i,
  /\bhow can you help(?:\s+me)?\b/i,
  /\bwhat can i ask you to do\b/i,
  /\bwhat are you able to do\b/i,
  /\bwhat do you support\b/i,
  /\bwhich capabilities\b/i,
  /\bwhat capabilities\b/i,
  /\bwhy (?:can't|can not|cannot) you\b/i,
  /\bwhy (?:is|are) (?:that|this) unavailable\b/i
] as const;

const PLAN_ONLY_PATTERNS: readonly RegExp[] = [
  /\b(plan it|plan first|walk me through|outline it|proposal first|just plan)\b/i,
  /\b(explain first|talk me through|guide me first)\b/i,
  /\b(do not execute|don't execute|without executing|guidance only|instructions only)\b/i,
  /\b(do not build|don't build)\b/i
] as const;

const DIRECT_EXECUTION_PATTERNS: readonly RegExp[] = [
  /\b(execute now|build (?:this )?now|do it now|fix (?:it|this) now|repair (?:it|this) now|run it now|ship it now)\b/i,
  /\b(go ahead and|just)\s+(?:build|create|fix|implement|run|execute|ship|do)\b/i,
  /\bplease\s+(?:build|create|fix|implement|run|execute)\s+(?:it|this)\s+now\b/i,
  /^(?:okay,\s*)?(?:please\s+)?(?:change|edit|update|revise|rewrite|add|remove|organize|move|put|gather|clean up|tidy up)\b/i,
  /\bplease\s+(?:change|edit|update|revise|rewrite|add|remove|organize|move|put|gather|clean up|tidy up)\b/i,
  /\b(?:organize|move|put|gather|clean up|tidy up)\b[\s\S]{0,80}\b(?:desktop|folder|folders|project|projects)\b/i
] as const;

const BROWSER_CONTROL_EXECUTION_PATTERNS: readonly RegExp[] = [
  /\b(?:close|reopen|open)\b[\s\S]{0,50}\b(?:browser|tab|window|page|preview)\b/i,
  /\bopen\b[\s\S]{0,120}\bin\s+my\s+browser\b/i,
  /\b(?:pull\s+up|show)\b[\s\S]{0,120}\b(?:landing\s+page|homepage|page|site|app|preview)\b/i,
  /\b(?:turn on|bring up|bring back)\b[\s\S]{0,20}\bbrowser\b/i,
  /\b(?:bring|leave|keep)\b[\s\S]{0,40}\b(?:browser|tab|window|page|preview)\b[\s\S]{0,20}\bopen\b/i,
  /\bleave\b[\s\S]{0,40}\b(?:it|that|the\s+(?:landing\s+page|homepage|page|site|app|preview))\b[\s\S]{0,20}\bup\b/i
] as const;

const STRONG_AUTONOMOUS_EXECUTION_PATTERNS: readonly RegExp[] = [
  /\b(?:go|keep going|work|run)\s+until\s+(?:you\s+finish|it(?:'s| is)\s+done|you(?:'re| are)\s+done)\b/i,
  /\bsee\s+(?:it|this|that)\s+through\b/i,
  /\bfinish\s+(?:the whole thing|everything|it|this|that)\b/i
] as const;

const AMBIGUOUS_AUTONOMOUS_EXECUTION_PATTERNS: readonly RegExp[] = [
  /\b(end to end|start to finish|all the way through)\b/i,
  /\b(?:take|handle)\s+(?:this|it|that)\s+(?:end to end|all the way through)\b/i,
  /\b(?:take care of|handle)\s+(?:the whole thing|everything|it|this|that)\b/i
] as const;

const STATUS_OR_RECALL_PATTERNS: readonly RegExp[] = [
  /\bwhat did you (?:just )?(?:do|make|create|change)\b/i,
  /\btell me about (?:your|the) changes\b/i,
  /\btell me what you changed\b/i,
  /\bso i know what you changed\b/i,
  /\bchange summary\b/i,
  /\bwhat(?:'s| is) ready(?: for (?:me to )?review)?\b/i,
  /\bshow me what(?:'s| is) ready(?: for (?:me to )?review)?\b/i,
  /\bshow me (?:the )?(?:rough |current )?draft\b/i,
  /\bwhat do you have ready(?: for me)?\b/i,
  /\bshow me what you(?:'ve| have) got(?: so far)?\b/i,
  /\bwhat should i look at first\b/i,
  /\bwhat should i review first\b/i,
  /\bwhere should i start\b/i,
  /\bshow me what i should look at first\b/i,
  /\bwhat do you want me to look at first\b/i,
  /\bwhat did you finish while i was (?:away|gone|out)\b/i,
  /\bwhat did you complete while i was (?:away|gone|out)\b/i,
  /\bwhat got finished while i was (?:away|gone|out)\b/i,
  /\bwhat got completed while i was (?:away|gone|out)\b/i,
  /\bwhere did you put (?:it|that|this)\b/i,
  /\bwhere is (?:it|that|the file|the folder)\b/i,
  /\bwhat(?:'s| is) (?:the )?status\b/i,
  /\bwhat(?:'s| is) happening (?:right )?now\b/i,
  /\bwhat are you doing\b/i,
  /\bwhat did you leave open\b/i
] as const;

const REUSE_PRIOR_APPROACH_PATTERNS: readonly RegExp[] = [
  /\bsame as before\b/i,
  /\bsame (?:way|approach) as before\b/i,
  /\bsame as last time\b/i,
  /\buse the same approach\b/i,
  /\buse what worked\b/i,
  /\breuse (?:the )?(?:same )?(?:approach|tool|workflow|skill)\b/i,
  /\bdo it (?:the )?same way\b/i
] as const;

/**
 * Returns `true` when a text looks like an explicit natural-language request for skill inventory.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns `true` when the text looks like an explicit skill/tool inventory request.
 */
export function isNaturalSkillDiscoveryRequest(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (
    NATURAL_CAPABILITY_DISCOVERY_DIRECT_PATTERNS.some((pattern) =>
      pattern.test(normalized)
    )
  ) {
    return true;
  }
  const hasLead = NATURAL_SKILL_DISCOVERY_LEAD_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasSubject = NATURAL_SKILL_DISCOVERY_SUBJECT_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasInventoryCue = NATURAL_SKILL_DISCOVERY_INVENTORY_PATTERNS.some((pattern) => pattern.test(normalized));
  return hasLead && hasSubject && hasInventoryCue;
}

/**
 * Returns `true` when a text explicitly asks the assistant to own the work end to end.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns `true` when the text clearly requests autonomous end-to-end handling.
 */
export function isNaturalAutonomousExecutionRequest(value: string): boolean {
  return resolveAutonomousExecutionSignalStrength(value) !== "none";
}

/**
 * Returns how strongly a text asks the assistant to own the work end to end.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns `strong`, `ambiguous`, or `none` for deterministic higher-level disambiguation.
 */
export function resolveAutonomousExecutionSignalStrength(
  value: string
): AutonomousExecutionSignalStrength {
  const normalized = value.trim();
  if (!normalized) {
    return "none";
  }
  if (
    STRONG_AUTONOMOUS_EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return "strong";
  }
  if (
    AMBIGUOUS_AUTONOMOUS_EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return "ambiguous";
  }
  return "none";
}

/**
 * Extracts deterministic execution preferences from one user utterance.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns Canonical execution-preference flags for higher-level intent resolution.
 */
export function extractExecutionPreferences(value: string): ExtractedExecutionPreferences {
  const normalized = value.trim();
  const autonomousExecutionStrength = resolveAutonomousExecutionSignalStrength(normalized);
  return {
    planOnly: PLAN_ONLY_PATTERNS.some((pattern) => pattern.test(normalized)),
    executeNow:
      DIRECT_EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized)) ||
      BROWSER_CONTROL_EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized)),
    autonomousExecution: autonomousExecutionStrength !== "none",
    autonomousExecutionStrength,
    naturalSkillDiscovery: isNaturalSkillDiscoveryRequest(normalized),
    statusOrRecall: STATUS_OR_RECALL_PATTERNS.some((pattern) => pattern.test(normalized)),
    reusePriorApproach: REUSE_PRIOR_APPROACH_PATTERNS.some((pattern) => pattern.test(normalized)),
    presentation: resolvePresentationPreferences(normalized)
  };
}
