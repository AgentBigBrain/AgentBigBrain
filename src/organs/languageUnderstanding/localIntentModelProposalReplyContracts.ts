/**
 * @fileoverview Bounded local conversational-interpretation contracts for proposal/draft replies.
 */

import type { RoutingMapClassificationV1 } from "../../interfaces/routingMap";
import type {
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

export type ProposalReplyInterpretationKind =
  | "approve"
  | "cancel"
  | "adjust"
  | "question_or_unclear"
  | "non_proposal_reply"
  | "uncertain";

export interface ProposalReplyInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  activeProposalPreview?: string | null;
  recentAssistantTurn?: string | null;
}

export interface ProposalReplyInterpretationSignal {
  source: "local_intent_model";
  kind: ProposalReplyInterpretationKind;
  adjustmentText: string | null;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type ProposalReplyInterpretationResolver = (
  request: ProposalReplyInterpretationRequest
) => Promise<ProposalReplyInterpretationSignal | null>;
