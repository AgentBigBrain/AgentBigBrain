/**
 * @fileoverview Tests Source Recall encryption key parsing boundaries.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeSourceRecallEncryptionKey } from "../../src/core/sourceRecall/sourceRecallEncryption";

test("decodeSourceRecallEncryptionKey accepts canonical 32-byte base64 keys", () => {
  const key = Buffer.alloc(32, 23);

  assert.deepEqual(decodeSourceRecallEncryptionKey(key.toString("base64")), key);
  assert.deepEqual(
    decodeSourceRecallEncryptionKey(key.toString("base64").replace("=", "")),
    key
  );
});

test("decodeSourceRecallEncryptionKey rejects excessive base64 padding", () => {
  const key = Buffer.alloc(32, 31).toString("base64");

  assert.throws(
    () => decodeSourceRecallEncryptionKey(`${key}${"=".repeat(128)}`),
    /BRAIN_SOURCE_RECALL_ENCRYPTION_KEY base64 payload/
  );
});
