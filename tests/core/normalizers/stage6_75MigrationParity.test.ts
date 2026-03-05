/**
 * @fileoverview Tests deterministic Stage 6.75 migration parity normalization for schema-envelope V1 artifact payloads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeArtifactForParityV1 } from "../../../src/core/normalizers/stage6_75MigrationParity";

test("migration parity normalizer produces stable normalized payload ordering", () => {
  const input = {
    schemaName: "DistilledPacketV1",
    schemaVersion: "v1",
    payload: {
      z: 1,
      a: {
        c: 2,
        b: 3
      }
    }
  };
  const first = normalizeArtifactForParityV1(input);
  const second = normalizeArtifactForParityV1(input);
  assert.deepEqual(first, second);
});

test("migration parity normalizer fails closed on unsupported schema version", () => {
  assert.throws(
    () =>
      normalizeArtifactForParityV1({
        schemaName: "DistilledPacketV2",
        schemaVersion: "v2",
        payload: {}
      }),
    /schemaVersion 'v1'/
  );
});
