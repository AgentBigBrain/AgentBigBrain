/**
 * @fileoverview Executes Stage 6 OpenAI live-smoke prompts against runtime paths and writes a reviewer artifact.
 */

import path from "node:path";

import {
  OpenAiLiveSmokePrompt,
  runOpenAiLiveSmoke,
  writeOpenAiLiveSmokeArtifact
} from "../../src/tools/openAiLiveSmokeHarness";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_live_smoke_report.json");

const STAGE6_SMOKE_PROMPTS: readonly OpenAiLiveSmokePrompt[] = [
  {
    id: "create_skill",
    prompt: "Create skill stage6_openai_smoke_skill for Stage 6 live smoke validation.",
    requiredApprovedActionTypes: ["create_skill"]
  },
  {
    id: "run_skill",
    prompt: "Use skill stage6_openai_smoke_skill with input: hello stage 6 live smoke.",
    requiredApprovedActionTypes: ["run_skill"]
  },
  {
    id: "respond_only",
    prompt: "Explain in one sentence why governed rollback should fail closed.",
    requiredApprovedActionTypes: ["respond"]
  }
];

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runOpenAiLiveSmoke({
    stageId: "stage_6_autonomy",
    prompts: STAGE6_SMOKE_PROMPTS,
    artifactPath: ARTIFACT_PATH
  });
  await writeOpenAiLiveSmokeArtifact(ARTIFACT_PATH, artifact);

  console.log(`Stage 6 OpenAI live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status !== "PASS" || !artifact.passCriteria.overallPass) {
    console.error(`Stage 6 OpenAI live smoke failed: ${artifact.details}`);
    process.exitCode = 1;
  }
}

void main();
