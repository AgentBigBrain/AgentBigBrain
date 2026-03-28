/**
 * @fileoverview Canonical extraction for user-facing presentation preferences such as leaving work visible.
 */

export interface PresentationPreferences {
  keepVisible: boolean;
  leaveOpen: boolean;
  runLocally: boolean;
}

const KEEP_VISIBLE_PATTERNS: readonly RegExp[] = [
  /\b(show (?:it|me)|keep (?:it|the browser|the page) (?:open|up|visible)|leave (?:it|the browser|the page) open)\b/i,
  /\bleave (?:it|that|the (?:landing page|homepage|page|site|app|preview)) up\b/i,
  /\b(let me (?:see|view) it (?:later|when i get home|afterward))\b/i
] as const;

const LEAVE_OPEN_PATTERNS: readonly RegExp[] = [
  /\bleave (?:it|the browser|the page) open\b/i,
  /\bleave (?:it|that|the (?:landing page|homepage|page|site|app|preview)) up\b/i,
  /\bdo not close (?:it|the browser|the page)\b/i,
  /\bkeep (?:it|that|the app|the page) running\b/i
] as const;

const RUN_LOCALLY_PATTERNS: readonly RegExp[] = [
  /\brun (?:it|this|that) locally\b/i,
  /\bstart (?:it|this|that) on my machine\b/i,
  /\bopen (?:it|this|that) on my computer\b/i
] as const;

/**
 * Extracts bounded user-facing presentation preferences from one utterance.
 *
 * @param value - Raw user text before queue routing.
 * @returns Canonical presentation preference flags.
 */
export function resolvePresentationPreferences(value: string): PresentationPreferences {
  const normalized = value.trim();
  return {
    keepVisible: KEEP_VISIBLE_PATTERNS.some((pattern) => pattern.test(normalized)),
    leaveOpen: LEAVE_OPEN_PATTERNS.some((pattern) => pattern.test(normalized)),
    runLocally: RUN_LOCALLY_PATTERNS.some((pattern) => pattern.test(normalized))
  };
}
