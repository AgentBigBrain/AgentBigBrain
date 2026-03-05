/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.H UX-rendering checks and emits deterministic evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PulseCandidateV1, ConversationStackV1, PulseDecisionV1 } from "../../src/core/types";
import {
  buildThreadContextStripV1,
  renderPulseSummaryV1,
  shouldRenderPulseDecisionV1
} from "../../src/interfaces/stage6_86UxRendering";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_ux_report.json");

interface Stage686CheckpointHArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.H";
  pulseRendering: {
    includesReasonCodePass: boolean;
    boundedPreviewPass: boolean;
    boundedStructurePass: boolean;
  };
  threadContextStrip: {
    activeThreadPass: boolean;
    pausedThreadCountPass: boolean;
    openLoopCountPass: boolean;
    summaryFormatPass: boolean;
  };
  suppressionSilence: {
    suppressedSilentPass: boolean;
    emitVisiblePass: boolean;
  };
  passCriteria: {
    pulseRenderingPass: boolean;
    threadContextPass: boolean;
    suppressionPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `buildConversationStackFixture` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildConversationStackFixture(): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-01T00:00:00.000Z",
    activeThreadKey: "thread_budget",
    threads: [
      {
        threadKey: "thread_budget",
        topicKey: "topic_budget",
        topicLabel: "Budget runway",
        state: "active",
        resumeHint: "Resume budget assumptions",
        openLoops: [
          {
            loopId: "loop_budget_1",
            threadKey: "thread_budget",
            entityRefs: ["entity_flare_labs"],
            createdAt: "2026-03-01T00:00:00.000Z",
            lastMentionedAt: "2026-03-01T00:00:00.000Z",
            priority: 0.62,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-03-01T00:00:00.000Z"
      },
      {
        threadKey: "thread_research",
        topicKey: "topic_research",
        topicLabel: "Sandboxing research",
        state: "paused",
        resumeHint: "Return to deterministic controls",
        openLoops: [],
        lastTouchedAt: "2026-02-28T00:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "topic_budget",
        label: "Budget runway",
        firstSeenAt: "2026-03-01T00:00:00.000Z",
        lastSeenAt: "2026-03-01T00:00:00.000Z",
        mentionCount: 3
      },
      {
        topicKey: "topic_research",
        label: "Sandboxing research",
        firstSeenAt: "2026-02-28T00:00:00.000Z",
        lastSeenAt: "2026-02-28T00:00:00.000Z",
        mentionCount: 1
      }
    ]
  };
}

/**
 * Implements `buildPulseCandidateFixture` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildPulseCandidateFixture(): PulseCandidateV1 {
  return {
    candidateId: "pulse_candidate_ux",
    reasonCode: "OPEN_LOOP_RESUME",
    score: 0.79,
    scoreBreakdown: {
      recency: 0.81,
      frequency: 0.72,
      unresolvedImportance: 0.78,
      sensitivityPenalty: 0,
      cooldownPenalty: 0
    },
    lastTouchedAt: "2026-03-01T00:00:00.000Z",
    threadKey: "thread_budget",
    entityRefs: ["entity_flare_labs"],
    evidenceRefs: ["trace:pulse_candidate_ux"],
    stableHash: "hash_pulse_candidate_ux"
  };
}

/**
 * Implements `runStage686CheckpointH` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointH(): Promise<Stage686CheckpointHArtifact> {
  const summary = renderPulseSummaryV1({
    candidate: buildPulseCandidateFixture(),
    updatePreview:
      "This is a deliberately long update preview that should be truncated so continuity summaries remain concise and deterministic for stage 6.86 UX rendering.",
    maxPreviewChars: 78
  });
  const summaryLines = summary.split("\n");
  const previewLine = summaryLines.find((line) => line.startsWith("- preview: "));

  const includesReasonCodePass = /reasonCode: OPEN_LOOP_RESUME/.test(summary);
  const boundedPreviewPass = previewLine !== undefined && previewLine.length <= 90;
  const boundedStructurePass = summaryLines.length === 3 && summaryLines[0] === "Continuity pulse:";

  const strip = buildThreadContextStripV1(buildConversationStackFixture());
  const activeThreadPass = strip.activeThreadKey === "thread_budget";
  const pausedThreadCountPass = strip.pausedThreadCount === 1;
  const openLoopCountPass = strip.openLoopCount === 1;
  const summaryFormatPass =
    strip.summaryText === "Thread context: active=Budget runway; paused=1; open_loops=1";

  const suppressedDecision: PulseDecisionV1 = {
    decisionCode: "SUPPRESS",
    candidateId: "pulse_candidate_ux",
    blockCode: "PULSE_BLOCKED",
    blockDetailReason: "PULSE_COOLDOWN_ACTIVE",
    evidenceRefs: ["trace:pulse_suppressed"]
  };
  const emittedDecision: PulseDecisionV1 = {
    decisionCode: "EMIT",
    candidateId: "pulse_candidate_ux",
    blockCode: null,
    blockDetailReason: null,
    evidenceRefs: ["trace:pulse_emitted"]
  };

  const suppressedSilentPass = shouldRenderPulseDecisionV1(suppressedDecision) === false;
  const emitVisiblePass = shouldRenderPulseDecisionV1(emittedDecision) === true;

  const pulseRenderingPass = includesReasonCodePass && boundedPreviewPass && boundedStructurePass;
  const threadContextPass =
    activeThreadPass && pausedThreadCountPass && openLoopCountPass && summaryFormatPass;
  const suppressionPass = suppressedSilentPass && emitVisiblePass;
  const overallPass = pulseRenderingPass && threadContextPass && suppressionPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:ux",
    checkpointId: "6.86.H",
    pulseRendering: {
      includesReasonCodePass,
      boundedPreviewPass,
      boundedStructurePass
    },
    threadContextStrip: {
      activeThreadPass,
      pausedThreadCountPass,
      openLoopCountPass,
      summaryFormatPass
    },
    suppressionSilence: {
      suppressedSilentPass,
      emitVisiblePass
    },
    passCriteria: {
      pulseRenderingPass,
      threadContextPass,
      suppressionPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointH();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.H artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
