/**
 * @fileoverview Executes Stage 6.75 OpenAI live-smoke prompts against runtime paths and writes a reviewer artifact.
 */

import path from "node:path";

import {
  OpenAiLiveSmokePrompt,
  runOpenAiLiveSmoke,
  writeOpenAiLiveSmokeArtifact
} from "../../src/tools/openAiLiveSmokeHarness";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_75_live_smoke_report.json");

const STAGE675_SMOKE_PROMPTS: readonly OpenAiLiveSmokePrompt[] = [
  {
    id: "research_distill",
    prompt: "Research deterministic sandboxing controls and provide distilled findings with proof refs.",
    requiredApprovedActionTypes: ["respond"]
  },
  {
    id: "approval_diff",
    prompt: "Schedule 3 focus blocks next week and show exact approval diff before any write.",
    requiredApprovedActionTypes: ["respond"]
  },
  {
    id: "workflow_drift_guard",
    prompt:
      "As BigBrain (AI agent), provide a deterministic browser workflow replay checklist and explain how selector drift is blocked.",
    requiredApprovedActionTypes: ["respond"]
  }
];

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runOpenAiLiveSmoke({
    stageId: "stage_6_75_governed_operator_capability",
    prompts: STAGE675_SMOKE_PROMPTS,
    artifactPath: ARTIFACT_PATH
  });
  await writeOpenAiLiveSmokeArtifact(ARTIFACT_PATH, artifact);

  console.log(`Stage 6.75 OpenAI live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status !== "PASS" || !artifact.passCriteria.overallPass) {
    console.error(`Stage 6.75 OpenAI live smoke failed: ${artifact.details}`);
    process.exitCode = 1;
  }
}

void main();
