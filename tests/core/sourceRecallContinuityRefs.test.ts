/**
 * @fileoverview Tests Source Recall refs on continuity, graph, and workflow evidence surfaces.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EntityGraphStore } from "../../src/core/entityGraphStore";
import {
  buildConversationStackFromTurnsV1
} from "../../src/core/stage6_86ConversationStack";
import { upsertOpenLoopOnConversationStackV1 } from "../../src/core/stage6_86OpenLoops";
import { applyWorkflowObservationMetadata } from "../../src/core/workflowLearningRuntime/patternLifecycle";
import type { WorkflowObservation, WorkflowPattern } from "../../src/core/types";
import {
  buildSourceRecallEvidenceRef,
  buildSourceRecallSourceRef,
  isSourceRecallEvidenceRef
} from "../../src/core/sourceRecall/sourceRecallMemoryBridge";

test("Source Recall evidence refs contain ids only and can be detected", () => {
  const evidenceRef = buildSourceRecallEvidenceRef(
    buildSourceRecallSourceRef("source_record_continuity", "chunk_continuity")
  );

  assert.equal(evidenceRef, "source_recall:source_record_continuity#chunk_continuity");
  assert.equal(isSourceRecallEvidenceRef(evidenceRef), true);
  assert.equal(evidenceRef.includes("quoted text"), false);
});

test("EntityGraphStore can attach Source Recall evidence refs without recall-only graph truth", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-graph-"));
  const graphPath = path.join(tempDir, "entity_graph.json");
  const store = new EntityGraphStore(graphPath, { backend: "json" });
  const evidenceRef = buildSourceRecallEvidenceRef(
    buildSourceRecallSourceRef("source_record_graph", "chunk_graph")
  );

  try {
    const recallOnly = await store.upsertFromExtractionInput({
      text: "",
      observedAt: "2026-05-03T19:00:00.000Z",
      evidenceRef,
      domainHint: "workflow"
    });
    assert.equal(recallOnly.graph.entities.length, 0);
    assert.equal(recallOnly.graph.edges.length, 0);

    const mutation = await store.upsertFromExtractionInput({
      text: "Avery reviewed the Atlas launch notes.",
      observedAt: "2026-05-03T19:01:00.000Z",
      evidenceRef,
      domainHint: "workflow"
    });
    assert.equal(
      mutation.graph.entities.some((entity) => entity.evidenceRefs.includes(evidenceRef)),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Stage 6.86 open loops are not created by Source Recall refs alone", () => {
  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review the launch checklist.",
        at: "2026-05-03T19:10:00.000Z"
      }
    ],
    "2026-05-03T19:10:00.000Z"
  );
  const threadKey = stack.activeThreadKey;
  assert.ok(threadKey);

  const result = upsertOpenLoopOnConversationStackV1({
    stack,
    threadKey,
    text: "",
    observedAt: "2026-05-03T19:11:00.000Z",
    entityRefs: [
      buildSourceRecallEvidenceRef(buildSourceRecallSourceRef("source_record_loop", "chunk_loop"))
    ]
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, false);
  assert.equal(result.loop, null);
});

test("workflow observations can carry Source Recall evidence refs without changing counters", () => {
  const evidenceRef = buildSourceRecallEvidenceRef(
    buildSourceRecallSourceRef("source_record_workflow", "chunk_workflow")
  );
  const pattern: WorkflowPattern = {
    id: "workflow_pattern_1",
    workflowKey: "static_site_review",
    status: "active",
    confidence: 0.5,
    firstSeenAt: "2026-05-03T19:20:00.000Z",
    lastSeenAt: "2026-05-03T19:20:00.000Z",
    supersededAt: null,
    domainLane: "workflow",
    successCount: 1,
    failureCount: 0,
    suppressedCount: 0,
    contextTags: ["static-site"]
  };
  const observation: WorkflowObservation = {
    workflowKey: "static_site_review",
    outcome: "success",
    observedAt: "2026-05-03T19:21:00.000Z",
    domainLane: "workflow",
    contextTags: ["static-site"],
    evidenceRefs: [evidenceRef]
  };

  const updated = applyWorkflowObservationMetadata(pattern, observation);

  assert.deepEqual(updated.evidenceRefs, [evidenceRef]);
  assert.equal(updated.successCount, 1);
  assert.equal(updated.failureCount, 0);
  assert.equal(updated.suppressedCount, 0);
});
