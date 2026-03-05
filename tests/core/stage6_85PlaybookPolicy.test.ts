/**
 * @fileoverview Tests deterministic Stage 6.85 playbook compilation, hashing, scoring, and fallback-selection behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { verifySchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  compileCandidatePlaybookFromTrace,
  createPlaybookEnvelopeV1,
  scorePlaybookForSelection,
  selectPlaybookDeterministically
} from "../../src/core/stage6_85PlaybookPolicy";

/**
 * Implements `compilesDeterministicPlaybookFromPlannerTrace` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function compilesDeterministicPlaybookFromPlannerTrace(): void {
  const playbook = compileCandidatePlaybookFromTrace({
    traceId: "trace_685_a_001",
    goal: "Build deterministic backup CLI",
    intentTags: ["Build", "CLI", "Build"],
    inputSchema: "build_cli_v1",
    steps: [
      {
        actionFamily: "file_ops",
        operation: "write",
        succeeded: true,
        durationMs: 2200,
        denyCount: 0,
        verificationPassed: true
      },
      {
        actionFamily: "verification",
        operation: "test",
        succeeded: true,
        durationMs: 4800,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });

  assert.equal(playbook.id, "playbook_trace_685_a_001");
  assert.equal(playbook.intentTags.join(","), "build,cli");
  assert.equal(playbook.steps.length, 2);
  assert.equal(playbook.riskProfile, "low");
}

/**
 * Implements `createsSchemaEnvelopeForCompiledPlaybook` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function createsSchemaEnvelopeForCompiledPlaybook(): void {
  const playbook = compileCandidatePlaybookFromTrace({
    traceId: "trace_685_a_002",
    goal: "Compile workflow replay",
    intentTags: ["workflow", "replay"],
    inputSchema: "workflow_replay_v1",
    steps: [
      {
        actionFamily: "computer_use",
        operation: "compile",
        succeeded: true,
        durationMs: 5000,
        denyCount: 1,
        verificationPassed: true
      }
    ]
  });
  const envelope = createPlaybookEnvelopeV1(playbook, "2026-02-27T00:00:00.000Z");
  assert.equal(envelope.schemaName, "PlaybookV1");
  assert.equal(verifySchemaEnvelopeV1(envelope), true);
}

/**
 * Implements `scoresPlaybookSelectionWithDeterministicComponentBreakdown` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function scoresPlaybookSelectionWithDeterministicComponentBreakdown(): void {
  const playbook = compileCandidatePlaybookFromTrace({
    traceId: "trace_685_a_003",
    goal: "Run build workflow",
    intentTags: ["build", "verify"],
    inputSchema: "build_v1",
    steps: [
      {
        actionFamily: "build",
        operation: "compile",
        succeeded: true,
        durationMs: 1500,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });
  const score = scorePlaybookForSelection(
    playbook,
    {
      playbookId: playbook.id,
      passCount: 8,
      failCount: 2,
      lastSuccessAt: "2026-02-26T00:00:00.000Z",
      averageDenyRate: 0.1,
      averageTimeToCompleteMs: 12_000,
      verificationPassRate: 0.9
    },
    ["build", "verify"],
    "build_v1",
    "2026-02-27T00:00:00.000Z"
  );

  assert.equal(score.playbookId, playbook.id);
  assert.ok(score.score > 0.4);
  assert.ok(score.components.successRate > 0.7);
}

/**
 * Implements `selectsHighestScorePlaybookOrFallsBackWhenThresholdNotMet` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function selectsHighestScorePlaybookOrFallsBackWhenThresholdNotMet(): void {
  const strong = compileCandidatePlaybookFromTrace({
    traceId: "trace_685_a_004",
    goal: "Build project",
    intentTags: ["build", "verify"],
    inputSchema: "build_v1",
    steps: [
      {
        actionFamily: "build",
        operation: "compile",
        succeeded: true,
        durationMs: 1000,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });
  const weak = compileCandidatePlaybookFromTrace({
    traceId: "trace_685_a_005",
    goal: "Research project",
    intentTags: ["research"],
    inputSchema: "research_v1",
    steps: [
      {
        actionFamily: "research",
        operation: "gather",
        succeeded: true,
        durationMs: 1000,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });

  const selected = selectPlaybookDeterministically({
    playbooks: [strong, weak],
    signals: [
      {
        playbookId: strong.id,
        passCount: 10,
        failCount: 1,
        lastSuccessAt: "2026-02-27T00:00:00.000Z",
        averageDenyRate: 0,
        averageTimeToCompleteMs: 10_000,
        verificationPassRate: 1
      },
      {
        playbookId: weak.id,
        passCount: 1,
        failCount: 10,
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        averageDenyRate: 0.9,
        averageTimeToCompleteMs: 200_000,
        verificationPassRate: 0.1
      }
    ],
    requestedTags: ["build", "verify"],
    requiredInputSchema: "build_v1",
    nowIso: "2026-02-27T12:00:00.000Z"
  });
  assert.equal(selected.fallbackToPlanner, false);
  assert.equal(selected.selectedPlaybook?.id, strong.id);

  const fallback = selectPlaybookDeterministically({
    playbooks: [weak],
    signals: [
      {
        playbookId: weak.id,
        passCount: 0,
        failCount: 10,
        lastSuccessAt: null,
        averageDenyRate: 1,
        averageTimeToCompleteMs: 250_000,
        verificationPassRate: 0
      }
    ],
    requestedTags: ["build"],
    requiredInputSchema: "build_v1",
    nowIso: "2026-02-27T12:00:00.000Z"
  });
  assert.equal(fallback.fallbackToPlanner, true);
  assert.equal(fallback.selectedPlaybook, null);
}

/**
 * Implements `requiresTagAndSchemaCompatibilityForDeterministicSelection` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function requiresTagAndSchemaCompatibilityForDeterministicSelection(): void {
  const build = compileCandidatePlaybookFromTrace({
    traceId: "trace_685_a_006_build",
    goal: "Build project",
    intentTags: ["build", "verify"],
    inputSchema: "build_v1",
    steps: [
      {
        actionFamily: "build",
        operation: "compile",
        succeeded: true,
        durationMs: 1000,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });
  const research = compileCandidatePlaybookFromTrace({
    traceId: "trace_685_a_006_research",
    goal: "Research controls",
    intentTags: ["research", "security"],
    inputSchema: "research_v1",
    steps: [
      {
        actionFamily: "research",
        operation: "summarize",
        succeeded: true,
        durationMs: 1000,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });

  const selected = selectPlaybookDeterministically({
    playbooks: [build, research],
    signals: [
      {
        playbookId: build.id,
        passCount: 20,
        failCount: 1,
        lastSuccessAt: "2026-02-27T00:00:00.000Z",
        averageDenyRate: 0.01,
        averageTimeToCompleteMs: 8_000,
        verificationPassRate: 0.99
      },
      {
        playbookId: research.id,
        passCount: 6,
        failCount: 2,
        lastSuccessAt: "2026-02-27T00:00:00.000Z",
        averageDenyRate: 0.1,
        averageTimeToCompleteMs: 20_000,
        verificationPassRate: 0.9
      }
    ],
    requestedTags: ["research", "security"],
    requiredInputSchema: "research_v1",
    nowIso: "2026-02-28T12:00:00.000Z"
  });

  assert.equal(selected.fallbackToPlanner, false);
  assert.equal(selected.selectedPlaybook?.id, research.id);
}

test(
  "stage 6.85 playbook policy compiles deterministic candidate playbook contracts from planner traces",
  compilesDeterministicPlaybookFromPlannerTrace
);
test(
  "stage 6.85 playbook policy wraps candidates in schema envelopes with verified canonical hashes",
  createsSchemaEnvelopeForCompiledPlaybook
);
test(
  "stage 6.85 playbook policy computes deterministic selection scores from explicit metrics",
  scoresPlaybookSelectionWithDeterministicComponentBreakdown
);
test(
  "stage 6.85 playbook policy selects best scored playbook and falls back when threshold is not met",
  selectsHighestScorePlaybookOrFallsBackWhenThresholdNotMet
);
test(
  "stage 6.85 playbook policy requires tag/schema compatibility before selecting a playbook",
  requiresTagAndSchemaCompatibilityForDeterministicSelection
);
