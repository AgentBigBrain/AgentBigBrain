/**
 * @fileoverview Tests deterministic governor drift and disagreement telemetry built from governance-memory events.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGovernorDriftAudit } from "../../src/core/governorDriftAudit";
import { GovernanceMemoryEvent } from "../../src/core/types";

/**
 * Implements `buildGovernanceEvent` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildGovernanceEvent(
  overrides: Partial<GovernanceMemoryEvent>
): GovernanceMemoryEvent {
  const base: GovernanceMemoryEvent = {
    id: "govmem_test_event",
    recordedAt: "2026-02-26T00:00:00.000Z",
    taskId: "task_test",
    proposalId: "proposal_test",
    actionId: "action_test",
    actionType: "respond",
    mode: "fast_path",
    outcome: "approved",
    blockCategory: "none",
    blockedBy: [],
    violationCodes: [],
    yesVotes: 1,
    noVotes: 0,
    threshold: 1,
    dissentGovernorIds: []
  };

  return {
    ...base,
    ...overrides,
    blockedBy: overrides.blockedBy ?? base.blockedBy,
    violationCodes: overrides.violationCodes ?? base.violationCodes,
    dissentGovernorIds: overrides.dissentGovernorIds ?? base.dissentGovernorIds
  };
}

/**
 * Implements `governorDriftAuditComputesRejectAndLoneNoMetrics` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function governorDriftAuditComputesRejectAndLoneNoMetrics(): void {
  const events: GovernanceMemoryEvent[] = [
    buildGovernanceEvent({
      id: "event_1",
      mode: "escalation_path",
      yesVotes: 7,
      noVotes: 0,
      threshold: 6
    }),
    buildGovernanceEvent({
      id: "event_2",
      mode: "escalation_path",
      outcome: "blocked",
      blockCategory: "governance",
      blockedBy: ["logic", "security"],
      yesVotes: 5,
      noVotes: 2,
      threshold: 6,
      dissentGovernorIds: ["logic", "security"]
    }),
    buildGovernanceEvent({
      id: "event_3",
      outcome: "blocked",
      blockCategory: "governance",
      blockedBy: ["security"],
      yesVotes: 0,
      noVotes: 1,
      threshold: 1,
      dissentGovernorIds: ["security"]
    }),
    buildGovernanceEvent({
      id: "event_4",
      mode: "escalation_path",
      outcome: "blocked",
      blockCategory: "constraints",
      blockedBy: ["DELETE_PROTECTED_PATH"],
      violationCodes: ["DELETE_PROTECTED_PATH"],
      yesVotes: 0,
      noVotes: 0,
      threshold: null,
      dissentGovernorIds: []
    })
  ];

  const report = buildGovernorDriftAudit(events, {
    windowSize: 10,
    trendWindowSize: 4,
    minTrendSamples: 1,
    driftThreshold: 0.5
  });

  assert.equal(report.voteEventCount, 3);
  assert.equal(report.disagreementEventCount, 2);
  assert.equal(report.loneNoEventCount, 1);
  assert.equal(report.governorMetrics.security.opportunities, 3);
  assert.equal(report.governorMetrics.security.rejects, 2);
  assert.equal(report.governorMetrics.security.loneNoCount, 1);
  assert.equal(report.governorMetrics.logic.opportunities, 2);
  assert.equal(report.governorMetrics.logic.rejects, 1);
  assert.equal(report.governorMetrics.ethics.rejects, 0);
}

/**
 * Implements `governorDriftAuditDetectsRejectRateTrendShifts` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function governorDriftAuditDetectsRejectRateTrendShifts(): void {
  const events: GovernanceMemoryEvent[] = [];

  for (let index = 0; index < 6; index += 1) {
    events.push(
      buildGovernanceEvent({
        id: `approved_${index}`,
        recordedAt: `2026-02-26T00:00:0${index}.000Z`,
        yesVotes: 1,
        noVotes: 0,
        threshold: 1,
        dissentGovernorIds: []
      })
    );
  }

  for (let index = 0; index < 6; index += 1) {
    events.push(
      buildGovernanceEvent({
        id: `blocked_${index}`,
        recordedAt: `2026-02-26T00:00:1${index}.000Z`,
        outcome: "blocked",
        blockCategory: "governance",
        blockedBy: ["security"],
        yesVotes: 0,
        noVotes: 1,
        threshold: 1,
        dissentGovernorIds: ["security"]
      })
    );
  }

  const report = buildGovernorDriftAudit(events, {
    windowSize: 20,
    trendWindowSize: 12,
    minTrendSamples: 3,
    driftThreshold: 0.5
  });

  assert.equal(report.governorMetrics.security.trend.previousRejectRate, 0);
  assert.equal(report.governorMetrics.security.trend.recentRejectRate, 1);
  assert.equal(report.governorMetrics.security.trend.deltaRejectRate, 1);
  assert.equal(report.governorMetrics.security.trend.driftDetected, true);
  assert.ok(report.flaggedGovernors.includes("security"));
}

/**
 * Implements `governorDriftAuditIncludesCodeReviewIfItAppearsInDissent` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function governorDriftAuditIncludesCodeReviewIfItAppearsInDissent(): void {
  const report = buildGovernorDriftAudit(
    [
      buildGovernanceEvent({
        id: "code_review_dissent_event",
        mode: "escalation_path",
        outcome: "blocked",
        blockCategory: "governance",
        blockedBy: ["codeReview"],
        yesVotes: 6,
        noVotes: 1,
        threshold: 6,
        dissentGovernorIds: ["codeReview"]
      })
    ],
    {
      windowSize: 5,
      trendWindowSize: 2,
      minTrendSamples: 1,
      driftThreshold: 0.5
    }
  );

  assert.equal(report.governorMetrics.codeReview.opportunities, 1);
  assert.equal(report.governorMetrics.codeReview.rejects, 1);
  assert.equal(report.governorMetrics.codeReview.rejectRate, 1);
}

test(
  "governor drift audit computes per-governor reject, disagreement, and lone-no metrics",
  governorDriftAuditComputesRejectAndLoneNoMetrics
);
test(
  "governor drift audit detects reject-rate trend drift on recent windows",
  governorDriftAuditDetectsRejectRateTrendShifts
);
test(
  "governor drift audit includes codeReview metrics when codeReview appears in dissent events",
  governorDriftAuditIncludesCodeReviewIfItAppearsInDissent
);

