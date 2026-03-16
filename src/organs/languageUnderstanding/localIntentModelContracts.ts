/**
 * @fileoverview Canonical contracts for the optional local intent-model path used by the human-centric execution front door.
 */

import type { RoutingMapClassificationV1 } from "../../interfaces/routingMap";
import type {
  ConversationIntentSemanticHint,
  ResolvedConversationIntentMode
} from "../../interfaces/conversationRuntime/intentModeContracts";
import type {
  ConversationIntentMode,
  ConversationReturnHandoffStatus
} from "../../interfaces/sessionStore";

export interface LocalIntentModelSessionHints {
  hasReturnHandoff: boolean;
  returnHandoffStatus: ConversationReturnHandoffStatus | null;
  returnHandoffPreviewAvailable: boolean;
  returnHandoffPrimaryArtifactAvailable: boolean;
  returnHandoffChangedPathCount: number;
  returnHandoffNextSuggestedStepAvailable: boolean;
  modeContinuity: ConversationIntentMode | null;
}

export interface LocalIntentModelRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
}

export interface LocalIntentModelSignal extends ResolvedConversationIntentMode {
  source: "local_intent_model";
  semanticHint?: ConversationIntentSemanticHint | null;
}

export type LocalIntentModelResolver = (
  request: LocalIntentModelRequest
) => Promise<LocalIntentModelSignal | null>;
