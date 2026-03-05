/**
 * @fileoverview Executes a guarded Stage 4 live smoke run for OpenAI integration and writes a reviewer artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { createModelClientFromEnv } from "../../src/models/createModelClient";
import { PlannerModelOutput } from "../../src/models/types";

const LIVE_SMOKE_PATH = path.resolve(process.cwd(), "runtime/evidence/stage4_live_smoke.md");

interface SmokeResult {
  status: "PASS" | "FAIL" | "NOT_RUN";
  details: string;
}

/**
 * Implements `runSmoke` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runSmoke(): Promise<SmokeResult> {
  ensureEnvLoaded();
  const backend = (process.env.BRAIN_MODEL_BACKEND ?? "").trim().toLowerCase();
  const hasApiKey = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;

  if (backend !== "openai" || !hasApiKey) {
    return {
      status: "NOT_RUN",
      details:
        "Live smoke not executed. Set BRAIN_MODEL_BACKEND=openai and OPENAI_API_KEY to run this manual checkpoint."
    };
  }

  try {
    const config = createBrainConfigFromEnv(process.env);
    const client = createModelClientFromEnv();
    const model = config.routing.planner.primary;

    const output = await client.completeJson<PlannerModelOutput>({
      model,
      schemaName: "planner_v1",
      temperature: 0,
      systemPrompt:
        "You are a planner. Return compact JSON with plannerNotes and actions.",
      userPrompt: JSON.stringify({
        taskId: "stage4_live_smoke",
        goal: "Validate provider wiring",
        userInput: "Provide one safe response action."
      })
    });

    const validActions = Array.isArray(output.actions);
    if (!validActions) {
      return {
        status: "FAIL",
        details: "Provider returned invalid planner payload (actions is not an array)."
      };
    }

    return {
      status: "PASS",
      details: `Live smoke succeeded with backend=${client.backend}, model=${model}, actions=${output.actions.length}.`
    };
  } catch (error) {
    return {
      status: "FAIL",
      details: `Live smoke failed: ${(error as Error).message}`
    };
  }
}

/**
 * Implements `renderReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderReport(result: SmokeResult, generatedAt: string): string {
  return [
    "# Stage 4 Live Smoke Report",
    "",
    `- Generated At: ${generatedAt}`,
    `- Status: ${result.status}`,
    "",
    "## Details",
    result.details,
    "",
    "## Guardrails",
    "1. This smoke test is manual-only and does not award checkpoints automatically.",
    "2. Run only with explicit OpenAI credentials and reviewer oversight.",
    "3. Any FAIL result blocks checkpoint 4.5 approval until resolved.",
    ""
  ].join("\n");
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const result = await runSmoke();
  const generatedAt = new Date().toISOString();
  await mkdir(path.dirname(LIVE_SMOKE_PATH), { recursive: true });
  await writeFile(LIVE_SMOKE_PATH, renderReport(result, generatedAt), "utf8");

  console.log(`Stage 4 live smoke status: ${result.status}`);
  console.log(`Artifact: ${LIVE_SMOKE_PATH}`);
}

void main();
