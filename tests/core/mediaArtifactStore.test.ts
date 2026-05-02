/**
 * @fileoverview Tests canonical media-artifact persistence, deduplication, and projection change emission.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MediaArtifactStore } from "../../src/core/mediaArtifactStore";
import type { ProjectionChangeSet } from "../../src/core/projections/contracts";

test("MediaArtifactStore persists one owned asset, emits projection change, and deduplicates repeated uploads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-media-artifacts-"));
  try {
    const changeSets: ProjectionChangeSet[] = [];
    const store = new MediaArtifactStore(path.join(tempDir, "media_artifacts.json"), {
      assetDirectory: path.join(tempDir, "assets"),
      onChange: async (changeSet) => {
        changeSets.push(changeSet);
      }
    });

    const recordOne = await store.recordArtifact({
      attachment: {
        kind: "document",
        provider: "telegram",
        fileId: "file_detroit_pdf",
        fileUniqueId: "unique_detroit_pdf",
        mimeType: "application/pdf",
        fileName: "detroit-plan.pdf",
        sizeBytes: 18,
        caption: "Detroit plan",
        durationSeconds: null,
        width: null,
        height: null,
        interpretation: {
          summary: "Detroit plan PDF",
          transcript: null,
          ocrText: "Detroit plan contents",
          confidence: 0.96,
          provenance: "test.seed",
          source: "metadata_fallback",
          entityHints: ["entity_detroit"],
          layers: [
            {
              kind: "raw_text_extraction",
              source: "document_text_extraction",
              text: "Detroit plan contents",
              confidence: 0.96,
              provenance: "test.seed.raw",
              memoryAuthority: "candidate_only"
            }
          ]
        }
      },
      buffer: Buffer.from("detroit-plan-pdf"),
      sourceSurface: "telegram_interface",
      sourceConversationKey: "telegram:chat:user",
      sourceUserId: "user_123",
      recordedAt: "2026-04-12T12:00:00.000Z"
    });
    const recordTwo = await store.recordArtifact({
      attachment: {
        kind: "document",
        provider: "telegram",
        fileId: "file_detroit_pdf",
        fileUniqueId: "unique_detroit_pdf",
        mimeType: "application/pdf",
        fileName: "detroit-plan.pdf",
        sizeBytes: 18,
        caption: "Detroit plan",
        durationSeconds: null,
        width: null,
        height: null,
        interpretation: {
          summary: "Detroit plan PDF",
          transcript: null,
          ocrText: "Detroit plan contents",
          confidence: 0.96,
          provenance: "test.seed",
          source: "metadata_fallback",
          entityHints: ["entity_detroit"],
          layers: [
            {
              kind: "raw_text_extraction",
              source: "document_text_extraction",
              text: "Detroit plan contents",
              confidence: 0.96,
              provenance: "test.seed.raw",
              memoryAuthority: "candidate_only"
            }
          ]
        }
      },
      buffer: Buffer.from("detroit-plan-pdf"),
      sourceSurface: "telegram_interface",
      sourceConversationKey: "telegram:chat:user",
      sourceUserId: "user_123",
      recordedAt: "2026-04-12T12:01:00.000Z"
    });

    assert.equal(recordOne.artifactId, recordTwo.artifactId);
    assert.match(recordOne.assetFileName, /\.pdf$/i);
    await access(recordOne.ownedAssetPath);

    const document = await store.load();
    assert.equal(document.artifacts.length, 1);
    assert.equal(document.artifacts[0]?.derivedMeaning.summary, "Detroit plan PDF");
    assert.deepEqual(document.artifacts[0]?.derivedMeaning.layers, [
      {
        kind: "raw_text_extraction",
        source: "document_text_extraction",
        text: "Detroit plan contents",
        confidence: 0.96,
        provenance: "test.seed.raw",
        memoryAuthority: "candidate_only"
      }
    ]);
    assert.equal(changeSets.length, 2);
    assert.deepEqual(changeSets.map((changeSet) => changeSet.kinds), [
      ["media_artifact_changed"],
      ["media_artifact_changed"]
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MediaArtifactStore loads legacy artifact records without interpretation layers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-media-artifacts-legacy-"));
  try {
    const storePath = path.join(tempDir, "media_artifacts.json");
    await writeFile(
      storePath,
      JSON.stringify(
        {
          schemaVersion: "v1",
          updatedAt: "2026-04-12T12:03:00.000Z",
          artifacts: [
            {
              artifactId: "media_artifact_legacy",
              provider: "telegram",
              sourceSurface: "telegram_interface",
              kind: "document",
              recordedAt: "2026-04-12T12:03:00.000Z",
              sourceConversationKey: "telegram:chat:user",
              sourceUserId: "user_123",
              fileId: "file_legacy",
              fileUniqueId: "unique_legacy",
              mimeType: "text/plain",
              fileName: "legacy.txt",
              sizeBytes: 11,
              caption: null,
              durationSeconds: null,
              width: null,
              height: null,
              checksumSha256: "legacy_sha",
              ownedAssetPath: path.join(tempDir, "assets", "legacy.txt"),
              assetFileName: "legacy.txt",
              derivedMeaning: {
                summary: "Legacy summary",
                transcript: null,
                ocrText: "Legacy text",
                entityHints: []
              }
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new MediaArtifactStore(storePath);
    const document = await store.load();
    assert.equal(document.artifacts.length, 1);
    assert.deepEqual(document.artifacts[0]?.derivedMeaning.layers, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MediaArtifactStore writes untrusted upload names into runtime-owned bounded asset paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-media-artifacts-bounded-"));
  try {
    const assetDirectory = path.join(tempDir, "assets");
    const store = new MediaArtifactStore(path.join(tempDir, "media_artifacts.json"), {
      assetDirectory
    });

    const record = await store.recordArtifact({
      attachment: {
        kind: "document",
        provider: "telegram",
        fileId: "file_untrusted_name",
        fileUniqueId: "unique_untrusted_name",
        mimeType: null,
        fileName: "..\\outside.exe",
        sizeBytes: 7,
        caption: null,
        durationSeconds: null,
        width: null,
        height: null,
        interpretation: null
      },
      buffer: Buffer.from("payload"),
      sourceSurface: "telegram_interface",
      sourceConversationKey: "telegram:chat:user",
      sourceUserId: "user_123",
      recordedAt: "2026-04-12T12:02:00.000Z"
    });

    assert.equal(path.dirname(record.ownedAssetPath), path.resolve(assetDirectory));
    assert.match(record.assetFileName, /^media_artifact_[a-z0-9_]+\.bin$/);
    await access(record.ownedAssetPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
