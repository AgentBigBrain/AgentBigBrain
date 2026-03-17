/**
 * @fileoverview Synthesizes bounded direct conversation replies without touching task-run durability.
 */

import { MAIN_AGENT_ID } from "../../core/agentIdentity";
import { createBrainConfigFromEnv } from "../../core/config";
import { makeId } from "../../core/ids";
import { selectModelForRole } from "../../core/modelRouting";
import type { TaskRequest } from "../../core/types";
import { stripLabelStyleOpening } from "../userFacing/languageSurface";
import { createModelClientFromEnv } from "../../models/createModelClient";
import type { ResponseSynthesisModelOutput } from "../../models/types";

function buildDirectConversationTask(
  input: string,
  receivedAt: string
): TaskRequest {
  return {
    id: makeId("task"),
    agentId: MAIN_AGENT_ID,
    goal:
      "Reply naturally and directly to the user's conversational turn using the provided chat context when available.",
    userInput: input.trim(),
    createdAt: receivedAt
  };
}

/**
 * Generates a direct conversational reply through the model synthesizer path only.
 *
 * **Why it exists:**
 * Ordinary greetings and identity questions should stay model-authored, but they should not depend
 * on the full task-run durability path or shared `runtime/state.json` lock just to answer small
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
  const normalizedInput = input.trim();
  if (!normalizedInput) {
    return "";
  }

  const config = createBrainConfigFromEnv();
  const modelClient = createModelClientFromEnv();
  const task = buildDirectConversationTask(normalizedInput, receivedAt);
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
      "Answer the user's current conversational turn itself. " +
      "If they want to pause work and chat for a minute, do that instead of continuing the previous workflow output. " +
      "Do not restate, continue, or paraphrase the last workflow summary unless the user explicitly asks about that work. " +
      "Respect explicit format requests like replying in two short paragraphs. If the user explicitly asks for two short paragraphs, your reply must be exactly two short paragraphs separated by one blank line. " +
      "Do not refer to yourself in third person or by name unless the user explicitly asked for that style. " +
      "Do not use stiff phrases like 'this AI assistant' or mention internal systems, schemas, or policy machinery.",
    userPrompt: JSON.stringify({
      taskId: task.id,
      goal: task.goal,
      userInput: task.userInput
    })
  });
  const message = typeof output.message === "string" ? output.message.trim() : "";
  if (!message) {
    throw new Error("Direct conversation reply synthesis returned an empty message.");
  }
  return stripLabelStyleOpening(message);
}
