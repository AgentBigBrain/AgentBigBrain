/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.D open-loop checks and emits deterministic evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import {
  resolveOpenLoopOnConversationStackV1,
  selectOpenLoopsForPulseV1,
  upsertOpenLoopOnConversationStackV1
} from "../../src/core/stage6_86OpenLoops";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_open_loops_report.json");

interface Stage686CheckpointDArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.D";
  creation: {
    createdLoop: boolean;
    createdLoopId: string | null;
    triggerCode: string | null;
  };
  resumeSelection: {
    selectedCount: number;
    selectedLoopIds: readonly string[];
    staleSuppressedCount: number;
    capSuppressedCount: number;
  };
  resolution: {
    resolved: boolean;
    resolvedLoopId: string | null;
    resolvedExcludedFromSelection: boolean;
  };
  passCriteria: {
    creationPass: boolean;
    resumePolicyPass: boolean;
    resolutionPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage686CheckpointD` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointD(): Promise<Stage686CheckpointDArtifact> {
  const seeded = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review sprint backlog priorities.",
        at: "2026-01-01T09:00:00.000Z"
      },
      {
        role: "user",
        text: "Switch to budget forecast assumptions.",
        at: "2026-03-01T09:00:00.000Z"
      }
    ],
    "2026-03-01T09:00:00.000Z"
  );
  const sprintThread = seeded.threads.find((thread) => thread.topicKey.includes("sprint"));
  const budgetThread = seeded.threads.find((thread) => thread.topicKey.includes("budget"));
  if (!sprintThread || !budgetThread) {
    throw new Error("Checkpoint 6.86.D requires deterministic sprint/budget thread derivation.");
  }

  const staleLoopMutation = upsertOpenLoopOnConversationStackV1({
    stack: seeded,
    threadKey: sprintThread.threadKey,
    text: "Still need to decide sprint overflow policy.",
    observedAt: "2026-01-01T09:05:00.000Z",
    priorityHint: 0.6
  });
  const freshLoopMutation = upsertOpenLoopOnConversationStackV1({
    stack: staleLoopMutation.stack,
    threadKey: budgetThread.threadKey,
    text: "Remind me later to confirm budget runway assumptions.",
    observedAt: "2026-03-01T09:05:00.000Z",
    priorityHint: 0.61
  });
  const creationLoop = freshLoopMutation.loop;

  const selection = selectOpenLoopsForPulseV1(
    freshLoopMutation.stack,
    "2026-03-15T09:00:00.000Z",
    {
      maxOpenLoopsSurfaced: 1,
      openLoopStaleDays: 30,
      freshPriorityThreshold: 0.35,
      stalePriorityThreshold: 0.7
    }
  );

  const resolvedMutation = creationLoop
    ? resolveOpenLoopOnConversationStackV1({
      stack: freshLoopMutation.stack,
      threadKey: creationLoop.threadKey,
      loopId: creationLoop.loopId,
      observedAt: "2026-03-16T09:00:00.000Z"
    })
    : {
      stack: freshLoopMutation.stack,
      resolved: false,
      loop: null
    };

  const postResolveSelection = selectOpenLoopsForPulseV1(
    resolvedMutation.stack,
    "2026-03-17T09:00:00.000Z",
    {
      maxOpenLoopsSurfaced: 1,
      openLoopStaleDays: 30,
      freshPriorityThreshold: 0.35,
      stalePriorityThreshold: 0.7
    }
  );

  const creationPass =
    freshLoopMutation.created &&
    freshLoopMutation.triggerCode === "DEFERRED_QUESTION" &&
    Boolean(creationLoop?.loopId);
  const resumePolicyPass =
    selection.selected.length === 1 &&
    selection.suppressed.some((candidate) => candidate.suppressionReason === "STALE_PRIORITY_TOO_LOW");
  const resolutionPass =
    resolvedMutation.resolved &&
    Boolean(resolvedMutation.loop?.loopId) &&
    !postResolveSelection.selected.some((candidate) => candidate.loopId === resolvedMutation.loop?.loopId);
  const overallPass = creationPass && resumePolicyPass && resolutionPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:open_loops",
    checkpointId: "6.86.D",
    creation: {
      createdLoop: freshLoopMutation.created,
      createdLoopId: creationLoop?.loopId ?? null,
      triggerCode: freshLoopMutation.triggerCode
    },
    resumeSelection: {
      selectedCount: selection.selected.length,
      selectedLoopIds: selection.selected.map((candidate) => candidate.loopId),
      staleSuppressedCount: selection.suppressed.filter(
        (candidate) => candidate.suppressionReason === "STALE_PRIORITY_TOO_LOW"
      ).length,
      capSuppressedCount: selection.suppressed.filter(
        (candidate) => candidate.suppressionReason === "OPEN_LOOP_CAP_REACHED"
      ).length
    },
    resolution: {
      resolved: resolvedMutation.resolved,
      resolvedLoopId: resolvedMutation.loop?.loopId ?? null,
      resolvedExcludedFromSelection:
        resolvedMutation.loop !== null &&
        !postResolveSelection.selected.some((candidate) => candidate.loopId === resolvedMutation.loop?.loopId)
    },
    passCriteria: {
      creationPass,
      resumePolicyPass,
      resolutionPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointD();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.D artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
