/**
 * @fileoverview Tests canonical media-artifact persistence, deduplication, and projection change emission.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
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
          entityHints: ["entity_detroit"]
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
          entityHints: ["entity_detroit"]
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
    assert.equal(changeSets.length, 2);
    assert.deepEqual(changeSets.map((changeSet) => changeSet.kinds), [
      ["media_artifact_changed"],
      ["media_artifact_changed"]
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
