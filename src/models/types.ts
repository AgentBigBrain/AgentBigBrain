/**
 * @fileoverview Model client contracts and structured schema payload definitions.
 */

import { ActionType } from "../core/types";

export type ModelBackend = "mock" | "openai" | "ollama";

export interface ModelUsageSnapshot {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedSpendUsd: number;
}

export interface StructuredCompletionRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  temperature?: number;
}

export interface ModelClient {
  backend: ModelBackend;
  completeJson<T>(request: StructuredCompletionRequest): Promise<T>;
  getUsageSnapshot?(): ModelUsageSnapshot;
}

export interface ModelPlannedAction {
  type: ActionType;
  description: string;
  params?: Record<string, unknown>;
  estimatedCostUsd?: number;
}

export interface PlannerModelOutput {
  plannerNotes: string;
  actions: ModelPlannedAction[];
}

export interface ResponseSynthesisModelOutput {
  message: string;
}

export interface ReflectionModelOutput {
  lessons: string[];
}

export interface SuccessReflectionModelOutput {
  lesson: string;
  nearMiss: string | null;
}

export interface GovernorModelOutput {
  approve: boolean;
  reason: string;
  confidence: number;
}

export interface AutonomousNextStepModelOutput {
  isGoalMet: boolean;
  nextUserInput: string;
  reasoning: string;
}

export interface ProactiveGoalModelOutput {
  proactiveGoal: string;
  reasoning: string;
}

export interface IntentInterpretationModelOutput {
  intentType: "pulse_control" | "none";
  mode: "on" | "off" | "private" | "public" | "status" | null;
  confidence: number;
  rationale: string;
}

export interface LanguageEpisodeExtractionModelCandidate {
  subjectName: string;
  eventSummary: string;
  supportingSnippet: string;
  status: "unresolved" | "partially_resolved" | "resolved" | "outcome_unknown" | "no_longer_relevant";
  confidence: number;
  tags: string[];
}

export interface LanguageEpisodeExtractionModelOutput {
  episodes: LanguageEpisodeExtractionModelCandidate[];
}
