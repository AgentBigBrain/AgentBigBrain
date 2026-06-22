/**
 * @fileoverview Synthesizes bounded direct conversation replies without touching task run durability.
 */

import { MAIN_AGENT_ID } from "../../core/agentIdentity";
import { createBrainConfigFromEnv, type BrainConfig } from "../../core/config";
import { makeId } from "../../core/ids";
import { selectModelForRole } from "../../core/modelRouting";
import type { TaskRequest } from "../../core/types";
import { stripLabelStyleOpening } from "../userFacing/languageSurface";
import { createModelClientFromEnv } from "../../models/createModelClient";
import type { ModelClient, ResponseSynthesisModelOutput } from "../../models/types";
import {
  renderPrincipalAccessForModelPrompt,
  type PrincipalAccessEnvelope
} from "../principalRuntime/principalAccess";

/**
 * Builds the synthetic task envelope used for direct conversational replies.
 *
 * **Why it exists:**
 * Direct chat uses the model synthesizer path without the full governed task runner, but it still
 * needs task-shaped metadata so downstream prompt construction can carry operation-scoped principal
 * access.
 *
 * **What it talks to:**
 * - Uses `makeId` (import `makeId`) from `../../core/ids`.
 * - Uses `MAIN_AGENT_ID` (import `MAIN_AGENT_ID`) from `../../core/agentIdentity`.
 *
 * @param input - Current conversational turn.
 * @param receivedAt - Timestamp used for deterministic task metadata.
 * @param principalAccess - Optional direct-reply principal envelope scoped to this request.
 * @returns Synthetic task request consumed by direct reply prompt construction.
 */
function buildDirectConversationTask(
  input: string,
  receivedAt: string,
  principalAccess?: PrincipalAccessEnvelope | null
): TaskRequest {
  return {
    id: makeId("task"),
    agentId: MAIN_AGENT_ID,
    goal:
      "Reply naturally and directly to the user's conversational turn using the provided chat context when available.",
    userInput: input.trim(),
    createdAt: receivedAt,
    principalAccess: principalAccess ?? undefined
  };
}

/**
 * Generates a direct conversational reply through the model synthesizer path only.
 *
 * **Why it exists:**
 * Ordinary greetings and identity questions should stay model-authored, but they should not depend
 * on the full task run durability path or shared `runtime/state.json` lock just to answer small
 * talk.
 *
 * @param input - Current conversational turn, optionally including bounded chat context.
 * @param receivedAt - Timestamp used for deterministic synthetic task metadata.
 * @returns User-facing conversational reply text.
 */
export async function runDirectConversationReply(
  input: string,
  receivedAt: string
): Promise<string> {
  return runDirectConversationReplyWithRuntime(
    input,
    receivedAt,
    createBrainConfigFromEnv(),
    createModelClientFromEnv()
  );
}

/**
 * Generates a direct conversational reply using the provided runtime configuration and model client.
 *
 * @param input - Current conversational turn, optionally including bounded chat context.
 * @param receivedAt - Timestamp used for deterministic synthetic task metadata.
 * @param config - Brain config whose routing determines the synthesizer model.
 * @param modelClient - Model client bound to the requested backend.
 * @param principalAccess - Optional direct-reply principal envelope to render as redacted labels.
 * @returns User-facing conversational reply text.
 */
export async function runDirectConversationReplyWithRuntime(
  input: string,
  receivedAt: string,
  config: BrainConfig,
  modelClient: ModelClient,
  principalAccess?: PrincipalAccessEnvelope | null
): Promise<string> {
  const normalizedInput = input.trim();
  if (!normalizedInput) {
    return "";
  }

  const task = buildDirectConversationTask(normalizedInput, receivedAt, principalAccess);
  const modelPrincipalAccess = renderPrincipalAccessForModelPrompt(principalAccess);
  const output = await modelClient.completeJson<ResponseSynthesisModelOutput>({
    model: selectModelForRole("synthesizer", config),
    schemaName: "response_v1",
    temperature: 0.3,
    systemPrompt:
      "You are BigBrain, replying to a short conversational turn in a private chat. " +
      "Return JSON with one key: message. " +
      "Reply naturally, briefly, and like a normal conversation. " +
      "You may speak in first person. " +
      "If the user asks your name or what to call you, answering with 'BigBrain' is appropriate. " +
      "If the user asks what you are, answer plainly without pretending to be human. " +
      "If the provided prompt includes known identity facts about the user, answer self-identity questions from those facts. " +
      "If the prompt only includes a low-confidence transport identity hint, you may mention it cautiously as a transport/profile hint rather than confirmed memory. " +
      "If the prompt includes Current-speaker name resolution context, treat the matched name according to the provided resolved scope rather than as a separate person by default. " +
      "Do not say you only know the user's name 'from this chat' when the prompt already gives you a concrete identity fact. " +
      "Answer the user's current conversational turn itself. " +
      "If they want to pause work and chat for a minute, do that instead of continuing the previous workflow output. " +
      "Do not restate, continue, or paraphrase the last workflow summary unless the user explicitly asks about that work. " +
      "Respect explicit format requests like replying in two short paragraphs. If the user explicitly asks for two short paragraphs, your reply must be exactly two short paragraphs separated by one blank line. " +
      "Do not refer to yourself in third person or by name unless the user explicitly asked for that style. " +
      "Do not use stiff phrases like 'this AI assistant' or mention internal systems, schemas, or policy machinery.",
    userPrompt: JSON.stringify({
      taskId: task.id,
      goal: task.goal,
      userInput: task.userInput,
      principalAccess: modelPrincipalAccess
    })
  });
  const message = typeof output.message === "string" ? output.message.trim() : "";
  if (!message) {
    throw new Error("Direct conversation reply synthesis returned an empty message.");
  }
  return stripLabelStyleOpening(message);
}
