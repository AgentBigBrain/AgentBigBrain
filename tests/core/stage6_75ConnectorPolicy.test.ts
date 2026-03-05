/**
 * @fileoverview Tests Stage 6.75 connector policy scope enforcement and deterministic connector receipt fingerprints.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createConnectorReceiptV1,
  validateStage675ConnectorOperation
} from "../../src/core/stage6_75ConnectorPolicy";

test("connector policy blocks unsupported update/delete operations in Stage 6.75", () => {
  const updateDecision = validateStage675ConnectorOperation("update");
  const deleteDecision = validateStage675ConnectorOperation("delete");
  assert.equal(updateDecision.ok, false);
  assert.equal(deleteDecision.ok, false);
  assert.equal(updateDecision.blockCode, "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75");
  assert.equal(deleteDecision.blockCode, "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75");
});

test("connector receipt fingerprints are deterministic for stable payloads", () => {
  const first = createConnectorReceiptV1({
    connector: "gmail",
    operation: "read",
    requestPayload: {
      q: "from:boss@example.com"
    },
    responseMetadata: {
      count: 2
    },
    externalIds: ["msg_001", "msg_002"],
    observedAt: "2026-02-27T21:15:00.000Z"
  });
  const second = createConnectorReceiptV1({
    connector: "gmail",
    operation: "read",
    requestPayload: {
      q: "from:boss@example.com"
    },
    responseMetadata: {
      count: 2
    },
    externalIds: ["msg_001", "msg_002"],
    observedAt: "2026-02-27T21:15:00.000Z"
  });
  assert.equal(first.requestFingerprint, second.requestFingerprint);
  assert.equal(first.responseFingerprint, second.responseFingerprint);
});
