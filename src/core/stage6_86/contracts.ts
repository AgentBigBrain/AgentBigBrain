/**
 * @fileoverview Shared Stage 6.86 runtime-state and runtime-action contracts for the extracted subsystem.
 */

import type { LedgerBackend } from "../config";
import type { EntityGraphStore } from "../entityGraphStore";
import type { BridgeQuestionTimingInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type { Stage686PulseStateV1 } from "./memoryGovernance";
import type {
  BridgeQuestionV1,
  ConstraintViolationCode,
  ConversationStackV1,
  TaskRunResult
} from "../types";

export type Stage686RuntimeMetadata = Record<string, string | number | boolean | null>;

export interface Stage686RuntimeStateSnapshot {
  updatedAt: string;
  conversationStack: ConversationStackV1;
  pulseState: Stage686PulseStateV1;
  pendingBridgeQuestions: readonly BridgeQuestionV1[];
  lastMemoryMutationReceiptHash: string | null;
}

export interface Stage686RuntimeStateAdapter {
  load(): Promise<Stage686RuntimeStateSnapshot>;
  save(snapshot: Stage686RuntimeStateSnapshot): Promise<void>;
}

export interface Stage686RuntimeActionEngineOptions {
  backend: LedgerBackend;
  sqlitePath: string;
  exportJsonOnWrite: boolean;
  entityGraphStore?: EntityGraphStore;
  runtimeStateStore?: Stage686RuntimeStateAdapter;
  bridgeQuestionTimingInterpretationResolver?: BridgeQuestionTimingInterpretationResolver;
}

export interface ExecuteStage686RuntimeActionInput {
  taskId: string;
  proposalId: string;
  missionId: string;
  missionAttemptId: number;
  userInput?: string;
  action: TaskRunResult["plan"]["actions"][number];
}

export interface Stage686RuntimeActionResult {
  approved: boolean;
  output: string;
  violationCode: Extract<ConstraintViolationCode, "MEMORY_MUTATION_BLOCKED" | "PULSE_BLOCKED"> | null;
  violationMessage: string | null;
  executionMetadata: Stage686RuntimeMetadata;
  traceDetails: Stage686RuntimeMetadata;
}
