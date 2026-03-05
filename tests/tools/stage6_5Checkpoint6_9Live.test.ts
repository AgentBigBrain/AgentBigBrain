/**
 * @fileoverview Tests deterministic Stage 6.5 checkpoint 6.9 live-check artifact generation and acceptance-path proof fields.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runCheckpoint69LiveCheck } from "../../scripts/evidence/stage6_5Checkpoint6_9Live";

test("checkpoint 6.9 live check emits federation acceptance-path proof and linkage metadata", async () => {
  const artifact = await runCheckpoint69LiveCheck();

  assert.equal(artifact.passCriteria.overallPass, true);
  assert.equal(typeof artifact.artifactHash, "string");
  assert.ok(artifact.artifactHash.length > 0);
  assert.ok(
    typeof artifact.linkedFrom.receiptHash === "string" ||
    typeof artifact.linkedFrom.traceId === "string"
  );

  assert.equal(typeof artifact.federationContractV1.requestFingerprint, "string");
  assert.equal(typeof artifact.federationContractV1.responseFingerprint, "string");
  assert.equal(typeof artifact.federationContractV1.acceptedTaskId, "string");
  assert.equal(typeof artifact.federationContractV1.normalizedTaskFingerprint, "string");
  assert.ok(artifact.federationContractV1.governancePathEvidenceRefs.length > 0);
});

