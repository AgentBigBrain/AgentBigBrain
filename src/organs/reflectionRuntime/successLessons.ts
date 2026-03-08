/**
 * @fileoverview Success-side reflection lesson extraction using the structured model contract.
 */

import { TaskRunResult } from "../../core/types";
import { ModelClient, SuccessReflectionModelOutput } from "../../models/types";

export interface ExtractedSuccessReflection {
  lesson: string;
  nearMiss: string | null;
}

/**
 * Requests the success reflection payload for a completed task run.
 *
 * **Why it exists:**
 * Keeps success-side prompt construction and model interaction out of `reflection.ts` so the
 * stable coordinator only owns persistence and routing.
 *
 * **What it talks to:**
 * - Uses `ModelClient.completeJson` with the `reflection_success_v1` schema.
 * - Reads approved action evidence from `TaskRunResult`.
 *
 * @param modelClient - Structured model client used for reflection.
 * @param runResult - Completed successful task run.
 * @param model - Model identifier used for the structured completion.
 * @returns Extracted success lesson payload or `null` when the model call fails.
 */
export async function extractSuccessReflection(
  modelClient: ModelClient,
  runResult: TaskRunResult,
  model: string
): Promise<ExtractedSuccessReflection | null> {
  let output: SuccessReflectionModelOutput;
  try {
    output = await modelClient.completeJson<SuccessReflectionModelOutput>({
      model,
      schemaName: "reflection_success_v1",
      temperature: 0.1,
      systemPrompt:
        "You are a reflection engine. Analyze this fully successful task run. " +
        "Extract exactly 1 concise lesson about what key insight or approach made it succeed. " +
        "If something almost went wrong, note the near-miss. Return JSON with `lesson` " +
        "(string) and `nearMiss` (string or null).",
      userPrompt: JSON.stringify({
        goal: runResult.task.goal,
        summary: runResult.summary,
        approvedActions: runResult.actionResults.map((result) => ({
          type: result.action.type,
          description: result.action.description
        }))
      })
    });
  } catch (error) {
    console.error(`[Reflection] Success reflection model call failed: ${(error as Error).message}`);
    return null;
  }

  console.log("[Reflection] Extracted success lesson from completed task.");
  return output;
}
