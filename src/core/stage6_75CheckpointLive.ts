/**
 * @fileoverview Executes Stage 6.75 OpenAI live-smoke prompts for interface /review routing.
 */

import path from "node:path";
import {
    OpenAiLiveSmokePrompt,
    runOpenAiLiveSmoke,
    writeOpenAiLiveSmokeArtifact
} from "../tools/openAiLiveSmokeHarness";

export interface Stage675CheckpointReviewResult {
    checkpointId: string;
    overallPass: boolean;
    artifactPath: string;
    summaryLines: readonly string[];
}

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
        prompt: "Capture this browser workflow, compile replay steps, and block if selector drift appears.",
        requiredApprovedActionTypes: ["respond"]
    }
];

/**
 * Executes checkpoint675 live review as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the checkpoint675 live review runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runOpenAiLiveSmoke` (import `runOpenAiLiveSmoke`) from `../tools/openAiLiveSmokeHarness`.
 * - Uses `writeOpenAiLiveSmokeArtifact` (import `writeOpenAiLiveSmokeArtifact`) from `../tools/openAiLiveSmokeHarness`.
 * @returns Promise resolving to Stage675CheckpointReviewResult.
 */
export async function runCheckpoint675LiveReview(): Promise<Stage675CheckpointReviewResult> {
    const artifact = await runOpenAiLiveSmoke({
        stageId: "stage_6_75_governed_operator_capability",
        prompts: STAGE675_SMOKE_PROMPTS,
        artifactPath: ARTIFACT_PATH
    });
    await writeOpenAiLiveSmokeArtifact(ARTIFACT_PATH, artifact);

    const overallPass = artifact.status === "PASS";

    return {
        checkpointId: "6.75",
        overallPass,
        artifactPath: "runtime/evidence/stage6_75_live_smoke_report.json",
        summaryLines: [
            `Stage 6.75 OpenAI live smoke status: ${artifact.status}`,
            `Executed prompts: ${artifact.promptResults.length}`,
            ...artifact.promptResults.map(result => `  - [${result.id}]: SATISFIED=${result.requiredActionTypesSatisfied ? "yes" : "no"} FAILS=${result.executionFailureDetected ? "yes" : "no"}`)
        ]
    };
}
