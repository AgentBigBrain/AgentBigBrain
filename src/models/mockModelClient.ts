/**
 * @fileoverview Deterministic mock model backend for local development and CI testing.
 */

import {
  AutonomousNextStepModelOutput,
  GovernorModelOutput,
  LanguageEpisodeExtractionModelOutput,
  ModelClient,
  ModelUsageSnapshot,
  ProactiveGoalModelOutput,
  ReflectionModelOutput,
  SuccessReflectionModelOutput,
  StructuredCompletionRequest
} from "./types";
import { normalizeStructuredModelOutput, validateStructuredModelOutput } from "./schema/validation";
import { buildIntentInterpretationOutput } from "./mock/intentResponses";
import { buildLanguageEpisodeExtractionOutput } from "./mock/languageUnderstanding";
import { buildPlannerOutput } from "./mock/plannerResponses";
import { buildResponseSynthesisOutput } from "./mock/responseSynthesis";
import { asString, isActionType, parseJsonObject } from "./mock/contracts";

/**
 * Builds governor output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of governor output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `GovernorModelOutput` (import `GovernorModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `GovernorModelOutput` result.
 */
function buildGovernorOutput(userPrompt: string): GovernorModelOutput {
  const input = parseJsonObject(userPrompt);
  const governorId = asString(input.governorId).toLowerCase();
  const actionTypeRaw = asString(input.actionType).toLowerCase();
  const actionType = isActionType(actionTypeRaw) ? actionTypeRaw : "respond";
  const actionDescription = asString(input.actionDescription).toLowerCase();
  const rationale = asString(input.rationale).toLowerCase();
  const combined = `${actionDescription} ${rationale}`;

  if (["malware", "phishing", "dox", "harmful", "exploit"].some((term) => combined.includes(term))) {
    return {
      approve: false,
      reason: "Mock policy model detected harmful intent signals.",
      confidence: 0.95
    };
  }

  if (governorId === "security" && actionType === "delete_file") {
    const path = asString(input.path).toLowerCase().replace(/\\/g, "/");
    if (path && !path.startsWith("runtime/sandbox/")) {
      return {
        approve: false,
        reason: "Mock security model flags delete path outside sandbox.",
        confidence: 0.92
      };
    }
  }

  if (governorId === "compliance" && actionType === "network_write") {
    return {
      approve: false,
      reason: "Mock compliance model blocks network write by default policy.",
      confidence: 0.9
    };
  }

  return {
    approve: true,
    reason: "Mock policy model found no additional risk signals.",
    confidence: 0.82
  };
}

/**
 * Builds reflection output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of reflection output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ReflectionModelOutput` (import `ReflectionModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `ReflectionModelOutput` result.
 */
function buildReflectionOutput(userPrompt: string): ReflectionModelOutput {
  return {
    lessons: ["Mock lesson: always verify input constraints before acting."]
  };
}

/**
 * Produces a deterministic success-reflection lesson for tasks where all actions were approved.
 */
function buildSuccessReflectionOutput(userPrompt: string): SuccessReflectionModelOutput {
  return {
    lesson: "Mock success lesson: the approach of validating constraints early proved effective.",
    nearMiss: null
  };
}

/**
 * Builds autonomous next step output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of autonomous next step output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `AutonomousNextStepModelOutput` (import `AutonomousNextStepModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `AutonomousNextStepModelOutput` result.
 */
function buildAutonomousNextStepOutput(userPrompt: string): AutonomousNextStepModelOutput {
  const input = parseJsonObject(userPrompt);
  const overarchingGoal = asString(input.overarchingGoal).toLowerCase();

  // If the goal contains "stop" or "met", we pretend it's met
  if (overarchingGoal.includes("stop") || overarchingGoal.includes("done")) {
    return {
      isGoalMet: true,
      reasoning: "Mock model decided the overarching goal is met.",
      nextUserInput: ""
    };
  }

  // Otherwise, we provide a generic next step once and then stop
  return {
    isGoalMet: false,
    reasoning: "Mock model decided to take one more step.",
    nextUserInput: "finish the task and stop"
  };
}

/**
 * Builds proactive goal output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of proactive goal output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ProactiveGoalModelOutput` (import `ProactiveGoalModelOutput`) from `./types`.
 *
 * @param _userPrompt - Message/text content processed by this function.
 * @returns Computed `ProactiveGoalModelOutput` result.
 */
function buildProactiveGoalOutput(_userPrompt: string): ProactiveGoalModelOutput {
  return {
    proactiveGoal: "Mock proactive goal generated.",
    reasoning: "Mock model generated a new proactive goal to run continuously."
  };
}


export class MockModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private usage: ModelUsageSnapshot = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };

  /**
   * Derives mock tokens from available runtime inputs.
   *
   * **Why it exists:**
   * Keeps `estimate mock tokens` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `StructuredCompletionRequest` (import `StructuredCompletionRequest`) from `./types`.
   *
   * @param request - Structured input object for this operation.
   * @returns Computed numeric value.
   */
  private estimateMockTokens(request: StructuredCompletionRequest): number {
    const contentLength = request.systemPrompt.length + request.userPrompt.length;
    return Math.max(1, Math.ceil(contentLength / 4));
  }

  /**
   * Tracks usage for audit, retry, or telemetry decisions.
   *
   * **Why it exists:**
   * Centralizes lifecycle tracking for usage so audit and retry flows share one source of truth.
   *
   * **What it talks to:**
   * - Uses `StructuredCompletionRequest` (import `StructuredCompletionRequest`) from `./types`.
   *
   * @param request - Structured input object for this operation.
   */
  private trackUsage(request: StructuredCompletionRequest): void {
    const promptTokens = this.estimateMockTokens(request);
    const completionTokens = 32;
    this.usage.calls += 1;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.totalTokens += promptTokens + completionTokens;
    // Mock backend does not represent billable provider usage.
    this.usage.estimatedSpendUsd += 0;
  }

  /**
   * Reads usage snapshot needed for this execution step.
   *
   * **Why it exists:**
   * Separates usage snapshot read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `ModelUsageSnapshot` (import `ModelUsageSnapshot`) from `./types`.
   * @returns Computed `ModelUsageSnapshot` result.
   */
  getUsageSnapshot(): ModelUsageSnapshot {
    return { ...this.usage };
  }

  /**
   * Completes json through the configured model/provider path.
   *
   * **Why it exists:**
   * Keeps provider completion behavior for json behind a single typed boundary.
   *
   * **What it talks to:**
   * - Uses `normalizeStructuredModelOutput` (import `normalizeStructuredModelOutput`) from `./schemaValidation`.
   * - Uses `validateStructuredModelOutput` (import `validateStructuredModelOutput`) from `./schemaValidation`.
   * - Uses `StructuredCompletionRequest` (import `StructuredCompletionRequest`) from `./types`.
   *
   * @param request - Structured input object for this operation.
   * @returns Promise resolving to T.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.trackUsage(request);

    let output: unknown;
    if (request.schemaName === "planner_v1") {
      output = buildPlannerOutput(request.userPrompt);
    } else if (request.schemaName === "governor_v1") {
      output = buildGovernorOutput(request.userPrompt);
    } else if (request.schemaName === "reflection_v1") {
      output = buildReflectionOutput(request.userPrompt);
    } else if (request.schemaName === "reflection_success_v1") {
      output = buildSuccessReflectionOutput(request.userPrompt);
    } else if (request.schemaName === "autonomous_next_step_v1") {
      output = buildAutonomousNextStepOutput(request.userPrompt);
    } else if (request.schemaName === "proactive_goal_v1") {
      output = buildProactiveGoalOutput(request.userPrompt);
    } else if (request.schemaName === "response_v1") {
      output = buildResponseSynthesisOutput(request.userPrompt);
    } else if (request.schemaName === "intent_interpretation_v1") {
      output = buildIntentInterpretationOutput(request.userPrompt);
    } else if (request.schemaName === "language_episode_extraction_v1") {
      output = buildLanguageEpisodeExtractionOutput(request.userPrompt) as LanguageEpisodeExtractionModelOutput;
    } else {
      throw new Error(`MockModelClient does not support schema: ${request.schemaName}`);
    }

    const normalized = normalizeStructuredModelOutput(request.schemaName, output);
    validateStructuredModelOutput(request.schemaName, normalized);
    return normalized as T;
  }
}
