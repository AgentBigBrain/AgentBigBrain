/**
 * @fileoverview Tests deterministic safety filtering for personality profile updates.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applySafePersonalityUpdate,
  buildPersonalityRewardEvaluation,
  createDefaultPersonalityProfile
} from "../../src/core/personality";

test("applies allowed personality trait adjustments", () => {
  const current = createDefaultPersonalityProfile();
  const result = applySafePersonalityUpdate(current, {
    tone: "direct",
    traitAdjustments: {
      clarity: 0.95,
      discipline: 0.9
    }
  });

  assert.equal(result.profile.tone, "direct");
  assert.equal(result.profile.traits.clarity, 0.95);
  assert.equal(result.profile.traits.discipline, 0.9);
  assert.deepEqual(result.rejectedTraits, []);
});

test("rejects banned and unknown personality traits", () => {
  const current = createDefaultPersonalityProfile();
  const result = applySafePersonalityUpdate(current, {
    traitAdjustments: {
      manipulative: 1,
      chaos: 1
    }
  });

  assert.equal(result.acceptedTraits.length, 0);
  assert.ok(result.rejectedTraits.includes("manipulative"));
  assert.ok(result.rejectedTraits.includes("chaos"));
  assert.equal(result.profile.traits.manipulative, undefined);
});

test("clamps allowed trait values to safe range", () => {
  const current = createDefaultPersonalityProfile();
  const result = applySafePersonalityUpdate(current, {
    traitAdjustments: {
      clarity: 2,
      patience: -1
    }
  });

  assert.equal(result.profile.traits.clarity, 1);
  assert.equal(result.profile.traits.patience, 0);
});

test("rewards only allowed traits from safe approvals", () => {
  const current = createDefaultPersonalityProfile();
  const evaluation = buildPersonalityRewardEvaluation(current, {
    task: {
      id: "task_1",
      goal: "safe reward",
      userInput: "status",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_1",
      plannerNotes: "plan",
      actions: [
        {
          id: "action_1",
          type: "respond",
          description: "respond",
          params: {},
          estimatedCostUsd: 0.01
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_1",
          type: "respond",
          description: "respond",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "ok",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  assert.ok(evaluation.rewardedTraits.includes("clarity"));
  assert.ok(evaluation.rewardedTraits.includes("discipline"));
  assert.equal(evaluation.rewardedTraits.includes("manipulative"), false);
});

test("dampens initiative when safety blocks occur", () => {
  const current = createDefaultPersonalityProfile();
  const evaluation = buildPersonalityRewardEvaluation(current, {
    task: {
      id: "task_2",
      goal: "blocked action",
      userInput: "delete outside sandbox",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_2",
      plannerNotes: "plan",
      actions: [
        {
          id: "action_2",
          type: "delete_file",
          description: "delete",
          params: { path: "C:/outside.txt" },
          estimatedCostUsd: 0.1
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_2",
          type: "delete_file",
          description: "delete",
          params: { path: "C:/outside.txt" },
          estimatedCostUsd: 0.1
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
        violations: [
          {
            code: "DELETE_OUTSIDE_SANDBOX",
            message: "blocked"
          }
        ],
        votes: []
      }
    ],
    summary: "blocked",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const nextInitiative = evaluation.proposal.traitAdjustments?.initiative;
  assert.equal(typeof nextInitiative, "number");
  assert.ok((nextInitiative as number) < current.traits.initiative);
});
