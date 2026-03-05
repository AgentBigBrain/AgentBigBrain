/**
 * @fileoverview Deterministic follow-up and proposal-reply classifiers with bounded override loading and auditable rule metadata.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { sha256HexFromCanonicalJson } from "../core/normalizers/canonicalizationRules";

export type FollowUpCategory = "ACK" | "APPROVE" | "DENY" | "UNCLEAR";
export type FollowUpConfidenceTier = "HIGH" | "MED" | "LOW";
export type ProposalReplyIntent = "APPROVE" | "CANCEL" | "ADJUST" | "QUESTION";

export interface FollowUpClassification {
  isShortFollowUp: boolean;
  category: FollowUpCategory;
  confidenceTier: FollowUpConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
}

export interface ProposalReplyClassification extends FollowUpClassification {
  intent: ProposalReplyIntent;
  adjustmentText: string | null;
}

export interface FollowUpOverrideAliasMapV1 {
  ack?: readonly string[];
  approve?: readonly string[];
  deny?: readonly string[];
  adjustLead?: readonly string[];
}

export interface FollowUpOverrideV1 {
  schemaVersion: 1;
  localeTag?: string;
  aliases?: FollowUpOverrideAliasMapV1;
}

interface NormalizedFollowUpOverrideV1 {
  schemaVersion: 1;
  localeTag: string;
  aliases: {
    ack: readonly string[];
    approve: readonly string[];
    deny: readonly string[];
    adjustLead: readonly string[];
  };
}

interface LoadedFollowUpOverrideV1 {
  sourcePath: string;
  fingerprint: string;
  override: NormalizedFollowUpOverrideV1;
}

export interface FollowUpRuleContext {
  rulepackVersion: string;
  maxShortTokenCount: number;
  ackTokens: ReadonlySet<string>;
  approveTokens: ReadonlySet<string>;
  denyTokens: ReadonlySet<string>;
  adjustLeadTokens: ReadonlySet<string>;
  ackAliasPhrases: ReadonlySet<string>;
  approveAliasPhrases: ReadonlySet<string>;
  denyAliasPhrases: ReadonlySet<string>;
  adjustLeadAliasPhrases: ReadonlySet<string>;
  overrideFingerprint: string | null;
  overrideSourcePath: string | null;
}

export interface FollowUpClassificationOptions {
  hasPriorAssistantQuestion: boolean;
  ruleContext: FollowUpRuleContext;
}

export interface ProposalReplyClassificationOptions {
  hasActiveProposal: boolean;
  ruleContext: FollowUpRuleContext;
}

/**
 * Frozen deterministic baseline rulepack.
 * Locale posture: deterministic, locale-neutral baseline (English-first initially).
 */
export const FollowUpRulepackV1 = Object.freeze({
  version: "FollowUpRulepackV1",
  maxShortTokenCount: 3,
  ackTokens: [
    "ack",
    "confirmed",
    "correct",
    "fine",
    "k",
    "ok",
    "okay",
    "sure",
    "yes",
    "yep"
  ],
  approveTokens: [
    "approve",
    "approved",
    "apply",
    "continue",
    "do",
    "execute",
    "go",
    "proceed",
    "run",
    "send"
  ],
  denyTokens: [
    "cancel",
    "deny",
    "dont",
    "halt",
    "no",
    "reject",
    "stop"
  ],
  adjustLeadTokens: [
    "adjust",
    "amend",
    "change",
    "edit",
    "modify",
    "revise",
    "update"
  ]
} as const);

const FOLLOW_UP_OVERRIDE_MAX_ALIASES_PER_GROUP = 32;
const FOLLOW_UP_OVERRIDE_MAX_ALIAS_LENGTH = 48;
const FOLLOW_UP_OVERRIDE_MAX_TOTAL_ALIASES = 96;
const FOLLOW_UP_OVERRIDE_MAX_TOKENS_PER_ALIAS = 3;
const FOLLOW_UP_OVERRIDE_MAX_LOCALE_TAG_LENGTH = 32;

/**
 * Normalizes whitespace into a stable shape for `followUpClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes classifier text into a stable shape for `followUpClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for classifier text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeClassifierText(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase();
  return normalizeWhitespace(normalized.replace(/[\u2019`]/g, "'"));
}

/**
 * Normalizes token into a stable shape for `followUpClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for token so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeToken(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Tokenizes for rules for deterministic lexical analysis.
 *
 * **Why it exists:**
 * Maintains one token/segment boundary policy for for rules so lexical decisions stay stable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function tokenizeForRules(value: string): string[] {
  const normalized = normalizeClassifierText(value).replace(/[^\p{L}\p{N}'\s]+/gu, " ");
  if (!normalized) {
    return [];
  }

  const tokens = normalized
    .split(" ")
    .map((token) => normalizeToken(token.replace(/'/g, "")))
    .filter((token) => token.length > 0);
  return tokens;
}

/**
 * Converts values into sorted unique tokens form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for sorted unique tokens deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Ordered collection produced by this step.
 */
function toSortedUniqueTokens(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeToken(value)).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

/**
 * Persists from tokens with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes from tokens mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Computed `ReadonlySet<string>` result.
 */
function setFromTokens(values: readonly string[]): ReadonlySet<string> {
  return new Set(toSortedUniqueTokens(values));
}

/**
 * Builds default follow up rule context for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default follow up rule context consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `FollowUpRuleContext` result.
 */
function buildDefaultFollowUpRuleContext(): FollowUpRuleContext {
  return {
    rulepackVersion: FollowUpRulepackV1.version,
    maxShortTokenCount: FollowUpRulepackV1.maxShortTokenCount,
    ackTokens: setFromTokens(FollowUpRulepackV1.ackTokens),
    approveTokens: setFromTokens(FollowUpRulepackV1.approveTokens),
    denyTokens: setFromTokens(FollowUpRulepackV1.denyTokens),
    adjustLeadTokens: setFromTokens(FollowUpRulepackV1.adjustLeadTokens),
    ackAliasPhrases: new Set<string>(),
    approveAliasPhrases: new Set<string>(),
    denyAliasPhrases: new Set<string>(),
    adjustLeadAliasPhrases: new Set<string>(),
    overrideFingerprint: null,
    overrideSourcePath: null
  };
}

/**
 * Normalizes ordering and duplication for token sets.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for token sets in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param base - Value for base.
 * @param additions - Value for additions.
 * @returns Computed `ReadonlySet<string>` result.
 */
function mergeTokenSets(base: ReadonlySet<string>, additions: readonly string[]): ReadonlySet<string> {
  const merged = new Set(base);
  for (const token of additions) {
    merged.add(token);
  }
  return merged;
}

/**
 * Counts total aliases for downstream policy and scoring decisions.
 *
 * **Why it exists:**
 * Keeps `count total aliases` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param override - Stable identifier used to reference an entity or record.
 * @returns Computed numeric value.
 */
function countTotalAliases(override: NormalizedFollowUpOverrideV1): number {
  return (
    override.aliases.ack.length +
    override.aliases.approve.length +
    override.aliases.deny.length +
    override.aliases.adjustLead.length
  );
}

/**
 * Parses alias group and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for alias group so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param groupName - Value for group name.
 * @returns Ordered collection produced by this step.
 */
function parseAliasGroup(
  value: unknown,
  groupName: keyof FollowUpOverrideAliasMapV1
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Follow-up override alias group '${groupName}' must be an array.`);
  }
  if (value.length > FOLLOW_UP_OVERRIDE_MAX_ALIASES_PER_GROUP) {
    throw new Error(
      `Follow-up override alias group '${groupName}' exceeds ${FOLLOW_UP_OVERRIDE_MAX_ALIASES_PER_GROUP} entries.`
    );
  }

  const aliases: string[] = [];
  for (const rawAlias of value) {
    if (typeof rawAlias !== "string") {
      throw new Error(`Follow-up override alias group '${groupName}' contains a non-string alias.`);
    }
    const normalizedAlias = normalizeClassifierText(rawAlias);
    if (!normalizedAlias) {
      throw new Error(`Follow-up override alias group '${groupName}' contains an empty alias.`);
    }
    if (normalizedAlias.length > FOLLOW_UP_OVERRIDE_MAX_ALIAS_LENGTH) {
      throw new Error(
        `Follow-up override alias '${normalizedAlias}' exceeds ${FOLLOW_UP_OVERRIDE_MAX_ALIAS_LENGTH} chars.`
      );
    }
    if (tokenizeForRules(normalizedAlias).length > FOLLOW_UP_OVERRIDE_MAX_TOKENS_PER_ALIAS) {
      throw new Error(
        `Follow-up override alias '${normalizedAlias}' exceeds ${FOLLOW_UP_OVERRIDE_MAX_TOKENS_PER_ALIAS} tokens.`
      );
    }
    aliases.push(normalizedAlias);
  }

  return [...new Set(aliases)].sort((left, right) => left.localeCompare(right));
}

/**
 * Parses follow up override v1 and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for follow up override v1 so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Computed `NormalizedFollowUpOverrideV1` result.
 */
function parseFollowUpOverrideV1(raw: unknown): NormalizedFollowUpOverrideV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Follow-up override file must contain an object.");
  }

  const record = raw as Partial<FollowUpOverrideV1>;
  if (record.schemaVersion !== 1) {
    throw new Error("Follow-up override schemaVersion must be 1.");
  }

  const localeTag = normalizeClassifierText(String(record.localeTag ?? "en"));
  if (!localeTag) {
    throw new Error("Follow-up override localeTag must be non-empty.");
  }
  if (localeTag.length > FOLLOW_UP_OVERRIDE_MAX_LOCALE_TAG_LENGTH) {
    throw new Error(
      `Follow-up override localeTag exceeds ${FOLLOW_UP_OVERRIDE_MAX_LOCALE_TAG_LENGTH} chars.`
    );
  }

  const aliasRecord =
    record.aliases && typeof record.aliases === "object" && !Array.isArray(record.aliases)
      ? (record.aliases as FollowUpOverrideAliasMapV1)
      : {};

  const normalized: NormalizedFollowUpOverrideV1 = {
    schemaVersion: 1,
    localeTag,
    aliases: {
      ack: parseAliasGroup(aliasRecord.ack, "ack"),
      approve: parseAliasGroup(aliasRecord.approve, "approve"),
      deny: parseAliasGroup(aliasRecord.deny, "deny"),
      adjustLead: parseAliasGroup(aliasRecord.adjustLead, "adjustLead")
    }
  };

  if (countTotalAliases(normalized) > FOLLOW_UP_OVERRIDE_MAX_TOTAL_ALIASES) {
    throw new Error(
      `Follow-up override exceeds ${FOLLOW_UP_OVERRIDE_MAX_TOTAL_ALIASES} total aliases.`
    );
  }

  return normalized;
}

/**
 * Reads follow up override from path needed for this execution step.
 *
 * **Why it exists:**
 * Separates follow up override from path read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `../core/normalizers/canonicalizationRules`.
 * - Uses `readFileSync` (import `readFileSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param overridePath - Stable identifier used to reference an entity or record.
 * @param logInfo - Value for log info.
 * @param logWarn - Value for log warn.
 * @returns Computed `LoadedFollowUpOverrideV1 | null` result.
 */
function loadFollowUpOverrideFromPath(
  overridePath: string,
  logInfo: (message: string) => void,
  logWarn: (message: string) => void
): LoadedFollowUpOverrideV1 | null {
  const resolvedPath = path.resolve(process.cwd(), overridePath);
  try {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalizedOverride = parseFollowUpOverrideV1(parsed);
    const fingerprint = sha256HexFromCanonicalJson(normalizedOverride);
    logInfo(
      `[ConversationManager] Loaded FollowUpOverrideV1 from '${resolvedPath}' ` +
      `(fingerprint=${fingerprint}, aliases=${countTotalAliases(normalizedOverride)}).`
    );

    return {
      sourcePath: resolvedPath,
      fingerprint,
      override: normalizedOverride
    };
  } catch (error) {
    const message = (error as Error).message;
    logWarn(
      `[ConversationManager] FollowUpOverrideV1 load failed for '${resolvedPath}'. ` +
      `Falling back to baseline rulepack. Reason: ${message}`
    );
    return null;
  }
}

/**
 * Builds follow up rule context for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of follow up rule context consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param overridePath - Stable identifier used to reference an entity or record.
 * @param logInfo - Value for log info.
 * @param logWarn - Value for log warn.
 * @returns Computed `FollowUpRuleContext` result.
 */
export function createFollowUpRuleContext(
  overridePath: string | null,
  logInfo: (message: string) => void = (message) => console.log(message),
  logWarn: (message: string) => void = (message) => console.warn(message)
): FollowUpRuleContext {
  const defaultContext = buildDefaultFollowUpRuleContext();
  if (!overridePath) {
    return defaultContext;
  }

  const loaded = loadFollowUpOverrideFromPath(overridePath, logInfo, logWarn);
  if (!loaded) {
    return defaultContext;
  }

  const override = loaded.override;
  return {
    rulepackVersion: defaultContext.rulepackVersion,
    maxShortTokenCount: defaultContext.maxShortTokenCount,
    ackTokens: mergeTokenSets(
      defaultContext.ackTokens,
      override.aliases.ack
        .filter((alias) => !alias.includes(" "))
        .flatMap((alias) => tokenizeForRules(alias))
    ),
    approveTokens: mergeTokenSets(
      defaultContext.approveTokens,
      override.aliases.approve
        .filter((alias) => !alias.includes(" "))
        .flatMap((alias) => tokenizeForRules(alias))
    ),
    denyTokens: mergeTokenSets(
      defaultContext.denyTokens,
      override.aliases.deny
        .filter((alias) => !alias.includes(" "))
        .flatMap((alias) => tokenizeForRules(alias))
    ),
    adjustLeadTokens: mergeTokenSets(
      defaultContext.adjustLeadTokens,
      override.aliases.adjustLead
        .filter((alias) => !alias.includes(" "))
        .flatMap((alias) => tokenizeForRules(alias))
    ),
    ackAliasPhrases: new Set(override.aliases.ack.filter((alias) => alias.includes(" "))),
    approveAliasPhrases: new Set(override.aliases.approve.filter((alias) => alias.includes(" "))),
    denyAliasPhrases: new Set(override.aliases.deny.filter((alias) => alias.includes(" "))),
    adjustLeadAliasPhrases: new Set(
      override.aliases.adjustLead.filter((alias) => alias.includes(" "))
    ),
    overrideFingerprint: loaded.fingerprint,
    overrideSourcePath: loaded.sourcePath
  };
}

/**
 * Evaluates any signal and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the any signal policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param tokens - Token value used for lexical parsing or matching.
 * @param signalSet - Value for signal set.
 * @returns `true` when this check passes.
 */
function hasAnySignal(tokens: readonly string[], signalSet: ReadonlySet<string>): boolean {
  return tokens.some((token) => signalSet.has(token));
}

/**
 * Builds classification for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of classification consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param category - Value for category.
 * @param confidenceTier - Stable identifier used to reference an entity or record.
 * @param matchedRuleId - Stable identifier used to reference an entity or record.
 * @param rulepackVersion - Value for rulepack version.
 * @param isShortFollowUp - Boolean gate controlling this branch.
 * @returns Computed `FollowUpClassification` result.
 */
function buildClassification(
  category: FollowUpCategory,
  confidenceTier: FollowUpConfidenceTier,
  matchedRuleId: string,
  rulepackVersion: string,
  isShortFollowUp: boolean
): FollowUpClassification {
  return {
    isShortFollowUp,
    category,
    confidenceTier,
    matchedRuleId,
    rulepackVersion
  };
}

/**
 * Classifies short utterance with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for short utterance so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Computed `FollowUpClassification` result.
 */
export function classifyShortUtterance(
  text: string,
  ruleContext: FollowUpRuleContext
): FollowUpClassification {
  const normalizedText = normalizeClassifierText(text);
  const tokens = tokenizeForRules(text);
  if (tokens.length === 0) {
    return buildClassification(
      "UNCLEAR",
      "LOW",
      "follow_up_v1_empty_input",
      ruleContext.rulepackVersion,
      false
    );
  }

  if (tokens.length > ruleContext.maxShortTokenCount) {
    return buildClassification(
      "UNCLEAR",
      "LOW",
      "follow_up_v1_token_count_exceeded",
      ruleContext.rulepackVersion,
      false
    );
  }

  const hasApproveSignal =
    hasAnySignal(tokens, ruleContext.approveTokens) ||
    ruleContext.approveAliasPhrases.has(normalizedText);
  const hasDenySignal =
    hasAnySignal(tokens, ruleContext.denyTokens) ||
    ruleContext.denyAliasPhrases.has(normalizedText);
  const hasAckSignal =
    hasAnySignal(tokens, ruleContext.ackTokens) ||
    ruleContext.ackAliasPhrases.has(normalizedText);

  if (hasApproveSignal && hasDenySignal) {
    return buildClassification(
      "UNCLEAR",
      "LOW",
      "follow_up_v1_conflicting_approve_and_deny",
      ruleContext.rulepackVersion,
      false
    );
  }

  if (hasDenySignal) {
    return buildClassification(
      "DENY",
      tokens.length <= 2 ? "HIGH" : "MED",
      "follow_up_v1_short_deny_signal",
      ruleContext.rulepackVersion,
      true
    );
  }

  if (hasApproveSignal) {
    return buildClassification(
      "APPROVE",
      tokens.length <= 2 ? "HIGH" : "MED",
      "follow_up_v1_short_approve_signal",
      ruleContext.rulepackVersion,
      true
    );
  }

  if (hasAckSignal) {
    return buildClassification(
      "ACK",
      tokens.length <= 2 ? "HIGH" : "MED",
      "follow_up_v1_short_ack_signal",
      ruleContext.rulepackVersion,
      true
    );
  }

  return buildClassification(
    "UNCLEAR",
    "LOW",
    "follow_up_v1_no_short_signal",
    ruleContext.rulepackVersion,
    false
  );
}

/**
 * Classifies follow up with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for follow up so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `FollowUpClassification` result.
 */
export function classifyFollowUp(
  text: string,
  options: FollowUpClassificationOptions
): FollowUpClassification {
  const base = classifyShortUtterance(text, options.ruleContext);
  if (base.isShortFollowUp) {
    return base;
  }

  if (!options.hasPriorAssistantQuestion) {
    return base;
  }

  const tokens = tokenizeForRules(text);
  if (tokens.length === 0 || tokens.length > options.ruleContext.maxShortTokenCount) {
    return base;
  }
  if (base.matchedRuleId !== "follow_up_v1_no_short_signal") {
    return base;
  }

  return buildClassification(
    "ACK",
    "MED",
    "follow_up_v1_contextual_short_reply",
    options.ruleContext.rulepackVersion,
    true
  );
}

/**
 * Classifies proposal reply with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for proposal reply so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `ProposalReplyClassification` result.
 */
export function classifyProposalReply(
  text: string,
  options: ProposalReplyClassificationOptions
): ProposalReplyClassification {
  const base = classifyShortUtterance(text, options.ruleContext);
  if (!options.hasActiveProposal) {
    return {
      ...base,
      intent: "QUESTION",
      adjustmentText: null,
      matchedRuleId: "proposal_reply_v1_no_active_proposal",
      isShortFollowUp: false,
      category: "UNCLEAR",
      confidenceTier: "LOW"
    };
  }

  const normalized = normalizeClassifierText(text);
  const tokens = tokenizeForRules(normalized);
  const firstToken = tokens[0] ?? "";
  const matchedAdjustPhrase = [...options.ruleContext.adjustLeadAliasPhrases].find(
    (alias) => normalized === alias || normalized.startsWith(`${alias} `)
  );
  if (options.ruleContext.adjustLeadTokens.has(firstToken) || matchedAdjustPhrase) {
    const adjustmentHead = matchedAdjustPhrase ?? firstToken;
    const adjustmentText = normalizeWhitespace(
      normalized.slice(normalized.indexOf(adjustmentHead) + adjustmentHead.length)
    );
    if (!adjustmentText) {
      return {
        ...base,
        intent: "QUESTION",
        adjustmentText: null,
        matchedRuleId: "proposal_reply_v1_adjust_without_content",
        isShortFollowUp: false,
        category: "UNCLEAR",
        confidenceTier: "LOW"
      };
    }

    return {
      ...base,
      intent: "ADJUST",
      adjustmentText,
      matchedRuleId: "proposal_reply_v1_adjust_lead_token",
      isShortFollowUp: false,
      category: "ACK",
      confidenceTier: "HIGH"
    };
  }

  if (base.isShortFollowUp && base.category === "APPROVE") {
    return {
      ...base,
      intent: "APPROVE",
      adjustmentText: null,
      matchedRuleId: "proposal_reply_v1_short_approve"
    };
  }

  if (base.isShortFollowUp && base.category === "DENY") {
    return {
      ...base,
      intent: "CANCEL",
      adjustmentText: null,
      matchedRuleId: "proposal_reply_v1_short_cancel"
    };
  }

  return {
    ...base,
    intent: "QUESTION",
    adjustmentText: null,
    matchedRuleId: "proposal_reply_v1_question_or_unclear"
  };
}
