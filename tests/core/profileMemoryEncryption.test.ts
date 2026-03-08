/**
 * @fileoverview Tests profile-memory runtime encryption helpers for key parsing and authenticated round-trips.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import {
  assertProfileMemoryKeyLength,
  decodeProfileMemoryEncryptionKey,
  decryptProfileMemoryState,
  encryptProfileMemoryState
} from "../../src/core/profileMemoryRuntime/profileMemoryEncryption";

test("assertProfileMemoryKeyLength rejects non-32-byte encryption keys", () => {
  assert.throws(
    () => assertProfileMemoryKeyLength(Buffer.alloc(31, 1)),
    /exactly 32 bytes/i
  );
});

test("decodeProfileMemoryEncryptionKey accepts canonical hex and base64 payloads", () => {
  const key = Buffer.alloc(32, 7);
  const decodedHex = decodeProfileMemoryEncryptionKey(key.toString("hex"));
  const decodedBase64 = decodeProfileMemoryEncryptionKey(key.toString("base64"));

  assert.equal(decodedHex.equals(key), true);
  assert.equal(decodedBase64.equals(key), true);
});

test("decodeProfileMemoryEncryptionKey rejects non-canonical base64 payloads", () => {
  assert.throws(
    () => decodeProfileMemoryEncryptionKey("!!!!!!!!"),
    /base64/i
  );
});

test("encryptProfileMemoryState and decryptProfileMemoryState round-trip normalized state", () => {
  const encryptionKey = Buffer.alloc(32, 11);
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "preferences.favorite_color",
    value: "green",
    sensitive: false,
    sourceTaskId: "task_profile_memory_encryption_roundtrip",
    source: "test",
    observedAt: "2026-03-07T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const envelope = encryptProfileMemoryState(state, encryptionKey);
  const decrypted = decryptProfileMemoryState(envelope, encryptionKey);

  assert.equal(decrypted.facts.length, 1);
  assert.equal(decrypted.facts[0]?.key, "preferences.favorite_color");
  assert.equal(decrypted.facts[0]?.value, "green");
});
