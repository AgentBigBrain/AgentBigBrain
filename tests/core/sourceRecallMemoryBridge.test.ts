/**
 * @fileoverview Tests for Source Recall refs as memory evidence, not authority.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { buildProfileMemoryIngestPolicy } from "../../src/core/profileMemoryRuntime/profileMemoryIngestPolicy";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import {
  attachSourceRecallRefsToProfileMemoryProvenance,
  buildSourceRecallSourceRef,
  canSourceRecallRefAuthorizeProfileMemoryWrite,
  canSourceRecallRefAuthorizeSemanticLessonCommit
} from "../../src/core/sourceRecall/sourceRecallMemoryBridge";

test("Source Recall refs cannot authorize profile or semantic memory writes", () => {
  assert.equal(canSourceRecallRefAuthorizeProfileMemoryWrite(), false);
  assert.equal(canSourceRecallRefAuthorizeSemanticLessonCommit(), false);
});

test("profile-memory mutation envelopes can cite Source Recall refs without source refs creating facts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-profile-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const store = new ProfileMemoryStore(profilePath, Buffer.alloc(32, 4), 90);
  const sourceRef = buildSourceRecallSourceRef("source_record_profile", "chunk_profile");
  const provenance = attachSourceRecallRefsToProfileMemoryProvenance(
    {
      conversationId: "conversation_source_recall",
      turnId: "turn_source_recall",
      sourceSurface: "conversation_profile_input",
      sourceFingerprint: "source_recall_profile_fingerprint"
    },
    [sourceRef]
  );

  try {
    const sourceOnlyResult = await store.ingestFromTaskInput(
      "task_source_ref_only",
      "",
      "2026-05-03T18:00:00.000Z",
      {
        provenance,
        ingestPolicy: buildProfileMemoryIngestPolicy({
          memoryIntent: "profile_update",
          sourceSurface: "conversation_profile_input"
        })
      }
    );
    assert.equal(sourceOnlyResult.appliedFacts, 0);

    const governedResult = await store.ingestFromTaskInput(
      "task_source_ref_governed",
      "My name is Anthony.",
      "2026-05-03T18:01:00.000Z",
      {
        provenance,
        ingestPolicy: buildProfileMemoryIngestPolicy({
          memoryIntent: "profile_update",
          sourceSurface: "conversation_profile_input"
        })
      }
    );

    assert.ok(governedResult.appliedFacts > 0);
    assert.equal(
      governedResult.mutationEnvelope?.requestCorrelation.sourceRecallRefs?.[0]?.sourceRecordId,
      "source_record_profile"
    );
    assert.equal(
      governedResult.mutationEnvelope?.requestCorrelation.sourceRecallRefs?.[0]?.authority.currentTruthAuthority,
      false
    );
    assert.equal(
      governedResult.mutationEnvelope?.requestCorrelation.sourceRecallRefs?.[0]?.authority.approvalAuthority,
      false
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("semantic memory lessons can cite Source Recall refs without recall retrieval becoming lesson commit authority", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-semantic-"));
  const memoryPath = path.join(tempDir, "semantic_memory.json");
  const store = new SemanticMemoryStore(memoryPath);
  const sourceRef = buildSourceRecallSourceRef("source_record_semantic", "chunk_semantic");

  try {
    await store.appendLesson(
      "When building static review artifacts, prefer bounded proof before visible preview.",
      "task_semantic_source_ref",
      undefined,
      "experience",
      null,
      "workflow",
      [sourceRef]
    );

    const memory = await store.load();
    assert.equal(memory.lessons.length, 1);
    assert.equal(memory.lessons[0]?.sourceRecallRefs?.[0]?.sourceRecordId, "source_record_semantic");
    assert.equal(memory.lessons[0]?.sourceRecallRefs?.[0]?.authority.completionProofAuthority, false);
    assert.equal(memory.lessons[0]?.sourceRecallRefs?.[0]?.authority.unsafeToFollowAsInstruction, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
