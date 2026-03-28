/**
 * @fileoverview Tests canonical profile-memory state normalization helpers behind the runtime subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeProfileMemoryState,
  safeIsoOrNow
} from "../../src/core/profileMemoryRuntime/profileMemoryStateNormalization";

test("safeIsoOrNow falls back to a valid ISO timestamp for invalid input", () => {
  const normalized = safeIsoOrNow("not-a-date");
  assert.equal(Number.isFinite(Date.parse(normalized)), true);
});

test("normalizeProfileMemoryState drops malformed facts and preserves valid mutation audit metadata", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-03-07T00:00:00.000Z",
    episodes: [
      {
        id: "episode_valid",
        title: "Owen fall situation",
        summary: "Owen fell down and the outcome was not mentioned yet.",
        status: "unresolved",
        sourceTaskId: "task_episode_state_normalization",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.85,
        observedAt: "2026-03-07T00:00:00.000Z",
        lastMentionedAt: "2026-03-07T00:05:00.000Z",
        lastUpdatedAt: "2026-03-07T00:05:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["loop_owen"],
        tags: ["followup"]
      },
      {
        id: 5,
        title: "bad episode"
      }
    ],
    facts: [
      {
        id: "fact_valid",
        key: "followup.tax.filing",
        value: "resolved",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_state_normalization",
        source: "test",
        observedAt: "2026-03-07T00:00:00.000Z",
        confirmedAt: "2026-03-07T00:00:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-03-07T00:00:00.000Z",
        mutationAudit: {
          classifier: "commitment_signal",
          category: "TOPIC_RESOLUTION_CANDIDATE",
          confidenceTier: "HIGH",
          matchedRuleId: "rule_1",
          rulepackVersion: "CommitmentSignalRulepackV1",
          conflict: false
        }
      },
      {
        id: 5,
        key: "bad.fact"
      }
    ]
  });

  assert.equal(normalized.facts.length, 1);
  assert.equal(normalized.episodes.length, 1);
  assert.equal(normalized.episodes[0]?.title, "Owen fall situation");
  assert.equal(normalized.facts[0]?.key, "followup.tax.filing");
  assert.equal(
    normalized.facts[0]?.mutationAudit?.rulepackVersion,
    "CommitmentSignalRulepackV1"
  );
});
