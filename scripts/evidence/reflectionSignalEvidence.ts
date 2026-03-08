/**
 * @fileoverview Emits deterministic sample evidence for reflection lesson-signal classification decisions.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ActionRunResult, TaskRunResult } from "../../src/core/types";
import {
  LessonSignalRulepackV1,
  ReflectionLessonSource
} from "../../src/organs/reflectionRuntime/contracts";
import {
  classifyLessonSignal,
} from "../../src/organs/reflectionRuntime/signalClassification";

interface ReflectionSignalEvidenceSample {
  lesson: string;
  source: ReflectionLessonSource;
  existingLessonCount: number;
  result: ReturnType<typeof classifyLessonSignal>;
}

interface ReflectionSignalEvidenceArtifact {
  schemaVersion: 1;
  generatedAt: string;
  rulepackVersion: string;
  samples: ReflectionSignalEvidenceSample[];
}

const EVIDENCE_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/reflection_signal_classification_sample.json"
);

/**
 * Implements `buildRunResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRunResult(actionResults: ActionRunResult[]): TaskRunResult {
  const nowIso = new Date().toISOString();
  return {
    task: {
      id: "task_reflection_signal_evidence",
      goal: "Persist reflection lessons only when they are operationally useful.",
      userInput: "Summarize blocked safety paths without generic communication advice.",
      createdAt: nowIso
    },
    plan: {
      taskId: "task_reflection_signal_evidence",
      plannerNotes: "reflection signal evidence",
      actions: actionResults.map((result) => result.action)
    },
    actionResults,
    summary: "reflection signal evidence summary",
    startedAt: nowIso,
    completedAt: nowIso
  };
}

/**
 * Implements `buildArtifact` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildArtifact(): ReflectionSignalEvidenceArtifact {
  const runResult = buildRunResult([
    {
      action: {
        id: "action_reflection_signal_evidence",
        type: "delete_file",
        description: "delete outside sandbox path",
        params: { path: "C:/unsafe.txt" },
        estimatedCostUsd: 0.1
      },
      mode: "escalation_path",
      approved: false,
      blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
      violations: [{ code: "DELETE_OUTSIDE_SANDBOX", message: "blocked" }],
      votes: []
    }
  ]);

  const samples: ReflectionSignalEvidenceSample[] = [
    {
      lesson: "Prioritizing user engagement through a friendly greeting enhances the overall user experience.",
      source: "success",
      existingLessonCount: 0,
      result: classifyLessonSignal(
        "Prioritizing user engagement through a friendly greeting enhances the overall user experience.",
        {
          runResult,
          source: "success",
          existingLessons: []
        }
      )
    },
    {
      lesson: "Validate delete path constraints before execution to prevent unsafe filesystem side effects.",
      source: "failure",
      existingLessonCount: 0,
      result: classifyLessonSignal(
        "Validate delete path constraints before execution to prevent unsafe filesystem side effects.",
        {
          runResult,
          source: "failure",
          existingLessons: []
        }
      )
    },
    {
      lesson: "Ensure delete actions validate sandbox paths before execution.",
      source: "failure",
      existingLessonCount: 1,
      result: classifyLessonSignal(
        "Ensure delete actions validate sandbox paths before execution.",
        {
          runResult,
          source: "failure",
          existingLessons: [
            "Validate sandbox path before delete action execution to prevent escapes."
          ]
        }
      )
    }
  ];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rulepackVersion: LessonSignalRulepackV1.version,
    samples
  };
}

/**
 * Implements `runReflectionSignalEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runReflectionSignalEvidence(): Promise<void> {
  const artifact = buildArtifact();
  await mkdir(path.dirname(EVIDENCE_OUTPUT_PATH), { recursive: true });
  await writeFile(EVIDENCE_OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Reflection signal classifier artifact: ${EVIDENCE_OUTPUT_PATH}`);
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  await runReflectionSignalEvidence();
}

if (require.main === module) {
  void main();
}
