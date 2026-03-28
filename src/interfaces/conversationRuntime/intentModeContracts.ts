/**
 * @fileoverview Canonical intent-mode contracts for the human-centric execution front door.
 */

import type {
  ClarificationOptionId,
  ConversationIntentMode
} from "../sessionStore";

export type IntentModeConfidence = "high" | "medium" | "low";
export type ConversationIntentSemanticHint =
  | "review_ready"
  | "guided_review"
  | "next_review_step"
  | "while_away_review"
  | "wrap_up_summary"
  | "explain_handoff"
  | "resume_handoff"
  | "status_change_summary"
  | "status_return_handoff"
  | "status_location"
  | "status_browser"
  | "status_progress"
  | "status_waiting";

export interface IntentClarificationCandidate {
  kind: "execution_mode";
  matchedRuleId: string;
  question: string;
  options: readonly {
    id: ClarificationOptionId;
    label: string;
  }[];
}

export interface ResolvedConversationIntentMode {
  mode: ConversationIntentMode;
  confidence: IntentModeConfidence;
  matchedRuleId: string;
  explanation: string;
  clarification: IntentClarificationCandidate | null;
  semanticHint?: ConversationIntentSemanticHint | null;
}
