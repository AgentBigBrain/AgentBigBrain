/**
 * @fileoverview Failure-side reflection lesson extraction using the structured model contract.
 */

import { TaskRunResult } from "../../core/types";
import { ModelClient, ReflectionModelOutput } from "../../models/types";

/**
 * Requests concise failure lessons from the reflection model.
 *
 * **Why it exists:**
 * Keeps failure-side prompt construction out of the stable `reflection.ts` coordinator so the
 * model-facing contract has one obvious home.
 *
 * **What it talks to:**
 * - Uses `ModelClient.completeJson` with the `reflection_v1` schema.
 * - Reads blocked action evidence from `TaskRunResult`.
 *
 * @param modelClient - Structured model client used for reflection.
 * @param runResult - Completed run that produced blocked actions.
 * @param blockedActions - Blocked action results to summarize for the model.
 * @param model - Model identifier used for the structured completion.
 * @returns Extracted lessons or `null` when the model call fails.
 */
export async function extractFailureLessons(
  modelClient: ModelClient,
  runResult: TaskRunResult,
  blockedActions: TaskRunResult["actionResults"],
  model: string
): Promise<readonly string[] | null> {
  let output: ReflectionModelOutput;
  try {
    output = await modelClient.completeJson<ReflectionModelOutput>({
      model,
      schemaName: "reflection_v1",
      temperature: 0.2,
      systemPrompt:
        "You are a reflection engine. Analyze the failed/blocked actions of the given task run. " +
        "Extract 1 or 2 concise lessons learned that would prevent these failures in the future. " +
        "Return JSON with a `lessons` array of strings.",
      userPrompt: JSON.stringify({
        goal: runResult.task.goal,
        summary: runResult.summary,
        blockedActions: blockedActions.map((result) => ({
          type: result.action.type,
          description: result.action.description,
          blockedBy: result.blockedBy,
          violations: result.violations
        }))
      })
    });
  } catch (error) {
    console.error(`[Reflection] Model call failed: ${(error as Error).message}`);
    return null;
  }

  console.log(
    `[Reflection] Extracted ${output.lessons.length} lessons from ${blockedActions.length} blocked actions.`
  );
  return output.lessons;
}
