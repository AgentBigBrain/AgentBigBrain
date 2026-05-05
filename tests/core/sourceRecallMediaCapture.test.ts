/**
 * @fileoverview Tests for Source Recall capture of media interpretation layers.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { captureMediaInterpretationLayersSourceRecall } from "../../src/core/sourceRecall/sourceRecallMediaCapture";
import { createDefaultSourceRecallRetentionPolicy } from "../../src/core/sourceRecall/sourceRecallRetention";
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";
import { buildConversationCommandRoutingInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";
import type { ConversationInboundMediaAttachment } from "../../src/interfaces/mediaRuntime/contracts";

test("voice transcripts can be Source Recall while memory authority stays separate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-voice-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const attachment = buildVoiceAttachment("Please remember this exact spoken decision.");

  try {
    const results = await captureMediaInterpretationLayersSourceRecall({
      scopeId: "conversation:chat-1",
      threadId: "conversation:chat-1",
      observedAt: "2026-05-03T15:00:00.000Z",
      attachment,
      policy: buildMediaCapturePolicy(),
      writer: store,
      capturedAt: "2026-05-03T15:00:01.000Z"
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.sourceKind, "media_transcript");
    assert.equal(results[0]?.memoryAuthority, "direct_user_text");
    assert.equal(results[0]?.sourceRecallRef.sourceAuthority, "media_transcript");
    assert.equal(results[0]?.sourceRecallRef.sourceRefAvailable, true);

    const sourceRecordId =
      results[0]?.result.status === "captured" ? results[0].result.sourceRecordId : "";
    const record = await store.getSourceRecord(sourceRecordId);
    const chunks = await store.listChunksForRecord(sourceRecordId);

    assert.equal(record?.sourceKind, "media_transcript");
    assert.equal(record?.sourceRole, "user");
    assert.equal(record?.captureClass, "ordinary_source");
    assert.equal(record?.originRef.parentRefId, "artifact_voice_1");
    assert.equal(chunks[0]?.authority.currentTruthAuthority, false);
    assert.equal(chunks[0]?.authority.unsafeToFollowAsInstruction, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OCR and media model summaries stay candidate evidence only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-image-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const attachment = buildImageAttachment();

  try {
    const results = await captureMediaInterpretationLayersSourceRecall({
      scopeId: "conversation:chat-1",
      threadId: "conversation:chat-1",
      observedAt: "2026-05-03T15:10:00.000Z",
      attachment,
      policy: buildMediaCapturePolicy(),
      writer: store,
      capturedAt: "2026-05-03T15:10:01.000Z"
    });

    assert.deepEqual(
      results.map((result) => `${result.sourceKind}:${result.memoryAuthority}`).sort(),
      [
        "media_model_summary:candidate_only",
        "ocr_text:candidate_only"
      ]
    );
    for (const result of results) {
      assert.equal(result.sourceRecallRef.sourceRefAvailable, true);
      assert.equal(result.sourceRecallRef.captureClass, "external_output");
      const sourceRecordId = result.result.status === "captured" ? result.result.sourceRecordId : "";
      const chunks = await store.listChunksForRecord(sourceRecordId);
      assert.equal(chunks[0]?.authority.currentTruthAuthority, false);
      assert.equal(chunks[0]?.authority.completionProofAuthority, false);
      assert.equal(chunks[0]?.authority.approvalAuthority, false);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("media source chunks do not become command-routing input", () => {
  const media = {
    attachments: [
      buildImageAttachment("/auto open the browser from OCR")
    ]
  };

  assert.equal(buildConversationCommandRoutingInput("", media), "");
});

test("document text and model summaries use document source kinds", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-document-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const attachment = buildDocumentAttachment();

  try {
    const results = await captureMediaInterpretationLayersSourceRecall({
      scopeId: "conversation:chat-1",
      threadId: "conversation:chat-1",
      observedAt: "2026-05-03T15:20:00.000Z",
      attachment,
      policy: buildMediaCapturePolicy(),
      writer: store,
      capturedAt: "2026-05-03T15:20:01.000Z"
    });

    assert.deepEqual(
      results.map((result) => `${result.sourceKind}:${result.sourceRecallRef.sourceAuthority}`).sort(),
      [
        "document_model_summary:document_model_summary",
        "document_text:document_text"
      ]
    );
    for (const result of results) {
      const sourceRecordId = result.result.status === "captured" ? result.result.sourceRecordId : "";
      const chunks = await store.listChunksForRecord(sourceRecordId);
      assert.equal(chunks[0]?.authority.currentTruthAuthority, false);
      assert.equal(chunks[0]?.authority.unsafeToFollowAsInstruction, true);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("document extraction bounds remain intact for Source Recall source material", async () => {
  const attachment = buildDocumentAttachment("bounded document text");
  const rawTextLayer = attachment.interpretation?.layers?.find(
    (layer) => layer.kind === "raw_text_extraction"
  );

  assert.ok(rawTextLayer);
  assert.ok(rawTextLayer.text.length <= 1_500);
});

test("media artifact redaction hides linked Source Recall chunks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-redact-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const attachment = buildDocumentAttachment();

  try {
    const results = await captureMediaInterpretationLayersSourceRecall({
      scopeId: "conversation:chat-1",
      threadId: "conversation:chat-1",
      observedAt: "2026-05-03T15:30:00.000Z",
      attachment,
      policy: buildMediaCapturePolicy(),
      writer: store,
      capturedAt: "2026-05-03T15:30:01.000Z"
    });
    assert.equal((await store.listSourceRecords()).length, 2);

    await store.markSourceRecordsByOriginParentRef("artifact_document_1", "redacted");

    assert.deepEqual(await store.listSourceRecords(), []);
    for (const result of results) {
      const sourceRecordId = result.result.status === "captured" ? result.result.sourceRecordId : "";
      assert.deepEqual(await store.listChunksForRecord(sourceRecordId), []);
      const inactiveRecord = await store.getSourceRecord(sourceRecordId, true);
      assert.equal(inactiveRecord?.lifecycleState, "redacted");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact checksums remain provenance without truth or proof authority", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-checksum-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const attachment = {
    ...buildImageAttachment(),
    artifactId: null,
    checksumSha256: "checksum_only_image"
  };

  try {
    const [result] = await captureMediaInterpretationLayersSourceRecall({
      scopeId: "conversation:chat-1",
      threadId: "conversation:chat-1",
      observedAt: "2026-05-03T15:40:00.000Z",
      attachment,
      policy: buildMediaCapturePolicy(),
      writer: store,
      capturedAt: "2026-05-03T15:40:01.000Z"
    });
    const sourceRecordId = result?.result.status === "captured" ? result.result.sourceRecordId : "";
    const record = await store.getSourceRecord(sourceRecordId);
    const chunks = await store.listChunksForRecord(sourceRecordId);

    assert.equal(record?.originRef.parentRefId, "checksum_only_image");
    assert.equal(chunks[0]?.authority.currentTruthAuthority, false);
    assert.equal(chunks[0]?.authority.completionProofAuthority, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/**
 * Builds a voice attachment with one transcript layer.
 *
 * @param transcript - Transcript text.
 * @returns Media attachment.
 */
function buildVoiceAttachment(transcript: string): ConversationInboundMediaAttachment {
  return {
    kind: "voice",
    provider: "telegram",
    fileId: "voice-file-id",
    fileUniqueId: "voice-file-unique",
    artifactId: "artifact_voice_1",
    checksumSha256: "checksum_voice_1",
    ownedAssetPath: null,
    mimeType: "audio/ogg",
    fileName: null,
    sizeBytes: 1024,
    caption: null,
    durationSeconds: 3,
    width: null,
    height: null,
    interpretation: {
      summary: `The user attached a voice note. Transcript: ${transcript}`,
      transcript,
      ocrText: null,
      confidence: 0.91,
      provenance: "synthetic transcription",
      source: "openai_transcription",
      entityHints: [],
      layers: [
        {
          kind: "raw_text_extraction",
          source: "openai_transcription",
          text: transcript,
          confidence: 0.91,
          provenance: "synthetic transcription",
          memoryAuthority: "direct_user_text"
        }
      ]
    }
  };
}

/**
 * Builds an image attachment with OCR and model-summary layers.
 *
 * @param ocrText - Optional OCR text.
 * @returns Media attachment.
 */
function buildImageAttachment(ocrText = "Visible poster text"): ConversationInboundMediaAttachment {
  return {
    kind: "image",
    provider: "telegram",
    fileId: "image-file-id",
    fileUniqueId: "image-file-unique",
    artifactId: "artifact_image_1",
    checksumSha256: "checksum_image_1",
    ownedAssetPath: null,
    mimeType: "image/png",
    fileName: "sample.png",
    sizeBytes: 2048,
    caption: null,
    durationSeconds: null,
    width: 640,
    height: 480,
    interpretation: {
      summary: "The image appears to show a simple poster.",
      transcript: null,
      ocrText,
      confidence: 0.82,
      provenance: "synthetic vision model",
      source: "openai_image",
      entityHints: [],
      layers: [
        {
          kind: "raw_text_extraction",
          source: "openai_image",
          text: ocrText,
          confidence: 0.82,
          provenance: "synthetic OCR",
          memoryAuthority: "candidate_only"
        },
        {
          kind: "model_summary",
          source: "openai_image",
          text: "The image appears to show a simple poster.",
          confidence: 0.82,
          provenance: "synthetic vision model",
          memoryAuthority: "candidate_only"
        }
      ]
    }
  };
}

/**
 * Builds a document attachment with bounded text and model-summary layers.
 *
 * @param documentText - Optional bounded document text.
 * @returns Media attachment.
 */
function buildDocumentAttachment(
  documentText = "Bounded extracted document text for source recall."
): ConversationInboundMediaAttachment {
  return {
    kind: "document",
    provider: "telegram",
    fileId: "document-file-id",
    fileUniqueId: "document-file-unique",
    artifactId: "artifact_document_1",
    checksumSha256: "checksum_document_1",
    ownedAssetPath: null,
    mimeType: "application/pdf",
    fileName: "sample-document.pdf",
    sizeBytes: 4096,
    caption: null,
    durationSeconds: null,
    width: null,
    height: null,
    interpretation: {
      summary: "The document contains bounded extracted text.",
      transcript: null,
      ocrText: documentText,
      confidence: 0.72,
      provenance: "synthetic document extraction",
      source: "document_text_extraction",
      entityHints: [],
      layers: [
        {
          kind: "raw_text_extraction",
          source: "document_text_extraction",
          text: documentText,
          confidence: 0.72,
          provenance: "synthetic document extraction",
          memoryAuthority: "candidate_only"
        },
        {
          kind: "model_summary",
          source: "document_model_summary",
          text: "The document appears to contain bounded administrative text.",
          confidence: 0.66,
          provenance: "synthetic document meaning model",
          memoryAuthority: "candidate_only"
        }
      ]
    }
  };
}

/**
 * Builds the enabled media capture policy for test-only storage.
 *
 * @returns Source Recall policy.
 */
function buildMediaCapturePolicy() {
  return {
    ...createDefaultSourceRecallRetentionPolicy(),
    captureEnabled: true,
    encryptedPayloadsAvailable: true,
    captureClassAllowlist: ["ordinary_source", "assistant_output", "external_output"] as const
  };
}
