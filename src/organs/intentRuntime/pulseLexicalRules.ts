/**
 * @fileoverview Deterministic pulse lexical rulepack, override loading, and classification helpers.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { sha256HexFromCanonicalJson } from "../../core/normalizers/canonicalizationRules";
import {
  PulseControlMode,
  PulseLexicalCategory,
  PulseLexicalClassification,
  PulseLexicalConfidenceTier,
  PulseLexicalOverrideV1,
  PulseLexicalRuleContext
} from "./contracts";

interface NormalizedPulseLexicalOverrideV1 {
  schemaVersion: 1;
  disableIntents: readonly PulseControlMode[];
  requirePulseKeywordForOnOff: boolean;
  requirePulseKeywordForVisibility: boolean;
  requirePulseKeywordForStatus: boolean;
}

interface LoadedPulseLexicalOverrideV1 {
  sourcePath: string;
  fingerprint: string;
  override: NormalizedPulseLexicalOverrideV1;
}

/**
 * Frozen deterministic baseline rulepack.
 * Locale posture: deterministic, locale-neutral baseline (English-first initially).
 */
export const PulseLexicalRulepackV1 = Object.freeze({
  version: "PulseLexicalRulepackV1",
  pulseHintPattern:
    /\b(pulse|check[- ]?in|check in|notifications?|reminders?|nudges?|pings?)\b/i,
  directPhrases: {
    private: ["turn on private", "pulse private"],
    public: ["turn on public", "pulse public"],
    off: ["turn off pulse", "pulse off"],
    on: ["turn on pulse", "pulse on"],
    status: ["pulse status"]
  },
  statusPatterns: [
    /\bstatus\b/i,
    /\bare\b.*\b(check[- ]?ins?|notifications?|reminders?|pulse)\b.*\b(on|enabled)\b/i,
    /\bwhat(?:'s| is)\b.*\b(pulse|check[- ]?in|notification|reminder)\b/i
  ],
  privatePatterns: [/\bprivate\b/i, /\bdm\b/i],
  publicPatterns: [/\bpublic\b/i, /\bchannel\b/i, /\bgroup\b/i],
  offPatterns: [
    /\bturn\s+off\b/i,
    /\bstop\b/i,
    /\bdisable\b/i,
    /\bpause\b/i,
    /\bno\s+more\b/i,
    /\bdon't\b.*\b(remind|notify|ping|check)\b/i,
    /\bdo\s+not\b.*\b(remind|notify|ping|check)\b/i
  ],
  onPatterns: [/\bturn\s+on\b/i, /\benable\b/i, /\bresume\b/i, /\bstart\b/i]
} as const);

const PULSE_OVERRIDE_MAX_DISABLED_INTENTS = 5;
const ALL_PULSE_MODES: readonly PulseControlMode[] = ["on", "off", "private", "public", "status"];
const DEFAULT_PULSE_LEXICAL_RULE_CONTEXT: PulseLexicalRuleContext = buildDefaultPulseLexicalRuleContext();

/**
 * Normalizes whitespace into a stable shape for `pulseLexicalRules` logic.
 *
 * @param value - Input text.
 * @returns Normalized text.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes classifier text into a stable shape for pulse lexical rules.
 *
 * @param value - Input text.
 * @returns Lowercased normalized text.
 */
function normalizeClassifierText(value: string): string {
  return normalizeWhitespace(
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u2019`]/g, "'")
  );
}

/**
 * Checks whether any regex pattern matches the supplied text.
 *
 * @param text - Normalized input text.
 * @param patterns - Candidate patterns.
 * @returns `true` when any pattern matches.
 */
function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Returns `true` when the text includes a pulse/check-in hint.
 *
 * @param text - Normalized input text.
 * @returns `true` when a pulse hint is present.
 */
function containsPulseHint(text: string): boolean {
  return PulseLexicalRulepackV1.pulseHintPattern.test(text);
}

/**
 * Returns `true` when the value is a supported pulse control mode.
 *
 * @param value - Candidate mode value.
 * @returns Type-guard result.
 */
function isPulseControlMode(value: unknown): value is PulseControlMode {
  return value === "on" || value === "off" || value === "private" || value === "public" || value === "status";
}

/**
 * Normalizes disabled intent overrides into deterministic sorted form.
 *
 * @param values - Raw override payload.
 * @returns Normalized disabled intent list.
 */
function normalizeDisabledIntents(values: unknown): readonly PulseControlMode[] {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("PulseLexicalOverrideV1 disableIntents must be an array when provided.");
  }
  if (values.length > PULSE_OVERRIDE_MAX_DISABLED_INTENTS) {
    throw new Error(
      `PulseLexicalOverrideV1 disableIntents exceeds ${PULSE_OVERRIDE_MAX_DISABLED_INTENTS} entries.`
    );
  }

  const normalized: PulseControlMode[] = [];
  for (const candidate of values) {
    if (!isPulseControlMode(candidate)) {
      throw new Error("PulseLexicalOverrideV1 disableIntents includes an unsupported mode.");
    }
    normalized.push(candidate);
  }

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

/**
 * Parses and validates a pulse lexical override payload.
 *
 * @param raw - Parsed JSON payload.
 * @returns Normalized override payload.
 */
function parsePulseLexicalOverrideV1(raw: unknown): NormalizedPulseLexicalOverrideV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PulseLexicalOverrideV1 payload must be an object.");
  }

  const record = raw as Partial<PulseLexicalOverrideV1> & Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new Error("PulseLexicalOverrideV1 schemaVersion must be 1.");
  }

  const allowedKeys = new Set([
    "schemaVersion",
    "disableIntents",
    "requirePulseKeywordForOnOff",
    "requirePulseKeywordForVisibility",
    "requirePulseKeywordForStatus"
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`PulseLexicalOverrideV1 field '${key}' is not supported.`);
    }
  }

  return {
    schemaVersion: 1,
    disableIntents: normalizeDisabledIntents(record.disableIntents),
    requirePulseKeywordForOnOff: record.requirePulseKeywordForOnOff === true,
    requirePulseKeywordForVisibility: record.requirePulseKeywordForVisibility === true,
    requirePulseKeywordForStatus: record.requirePulseKeywordForStatus === true
  };
}

/**
 * Loads a pulse lexical override from disk.
 *
 * @param overridePath - Relative or absolute override path.
 * @param logInfo - Info logger.
 * @param logWarn - Warning logger.
 * @returns Loaded override metadata or `null` on failure.
 */
function loadPulseLexicalOverrideFromPath(
  overridePath: string,
  logInfo: (message: string) => void,
  logWarn: (message: string) => void
): LoadedPulseLexicalOverrideV1 | null {
  const resolvedPath = path.resolve(process.cwd(), overridePath);
  try {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalizedOverride = parsePulseLexicalOverrideV1(parsed);
    const fingerprint = sha256HexFromCanonicalJson(normalizedOverride);
    logInfo(
      `[PulseLexicalClassifier] Loaded PulseLexicalOverrideV1 from '${resolvedPath}' ` +
      `(fingerprint=${fingerprint}, disabledIntents=${normalizedOverride.disableIntents.length}).`
    );
    return {
      sourcePath: resolvedPath,
      fingerprint,
      override: normalizedOverride
    };
  } catch (error) {
    logWarn(
      `[PulseLexicalClassifier] PulseLexicalOverrideV1 load failed for '${resolvedPath}'. ` +
      `Falling back to baseline rulepack. Reason: ${(error as Error).message}`
    );
    return null;
  }
}

/**
 * Builds the baseline pulse lexical rule context.
 *
 * @returns Default rule context.
 */
function buildDefaultPulseLexicalRuleContext(): PulseLexicalRuleContext {
  return {
    rulepackVersion: PulseLexicalRulepackV1.version,
    disabledIntents: new Set<PulseControlMode>(),
    requirePulseKeywordForOnOff: true,
    requirePulseKeywordForVisibility: false,
    requirePulseKeywordForStatus: false,
    overrideFingerprint: null,
    overrideSourcePath: null
  };
}

/**
 * Creates the pulse lexical rule context, optionally with override loading.
 *
 * @param overridePath - Optional override file path.
 * @param logInfo - Info logger.
 * @param logWarn - Warning logger.
 * @returns Rule context used by the classifier.
 */
export function createPulseLexicalRuleContext(
  overridePath: string | null,
  logInfo: (message: string) => void = (message) => console.log(message),
  logWarn: (message: string) => void = (message) => console.warn(message)
): PulseLexicalRuleContext {
  const defaultContext = buildDefaultPulseLexicalRuleContext();
  if (!overridePath) {
    return defaultContext;
  }

  const loaded = loadPulseLexicalOverrideFromPath(overridePath, logInfo, logWarn);
  if (!loaded) {
    return defaultContext;
  }

  return {
    rulepackVersion: defaultContext.rulepackVersion,
    disabledIntents: new Set(loaded.override.disableIntents),
    requirePulseKeywordForOnOff: loaded.override.requirePulseKeywordForOnOff,
    requirePulseKeywordForVisibility: loaded.override.requirePulseKeywordForVisibility,
    requirePulseKeywordForStatus: loaded.override.requirePulseKeywordForStatus,
    overrideFingerprint: loaded.fingerprint,
    overrideSourcePath: loaded.sourcePath
  };
}

/**
 * Shapes a pulse lexical classification result.
 *
 * @param category - Classification category.
 * @param commandIntent - Matched command intent if any.
 * @param confidenceTier - Confidence tier.
 * @param matchedRuleId - Rule identifier.
 * @param rulepackVersion - Rulepack version string.
 * @param conflict - Conflict flag.
 * @returns Typed classification result.
 */
function toClassification(
  category: PulseLexicalCategory,
  commandIntent: PulseControlMode | null,
  confidenceTier: PulseLexicalConfidenceTier,
  matchedRuleId: string,
  rulepackVersion: string,
  conflict: boolean
): PulseLexicalClassification {
  return {
    category,
    commandIntent,
    confidenceTier,
    matchedRuleId,
    rulepackVersion,
    conflict
  };
}

/**
 * Returns the canonical disabled-intent classification.
 *
 * @param commandIntent - Disabled command intent.
 * @param ruleContext - Active rule context.
 * @returns Conflict classification.
 */
function buildDisabledIntentClassification(
  commandIntent: PulseControlMode,
  ruleContext: PulseLexicalRuleContext
): PulseLexicalClassification {
  return toClassification(
    "UNCLEAR",
    null,
    "LOW",
    `pulse_lexical_v1_disabled_intent_${commandIntent}`,
    ruleContext.rulepackVersion,
    true
  );
}

/**
 * Resolves exact direct-phrase commands.
 *
 * @param text - Normalized text.
 * @returns Matching direct intent or `null`.
 */
function resolveDirectPhraseIntent(text: string): PulseControlMode | null {
  const entries: ReadonlyArray<[PulseControlMode, readonly string[]]> = [
    ["private", PulseLexicalRulepackV1.directPhrases.private],
    ["public", PulseLexicalRulepackV1.directPhrases.public],
    ["off", PulseLexicalRulepackV1.directPhrases.off],
    ["on", PulseLexicalRulepackV1.directPhrases.on],
    ["status", PulseLexicalRulepackV1.directPhrases.status]
  ];

  for (const [intent, phrases] of entries) {
    if (phrases.includes(text)) {
      return intent;
    }
  }
  return null;
}

/**
 * Resolves non-direct pulse signals from regex rules.
 *
 * @param normalizedText - Normalized user text.
 * @param hasPulseHint - Whether a pulse keyword is present.
 * @param ruleContext - Active rule context.
 * @returns Pulse lexical classification.
 */
function resolveSignalIntent(
  normalizedText: string,
  hasPulseHint: boolean,
  ruleContext: PulseLexicalRuleContext
): PulseLexicalClassification {
  const statusSignal = matchesAnyPattern(normalizedText, PulseLexicalRulepackV1.statusPatterns);
  const privateSignal = matchesAnyPattern(normalizedText, PulseLexicalRulepackV1.privatePatterns);
  const publicSignal = matchesAnyPattern(normalizedText, PulseLexicalRulepackV1.publicPatterns);
  const offSignal = matchesAnyPattern(normalizedText, PulseLexicalRulepackV1.offPatterns);
  const onSignal = matchesAnyPattern(normalizedText, PulseLexicalRulepackV1.onPatterns);

  const gatedStatusSignal = statusSignal && (hasPulseHint || !ruleContext.requirePulseKeywordForStatus);
  const gatedPrivateSignal = privateSignal && (hasPulseHint || !ruleContext.requirePulseKeywordForVisibility);
  const gatedPublicSignal = publicSignal && (hasPulseHint || !ruleContext.requirePulseKeywordForVisibility);
  const gatedOffSignal = offSignal && (hasPulseHint || !ruleContext.requirePulseKeywordForOnOff);
  const gatedOnSignal = onSignal && (hasPulseHint || !ruleContext.requirePulseKeywordForOnOff);

  if (gatedOnSignal && gatedOffSignal) {
    return toClassification(
      "UNCLEAR",
      null,
      "LOW",
      "pulse_lexical_v1_conflicting_on_and_off",
      ruleContext.rulepackVersion,
      true
    );
  }

  if (gatedPrivateSignal && gatedPublicSignal) {
    return toClassification(
      "UNCLEAR",
      null,
      "LOW",
      "pulse_lexical_v1_conflicting_private_and_public",
      ruleContext.rulepackVersion,
      true
    );
  }

  if (gatedStatusSignal && (gatedOnSignal || gatedOffSignal || gatedPrivateSignal || gatedPublicSignal)) {
    return toClassification(
      "UNCLEAR",
      null,
      "LOW",
      "pulse_lexical_v1_conflicting_status_and_mode",
      ruleContext.rulepackVersion,
      true
    );
  }

  if (gatedOffSignal) {
    if (ruleContext.disabledIntents.has("off")) {
      return buildDisabledIntentClassification("off", ruleContext);
    }
    return toClassification("COMMAND", "off", "HIGH", "pulse_lexical_v1_pattern_off", ruleContext.rulepackVersion, false);
  }

  if (gatedPrivateSignal) {
    if (ruleContext.disabledIntents.has("private")) {
      return buildDisabledIntentClassification("private", ruleContext);
    }
    return toClassification(
      "COMMAND",
      "private",
      hasPulseHint ? "HIGH" : "MED",
      "pulse_lexical_v1_pattern_private",
      ruleContext.rulepackVersion,
      false
    );
  }

  if (gatedPublicSignal) {
    if (ruleContext.disabledIntents.has("public")) {
      return buildDisabledIntentClassification("public", ruleContext);
    }
    return toClassification(
      "COMMAND",
      "public",
      hasPulseHint ? "HIGH" : "MED",
      "pulse_lexical_v1_pattern_public",
      ruleContext.rulepackVersion,
      false
    );
  }

  if (gatedOnSignal) {
    if (ruleContext.disabledIntents.has("on")) {
      return buildDisabledIntentClassification("on", ruleContext);
    }
    return toClassification("COMMAND", "on", "HIGH", "pulse_lexical_v1_pattern_on", ruleContext.rulepackVersion, false);
  }

  if (gatedStatusSignal) {
    if (ruleContext.disabledIntents.has("status")) {
      return buildDisabledIntentClassification("status", ruleContext);
    }
    return toClassification(
      "COMMAND",
      "status",
      "HIGH",
      "pulse_lexical_v1_pattern_status",
      ruleContext.rulepackVersion,
      false
    );
  }

  return toClassification(
    "NON_COMMAND",
    null,
    "LOW",
    "pulse_lexical_v1_no_pulse_signal",
    ruleContext.rulepackVersion,
    false
  );
}

/**
 * Classifies pulse lexical command with deterministic rule logic.
 *
 * @param text - User text to classify.
 * @param ruleContext - Active pulse lexical rule context.
 * @returns Deterministic lexical classification.
 */
export function classifyPulseLexicalCommand(
  text: string,
  ruleContext: PulseLexicalRuleContext = DEFAULT_PULSE_LEXICAL_RULE_CONTEXT
): PulseLexicalClassification {
  const normalizedText = normalizeClassifierText(text);
  if (!normalizedText) {
    return toClassification(
      "NON_COMMAND",
      null,
      "LOW",
      "pulse_lexical_v1_empty_input",
      ruleContext.rulepackVersion,
      false
    );
  }

  const directIntent = resolveDirectPhraseIntent(normalizedText);
  if (directIntent) {
    if (ruleContext.disabledIntents.has(directIntent)) {
      return buildDisabledIntentClassification(directIntent, ruleContext);
    }
    return toClassification(
      "COMMAND",
      directIntent,
      "HIGH",
      `pulse_lexical_v1_direct_${directIntent}`,
      ruleContext.rulepackVersion,
      false
    );
  }

  return resolveSignalIntent(normalizedText, containsPulseHint(normalizedText), ruleContext);
}

/**
 * Lists supported pulse control modes in deterministic order.
 *
 * @returns Supported pulse control modes.
 */
export function listPulseControlModes(): readonly PulseControlMode[] {
  return ALL_PULSE_MODES;
}
