/**
 * @fileoverview Shared intent-runtime and pulse-lexical contracts.
 */

export type PulseControlMode = "on" | "off" | "private" | "public" | "status";
export type PulseLexicalCategory = "COMMAND" | "NON_COMMAND" | "UNCLEAR";
export type PulseLexicalConfidenceTier = "HIGH" | "MED" | "LOW";
export type PulsePreferenceIntent =
  | "mute_topic"
  | "private_only"
  | "schedule_followup"
  | "feedback_useful"
  | "feedback_not_useful"
  | "quiet_hours_topic"
  | "check_in_later";

export interface PulsePreferenceCandidate {
  preferenceIntent: PulsePreferenceIntent;
  confidenceTier: PulseLexicalConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  subjectHint: string | null;
  scheduledHint: string | null;
  source: "lexical_candidate" | "model_candidate";
  authority: {
    outreachAuthority: false;
    deliveryPermission: false;
    overridesPolicy: false;
  };
  blocked: boolean;
  blockReason: "override_load_failed" | "ambiguous" | null;
}

export interface PulseLexicalClassification {
  category: PulseLexicalCategory;
  commandIntent: PulseControlMode | null;
  confidenceTier: PulseLexicalConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  conflict: boolean;
}

export interface PulseLexicalOverrideV1 {
  schemaVersion: 1;
  disableIntents?: readonly PulseControlMode[];
  requirePulseKeywordForOnOff?: boolean;
  requirePulseKeywordForVisibility?: boolean;
  requirePulseKeywordForStatus?: boolean;
}

export interface PulseLexicalRuleContext {
  rulepackVersion: string;
  disabledIntents: ReadonlySet<PulseControlMode>;
  requirePulseKeywordForOnOff: boolean;
  requirePulseKeywordForVisibility: boolean;
  requirePulseKeywordForStatus: boolean;
  overrideFingerprint: string | null;
  overrideSourcePath: string | null;
  overrideLoadFailed?: boolean;
}

export interface IntentInterpreterTurn {
  role: "user" | "assistant";
  text: string;
}

export interface IntentInterpreterContext {
  recentTurns?: IntentInterpreterTurn[];
  pulseRuleContext?: PulseLexicalRuleContext;
}

export interface InterpretedConversationIntent {
  intentType: "pulse_control" | "pulse_preference" | "none";
  pulseMode: PulseControlMode | null;
  pulsePreferenceCandidate?: PulsePreferenceCandidate | null;
  confidence: number;
  rationale: string;
  source: "deterministic" | "model" | "fallback";
  lexicalClassification?: PulseLexicalClassification | null;
}
