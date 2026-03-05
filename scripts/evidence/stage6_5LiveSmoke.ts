/**
 * @fileoverview Executes Stage 6.5 OpenAI live-smoke prompts against runtime paths and writes a reviewer artifact.
 */

import path from "node:path";

import {
  OpenAiLiveSmokePrompt,
  runOpenAiLiveSmoke,
  writeOpenAiLiveSmokeArtifact
} from "../../src/tools/openAiLiveSmokeHarness";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_5_live_smoke_report.json");

const STAGE65_SMOKE_PROMPTS: readonly OpenAiLiveSmokePrompt[] = [
  {
    id: "federated_delegation_prompt",
    prompt:
      "Outline a governed federated delegation approach with deterministic constraints and evidence linkage.",
    requiredApprovedActionTypes: ["respond"]
  },
  {
    id: "clone_workflow_prompt",
    prompt: "Generate two clone-assisted plan variants and merge only safe packets.",
    requiredApprovedActionTypes: ["respond"]
  },
  {
    id: "create_skill",
    prompt: "Create skill stage6_5_openai_smoke_skill for Stage 6.5 live smoke validation.",
    requiredApprovedActionTypes: ["create_skill"]
  },
  {
    id: "run_skill",
    prompt: "Use skill stage6_5_openai_smoke_skill with input: stage 6.5 live smoke.",
    requiredApprovedActionTypes: ["run_skill"]
  }
];

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runOpenAiLiveSmoke({
    stageId: "stage_6_5_advanced_autonomy",
    prompts: STAGE65_SMOKE_PROMPTS,
    artifactPath: ARTIFACT_PATH
  });
  await writeOpenAiLiveSmokeArtifact(ARTIFACT_PATH, artifact);

  console.log(`Stage 6.5 OpenAI live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status !== "PASS" || !artifact.passCriteria.overallPass) {
    console.error(`Stage 6.5 OpenAI live smoke failed: ${artifact.details}`);
    process.exitCode = 1;
  }
}

void main();
