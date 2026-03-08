/**
 * @fileoverview Shared intent-runtime and pulse-lexical contracts.
 */

export type PulseControlMode = "on" | "off" | "private" | "public" | "status";
export type PulseLexicalCategory = "COMMAND" | "NON_COMMAND" | "UNCLEAR";
export type PulseLexicalConfidenceTier = "HIGH" | "MED" | "LOW";

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
  intentType: "pulse_control" | "none";
  pulseMode: PulseControlMode | null;
  confidence: number;
  rationale: string;
  source: "deterministic" | "model" | "fallback";
  lexicalClassification?: PulseLexicalClassification | null;
}
