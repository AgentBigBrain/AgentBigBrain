/**
 * @fileoverview Deterministic response synthesis and post-planner fallback policy.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { PlannedAction, TaskRequest } from "../../core/types";
import { ModelClient, ResponseSynthesisModelOutput } from "../../models/types";
import { extractCurrentUserRequest } from "../memoryBroker";
import {
  allowsRunSkillForRequest,
  hasOnlyRunSkillActions,
  hasRespondMessage
} from "../plannerHelpers";
import { RunSkillPostPolicyResult } from "./executionStyleContracts";
import { RESPONSE_IDENTITY_GUARDRAIL, RESPONSE_STYLE_GUARDRAIL } from "./promptAssembly";

/**
 * Synthesizes a deterministic respond message when planner output omitted user-facing text.
 */
export async function synthesizeRespondMessage(
  modelClient: ModelClient,
  task: TaskRequest,
  synthesizerModel: string
): Promise<string> {
  const output = await modelClient.completeJson<ResponseSynthesisModelOutput>({
    model: synthesizerModel,
    schemaName: "response_v1",
    temperature: 0.2,
    systemPrompt:
      "You are a response synthesizer organ in a governed assistant. " +
      "Return JSON with one key: message. The message must directly answer the user input, be concise, and avoid mentioning internal systems. " +
      RESPONSE_IDENTITY_GUARDRAIL +
      RESPONSE_STYLE_GUARDRAIL,
    userPrompt: JSON.stringify({
      taskId: task.id,
      goal: task.goal,
      userInput: task.userInput
    })
  });

  const message = typeof output.message === "string" ? output.message.trim() : "";
  if (message.length === 0) {
    throw new Error("Response synthesis returned an empty message.");
  }

  return message;
}

/**
 * Ensures respond actions always carry deterministic user-facing text payloads.
 */
export async function ensureRespondMessages(
  modelClient: ModelClient,
  actions: PlannedAction[],
  task: TaskRequest,
  synthesizerModel: string
): Promise<PlannedAction[]> {
  const needsMessage = actions.some(
    (action) => action.type === "respond" && !hasRespondMessage(action)
  );
  if (!needsMessage) {
    return actions;
  }

  const synthesizedMessage = await synthesizeRespondMessage(modelClient, task, synthesizerModel);
  return actions.map((action) => {
    if (action.type !== "respond" || hasRespondMessage(action)) {
      return action;
    }

    return {
      ...action,
      params: {
        ...action.params,
        message: synthesizedMessage
      }
    };
  });
}

/**
 * Builds a deterministic respond fallback action with canonical metadata.
 */
function buildRespondFallbackAction(message: string, id: string, description: string): PlannedAction {
  return {
    id,
    type: "respond",
    description,
    params: {
      message
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "respond",
      params: {
        message
      }
    })
  };
}

/**
 * Applies deterministic post-planner run-skill filtering and respond fallback policy.
 */
export async function enforceRunSkillIntentPolicy(
  modelClient: ModelClient,
  actions: PlannedAction[],
  task: TaskRequest,
  synthesizerModel: string,
  currentUserRequest: string
): Promise<RunSkillPostPolicyResult> {
  const extractedCurrentUserRequest = extractCurrentUserRequest(task.userInput);
  const runSkillAllowed =
    allowsRunSkillForRequest(currentUserRequest) &&
    allowsRunSkillForRequest(extractedCurrentUserRequest);
  const filteredActions = runSkillAllowed
    ? actions
    : actions.filter((action) => action.type !== "run_skill");
  if (filteredActions.length > 0) {
    return {
      actions: filteredActions,
      usedFallback: false
    };
  }

  if (!hasOnlyRunSkillActions(actions)) {
    return {
      actions: filteredActions,
      usedFallback: false
    };
  }

  const synthesizedMessage = await synthesizeRespondMessage(modelClient, task, synthesizerModel);
  return {
    actions: [
      buildRespondFallbackAction(
        synthesizedMessage,
        "action_non_explicit_run_skill_post_filter_fallback",
        "Respond using deterministic fallback after post-normalization run_skill filtering."
      )
    ],
    usedFallback: true
  };
}

/**
 * Builds the respond fallback used when repair still collapses to non-explicit run_skill output.
 */
export function buildNonExplicitRunSkillFallbackAction(message: string): PlannedAction {
  return buildRespondFallbackAction(
    message,
    "action_non_explicit_run_skill_fallback",
    "Respond using deterministic fallback after filtering non-explicit run_skill actions."
  );
}
