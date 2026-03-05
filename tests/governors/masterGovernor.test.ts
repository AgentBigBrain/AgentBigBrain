/**
 * @fileoverview Tests master-governor vote threshold aggregation behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MasterGovernor } from "../../src/governors/masterGovernor";
import { GovernorVote } from "../../src/core/types";

test("MasterGovernor approves when yes votes meet threshold", () => {
  const governor = new MasterGovernor(6);
  const votes: GovernorVote[] = [
    { governorId: "ethics", approve: true, reason: "ok", confidence: 1 },
    { governorId: "logic", approve: true, reason: "ok", confidence: 1 },
    { governorId: "resource", approve: true, reason: "ok", confidence: 1 },
    { governorId: "security", approve: true, reason: "ok", confidence: 1 },
    { governorId: "continuity", approve: true, reason: "ok", confidence: 1 },
    { governorId: "utility", approve: true, reason: "ok", confidence: 1 },
    { governorId: "compliance", approve: false, reason: "no", confidence: 1 }
  ];

  const decision = governor.review(votes);
  assert.equal(decision.approved, true);
  assert.equal(decision.yesVotes, 6);
  assert.equal(decision.noVotes, 1);
});

test("MasterGovernor rejects when yes votes are below threshold", () => {
  const governor = new MasterGovernor(6);
  const votes: GovernorVote[] = [
    { governorId: "ethics", approve: true, reason: "ok", confidence: 1 },
    { governorId: "logic", approve: true, reason: "ok", confidence: 1 },
    { governorId: "resource", approve: true, reason: "ok", confidence: 1 },
    { governorId: "security", approve: true, reason: "ok", confidence: 1 },
    { governorId: "continuity", approve: true, reason: "ok", confidence: 1 },
    { governorId: "utility", approve: false, reason: "no", confidence: 1 },
    { governorId: "compliance", approve: false, reason: "no", confidence: 1 }
  ];

  const decision = governor.review(votes);
  assert.equal(decision.approved, false);
  assert.equal(decision.yesVotes, 5);
  assert.equal(decision.noVotes, 2);
  assert.equal(decision.dissent.length, 2);
});

test("MasterGovernor approves when all 7 governors approve", () => {
  const governor = new MasterGovernor(6);
  const votes: GovernorVote[] = [
    { governorId: "ethics", approve: true, reason: "ok", confidence: 1 },
    { governorId: "logic", approve: true, reason: "ok", confidence: 1 },
    { governorId: "resource", approve: true, reason: "ok", confidence: 1 },
    { governorId: "security", approve: true, reason: "ok", confidence: 1 },
    { governorId: "continuity", approve: true, reason: "ok", confidence: 1 },
    { governorId: "utility", approve: true, reason: "ok", confidence: 1 },
    { governorId: "compliance", approve: true, reason: "ok", confidence: 1 }
  ];

  const decision = governor.review(votes);
  assert.equal(decision.approved, true);
  assert.equal(decision.yesVotes, 7);
  assert.equal(decision.noVotes, 0);
  assert.equal(decision.dissent.length, 0);
});

