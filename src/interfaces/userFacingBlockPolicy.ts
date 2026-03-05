/**
 * @fileoverview Shared policy helpers for blocked user-facing responses and safety-code extraction.
 */

import {
  GovernorId,
  GovernorRejectCategory,
  GovernorVote,
  TaskRunResult
} from "../core/types";
import { evaluateVerificationGate } from "../core/stage6_85QualityGatePolicy";
import {
  resolveVerificationCategoryForPrompt,
  shouldEvaluateVerificationGateForDiagnostics
} from "./diagnosticsPromptPolicy";

/**
 * Render options for blocked-message formatting.
 */
export interface BlockMessageRenderOptions {
  showSafetyCodes: boolean;
}

const ABUSE_SIGNAL_REGEXES: RegExp[] = [
  /\bmalware\b/i,
  /\bransomware\b/i,
  /\bspyware\b/i,
  /\bkeylogger\b/i,
  /\b(rootkit|trojan|worm)\b/i,
  /\bphish(?:ing|ed|er)?\b/i,
  /\bexploit(?:ation|ing|ed)?\b/i,
  /\b(botnet|ddos|denial[\s-]?of[\s-]?service)\b/i,
  /\b(data\s+exfil(?:tration|trate)|credential\s+theft)\b/i,
  /\b(steal(?:ing)?\s+(credentials?|passwords?|tokens?)|token\s+theft)\b/i,
  /\b(sql\s*injection|command\s*injection|xss|cross[\s-]?site\s*scripting)\b/i,
  /\b(privilege\s+escalation|backdoor|remote\s+code\s+execution|rce)\b/i,
  /\b(command[\s-]?and[\s-]?control|c2|remote\s+access\s+trojan|rat)\b/i,
  /\b(abusive|harmful|destructive|unsafe)\b/i,
  /\bbypass(?:ing|ed)?\b/i,
  /\b(scam|fraud|extortion|blackmail|doxx?ing|swatting)\b/i
];
const STRUCTURED_ABUSE_REJECT_CATEGORIES: GovernorRejectCategory[] = [
  "ABUSE_MALWARE_OR_FRAUD"
];

/**
 * Collects unique block/violation policy codes from failed actions and adds verification-gate failures.
 *
 * @param runResult - Task execution result to inspect.
 * @returns De-duplicated policy code list for user-facing rendering.
 */
export function extractBlockedPolicyCodes(runResult: TaskRunResult): string[] {
  const codes = new Set<string>();
  for (const result of runResult.actionResults) {
    if (result.approved) {
      continue;
    }
    for (const code of result.blockedBy) {
      if (code.trim()) {
        codes.add(code.trim());
      }
    }
    for (const violation of result.violations) {
      if (violation.code.trim()) {
        codes.add(violation.code.trim());
      }
    }
  }

  if (shouldEvaluateVerificationGateForDiagnostics(runResult)) {
    const verificationGate = evaluateVerificationGate({
      gateId: "verification_gate_runtime_chat",
      category: resolveVerificationCategoryForPrompt(runResult.task.userInput),
      proofRefs: runResult.actionResults
        .filter((result) => result.approved && result.action.type !== "respond")
        .map((result) => `action:${result.action.id}`),
      waiverApproved: false
    });
    if (!verificationGate.passed) {
      codes.add("VERIFICATION_GATE_FAILED");
    }
  }

  return Array.from(codes);
}

/**
 * Resolves the blocked-response message shown when no approved completion output is available.
 *
 * @param runResult - Task execution result containing votes and blocked actions.
 * @param policyCodes - Policy/violation codes collected from blocked actions.
 * @param options - Rendering options for optional safety-code tails.
 * @returns A user-facing blocked message, or `null` if no blocked policy signal exists.
 */
export function resolveBlockedActionMessage(
  runResult: TaskRunResult,
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string | null {
  if (policyCodes.length === 0) {
    return null;
  }

  if (policyCodes.includes("IDENTITY_IMPERSONATION_DENIED")) {
    return buildIdentityBlockedMessage(policyCodes, options);
  }

  if (policyCodes.includes("PERSONAL_DATA_APPROVAL_REQUIRED")) {
    return buildPersonalDataBlockedMessage(policyCodes, options);
  }

  const rejectVotes = extractRejectVotes(runResult);
  if (rejectVotes.length > 0) {
    return buildGovernanceBlockedMessage(rejectVotes, policyCodes, options);
  }

  return buildGenericBlockedMessage(policyCodes, options);
}

/**
 * Normalizes vote-reason text so duplicate detection and rendering are stable.
 *
 * @param value - Raw vote reason text.
 * @returns Reason text with collapsed whitespace and trimmed edges.
 */
function normalizeReasonText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extracts unique reject votes from blocked action results.
 *
 * @param runResult - Task execution result to inspect.
 * @returns Reject votes with normalized reason text.
 */
function extractRejectVotes(runResult: TaskRunResult): GovernorVote[] {
  const deduped = new Set<string>();
  const rejectedVotes: GovernorVote[] = [];

  for (const result of runResult.actionResults) {
    if (result.approved) {
      continue;
    }

    for (const vote of result.votes) {
      if (vote.approve) {
        continue;
      }
      const normalizedReason = normalizeReasonText(vote.reason);
      const key = `${vote.governorId}::${normalizedReason.toLowerCase()}`;
      if (deduped.has(key)) {
        continue;
      }
      deduped.add(key);
      rejectedVotes.push({
        ...vote,
        reason: normalizedReason
      });
    }
  }

  return rejectedVotes;
}

/**
 * Returns unique reject categories represented in rejected votes.
 *
 * @param rejectVotes - Reject votes gathered from blocked actions.
 * @returns De-duplicated reject-category list.
 */
function extractRejectCategories(rejectVotes: GovernorVote[]): GovernorRejectCategory[] {
  return Array.from(
    new Set(
      rejectVotes
        .map((vote) => vote.rejectCategory)
        .filter((category): category is GovernorRejectCategory => category !== undefined)
    )
  );
}

/**
 * Formats a governor ID as user-facing label text.
 *
 * @param governorId - Governor identifier from vote records.
 * @returns Human-readable governor label.
 */
function formatGovernorLabel(governorId: GovernorId): string {
  switch (governorId) {
    case "ethics":
      return "Ethics";
    case "logic":
      return "Logic";
    case "resource":
      return "Resource";
    case "security":
      return "Security";
    case "continuity":
      return "Continuity";
    case "utility":
      return "Utility";
    case "compliance":
      return "Compliance";
    case "codeReview":
      return "Code review";
    default:
      return governorId;
  }
}

/**
 * Formats a list of governor IDs into natural-language list text.
 *
 * @param governorIds - Governor IDs participating in a rejection.
 * @returns Rendered list text (for example "Ethics and Security").
 */
function formatGovernorList(governorIds: GovernorId[]): string {
  const labels = governorIds.map((governorId) => formatGovernorLabel(governorId));
  if (labels.length === 0) {
    return "";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Detects abuse/malware rejection signals from structured categories or lexical vote reasons.
 *
 * @param rejectVotes - Reject votes to inspect.
 * @returns `true` when abuse-oriented governance rejection is present.
 */
function hasMalwareOrAbuseSignal(rejectVotes: GovernorVote[]): boolean {
  const rejectCategories = extractRejectCategories(rejectVotes);
  if (
    rejectCategories.some((category) =>
      STRUCTURED_ABUSE_REJECT_CATEGORIES.includes(category)
    )
  ) {
    return true;
  }

  const reasonText = rejectVotes.map((vote) => vote.reason).join("\n");
  return ABUSE_SIGNAL_REGEXES.some((pattern) => pattern.test(reasonText));
}

/**
 * Builds a short "Main concerns" snippet from the top reject votes.
 *
 * @param rejectVotes - Reject votes to summarize.
 * @returns Optional rationale suffix text.
 */
function buildGovernorRationale(rejectVotes: GovernorVote[]): string {
  if (rejectVotes.length === 0) {
    return "";
  }

  const rationale = rejectVotes
    .slice(0, 2)
    .map((vote) => `${formatGovernorLabel(vote.governorId)}: ${vote.reason}`)
    .join(" | ");
  return rationale ? `\nMain concerns: ${rationale}.` : "";
}

/**
 * Builds the optional technical safety-code suffix.
 *
 * @param policyCodes - Block/violation codes to render.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Empty string when disabled, otherwise a formatted "Safety code(s)" line.
 */
function formatTechnicalCodeTail(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  if (!options.showSafetyCodes || policyCodes.length === 0) {
    return "";
  }
  return `\nSafety code(s): ${policyCodes.join(", ")}.`;
}

/**
 * Builds the user-facing message for identity-impersonation policy blocks.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Identity-policy block explanation text.
 */
function buildIdentityBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I can help with that, but I cannot present myself as a human or pretend to be you or anyone else. " +
    "I keep my identity explicit as an AI agent to prevent abuse and confusion. " +
    "If helpful, I can still answer in third person." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds the user-facing message for personal-data policy blocks.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Personal-data block explanation text.
 */
function buildPersonalDataBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I cannot share personal data about someone without explicit human approval. " +
    "That privacy boundary is intentional for safety and transparency." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds the default blocked-action message when no specialized branch applies.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Generic blocked-response text.
 */
function buildGenericBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I couldn't complete that request because a safety policy blocked it." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds a governance-specific blocked message with reject-vote rationale.
 *
 * @param rejectVotes - Reject votes used for governor and rationale formatting.
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Governance block explanation text.
 */
function buildGovernanceBlockedMessage(
  rejectVotes: GovernorVote[],
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  const governorIds = Array.from(
    new Set(rejectVotes.map((vote) => vote.governorId))
  );
  const governorList = formatGovernorList(governorIds);
  const governanceSentence =
    governorIds.length > 0
      ? `${governorList} governor${governorIds.length > 1 ? "s" : ""} rejected this request.`
      : "Governors rejected this request.";
  const rationale = buildGovernorRationale(rejectVotes);

  if (
    governorIds.includes("security") &&
    governorIds.includes("ethics") &&
    hasMalwareOrAbuseSignal(rejectVotes)
  ) {
    return (
      "No, I can't help with malware or abusive behavior. " +
      `${governanceSentence} My role is to help humans safely, and that trust is on the line if I cross this boundary.` +
      rationale +
      formatTechnicalCodeTail(policyCodes, options)
    );
  }

  return (
    `I can't complete that request. ${governanceSentence} ` +
    "I have to keep my actions safe and aligned with helping humans." +
    rationale +
    formatTechnicalCodeTail(policyCodes, options)
  );
}
