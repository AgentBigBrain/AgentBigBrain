/**
 * @fileoverview Shared OpenAI live-smoke harness for stage evidence tools that validates real runtime-path execution.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDefaultBrain } from "../core/buildBrain";
import { ensureEnvLoaded } from "../core/envLoader";
import { ActionRunResult, ActionType, TaskRequest } from "../core/types";

export interface OpenAiLiveSmokePrompt {
  id: string;
  prompt: string;
  requiredApprovedActionTypes?: readonly ActionType[];
}

export interface OpenAiLiveSmokePromptResult {
  id: string;
  prompt: string;
  approvedActionTypes: readonly ActionType[];
  blockedActionTypes: readonly ActionType[];
  blockedBy: readonly string[];
  executionFailureDetected: boolean;
  requiredActionTypesSatisfied: boolean;
  summary: string;
}

export interface OpenAiLiveSmokeArtifact {
  stageId: string;
  generatedAt: string;
  backend: string;
  status: "PASS" | "FAIL" | "NOT_RUN";
  details: string;
  promptResults: readonly OpenAiLiveSmokePromptResult[];
  passCriteria: {
    openAiConfigured: boolean;
    allPromptsExecuted: boolean;
    noExecutionFailures: boolean;
    requiredActionTypesSatisfied: boolean;
    overallPass: boolean;
  };
}

interface OpenAiLiveSmokeRunOptions {
  stageId: string;
  prompts: readonly OpenAiLiveSmokePrompt[];
  artifactPath: string;
}

/**
 * Builds task for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of task consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
 *
 * @param stageId - Stable identifier used to reference an entity or record.
 * @param prompt - Message/text content processed by this function.
 * @param index - Numeric bound, counter, or index used by this logic.
 * @returns Computed `TaskRequest` result.
 */
function buildTask(stageId: string, prompt: OpenAiLiveSmokePrompt, index: number): TaskRequest {
  return {
    id: `${stageId}_openai_live_smoke_${String(index + 1).padStart(2, "0")}_${prompt.id}`,
    goal: prompt.prompt,
    userInput: prompt.prompt,
    createdAt: new Date().toISOString(),
    agentId: "main"
  };
}

/**
 * Evaluates execution failure and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the execution failure policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param actionResult - Action result inspected for runtime execution failure signals.
 * @returns `true` when this check passes.
 */
function detectExecutionFailure(actionResult: ActionRunResult): boolean {
  if (
    actionResult.executionStatus === "failed" ||
    actionResult.executionFailureCode === "ACTION_EXECUTION_FAILED" ||
    actionResult.blockedBy.includes("ACTION_EXECUTION_FAILED") ||
    actionResult.violations.some((violation) => violation.code === "ACTION_EXECUTION_FAILED")
  ) {
    return true;
  }

  const normalized = (actionResult.output ?? "").trim().toLowerCase();
  return normalized.startsWith("run skill failed:");
}

/**
 * Executes open ai live smoke as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the open ai live smoke runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `buildDefaultBrain` (import `buildDefaultBrain`) from `../core/buildBrain`.
 * - Uses `ensureEnvLoaded` (import `ensureEnvLoaded`) from `../core/envLoader`.
 *
 * @param options - Optional tuning knobs for this operation.
 * @returns Promise resolving to OpenAiLiveSmokeArtifact.
 */
export async function runOpenAiLiveSmoke(
  options: OpenAiLiveSmokeRunOptions
): Promise<OpenAiLiveSmokeArtifact> {
  ensureEnvLoaded();
  const backend = (process.env.BRAIN_MODEL_BACKEND ?? "").trim().toLowerCase();
  const hasOpenAiKey =
    typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;
  const openAiConfigured = (backend === "openai" || backend === "openai_api") && hasOpenAiKey;

  if (!openAiConfigured) {
    return {
      stageId: options.stageId,
      generatedAt: new Date().toISOString(),
      backend,
      status: "NOT_RUN",
      details:
        "OpenAI live smoke not executed. Set BRAIN_MODEL_BACKEND=openai_api (or legacy openai) and OPENAI_API_KEY.",
      promptResults: [],
      passCriteria: {
        openAiConfigured: false,
        allPromptsExecuted: false,
        noExecutionFailures: false,
        requiredActionTypesSatisfied: false,
        overallPass: false
      }
    };
  }

  try {
    const brain = buildDefaultBrain();
    const promptResults: OpenAiLiveSmokePromptResult[] = [];
    let allPromptsExecuted = true;
    let noExecutionFailures = true;
    let requiredActionTypesSatisfied = true;

    for (let index = 0; index < options.prompts.length; index += 1) {
      const prompt = options.prompts[index];
      const runResult = await brain.runTask(buildTask(options.stageId, prompt, index));
      const approvedActionTypes = runResult.actionResults
        .filter((result) => result.approved)
        .map((result) => result.action.type);
      const blockedActionTypes = runResult.actionResults
        .filter((result) => !result.approved)
        .map((result) => result.action.type);
      const blockedBy = runResult.actionResults.flatMap((result) => result.blockedBy);
      const executionFailureDetected = runResult.actionResults.some(
        (result) => detectExecutionFailure(result)
      );
      const requiredTypes = prompt.requiredApprovedActionTypes ?? [];
      const promptRequiredActionTypesSatisfied = requiredTypes.every((requiredType) =>
        approvedActionTypes.includes(requiredType)
      );

      if (executionFailureDetected) {
        noExecutionFailures = false;
      }
      if (!promptRequiredActionTypesSatisfied) {
        requiredActionTypesSatisfied = false;
      }

      promptResults.push({
        id: prompt.id,
        prompt: prompt.prompt,
        approvedActionTypes,
        blockedActionTypes,
        blockedBy,
        executionFailureDetected,
        requiredActionTypesSatisfied: promptRequiredActionTypesSatisfied,
        summary: runResult.summary
      });
    }

    const overallPass = allPromptsExecuted && noExecutionFailures && requiredActionTypesSatisfied;
    return {
      stageId: options.stageId,
      generatedAt: new Date().toISOString(),
      backend,
      status: overallPass ? "PASS" : "FAIL",
      details: overallPass
        ? "OpenAI live smoke passed with runtime-path prompt execution."
        : "OpenAI live smoke failed. Review prompt-level execution details.",
      promptResults,
      passCriteria: {
        openAiConfigured: true,
        allPromptsExecuted,
        noExecutionFailures,
        requiredActionTypesSatisfied,
        overallPass
      }
    };
  } catch (error) {
    return {
      stageId: options.stageId,
      generatedAt: new Date().toISOString(),
      backend,
      status: "FAIL",
      details: `OpenAI live smoke failed before completion: ${(error as Error).message}`,
      promptResults: [],
      passCriteria: {
        openAiConfigured: true,
        allPromptsExecuted: false,
        noExecutionFailures: false,
        requiredActionTypesSatisfied: false,
        overallPass: false
      }
    };
  }
}

/**
 * Persists open ai live smoke artifact with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes open ai live smoke artifact mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @param artifact - Value for artifact.
 * @returns Promise resolving to void.
 */
export async function writeOpenAiLiveSmokeArtifact(
  artifactPath: string,
  artifact: OpenAiLiveSmokeArtifact
): Promise<void> {
  const absoluteArtifactPath = path.resolve(process.cwd(), artifactPath);
  await mkdir(path.dirname(absoluteArtifactPath), { recursive: true });
  await writeFile(absoluteArtifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
