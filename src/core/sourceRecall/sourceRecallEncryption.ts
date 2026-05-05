/**
 * @fileoverview Authenticated encryption helpers for production Source Recall storage.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import {
  parseSourceRecallDocument,
  type SourceRecallDocument
} from "./sourceRecallPersistence";

const SOURCE_RECALL_CIPHER = "aes-256-gcm";
const SOURCE_RECALL_IV_BYTES = 12;
const SOURCE_RECALL_TAG_BYTES = 16;
const SOURCE_RECALL_KEY_BYTES = 32;

export interface EncryptedSourceRecallEnvelopeV1 {
  version: 1;
  algorithm: typeof SOURCE_RECALL_CIPHER;
  ivBase64: string;
  tagBase64: string;
  ciphertextBase64: string;
}

/**
 * Encodes binary Source Recall envelope fields as base64 text.
 *
 * **Why it exists:**
 * SQLite persistence stores the encrypted envelope as JSON, so binary IV, tag, and ciphertext
 * fields need one canonical text representation.
 *
 * **What it talks to:**
 * - Uses `Buffer` from the Node.js runtime.
 *
 * @param input - Raw binary field.
 * @returns Base64-encoded field.
 */
function toBase64(input: Buffer): string {
  return input.toString("base64");
}

/**
 * Decodes a base64 Source Recall envelope field into bytes.
 *
 * **Why it exists:**
 * Decryption needs raw IV, tag, and ciphertext bytes while persistence keeps these fields as JSON
 * strings.
 *
 * **What it talks to:**
 * - Uses `Buffer` from the Node.js runtime.
 *
 * @param input - Base64-encoded field.
 * @returns Decoded binary field.
 */
function fromBase64(input: string): Buffer {
  return Buffer.from(input, "base64");
}

/**
 * Fails when a Source Recall encryption key is not 32 bytes.
 *
 * **Why it exists:**
 * Source Recall uses AES-256-GCM. Accepting weak or malformed key material would create a false
 * production-readiness signal for raw source storage.
 *
 * **What it talks to:**
 * - Uses local byte-length constants within this module.
 *
 * @param key - Candidate encryption key.
 */
export function assertSourceRecallKeyLength(key: Buffer): void {
  if (key.byteLength !== SOURCE_RECALL_KEY_BYTES) {
    throw new Error("Source Recall encryption key must be exactly 32 bytes.");
  }
}

/**
 * Decodes Source Recall encryption key text from environment-compatible input.
 *
 * **Why it exists:**
 * A2 config wiring needs a deterministic parser that supports 64-character hex or canonical
 * base64-encoded 32-byte keys without treating arbitrary strings as production-ready key material.
 *
 * **What it talks to:**
 * - Uses `timingSafeEqual` from `node:crypto`.
 *
 * @param raw - Raw environment value.
 * @returns Decoded 32-byte key.
 */
export function decodeSourceRecallEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("BRAIN_SOURCE_RECALL_ENCRYPTION_KEY is empty.");
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const key = Buffer.from(trimmed, "hex");
    assertSourceRecallKeyLength(key);
    return key;
  }

  const decoded = Buffer.from(trimmed, "base64");
  assertSourceRecallKeyLength(decoded);
  const reEncoded = toBase64(decoded).replace(/=+$/g, "");
  const normalizedInput = trimmed.replace(/=+$/g, "");
  const reEncodedBuffer = Buffer.from(reEncoded);
  const inputBuffer = Buffer.from(normalizedInput);
  if (
    reEncodedBuffer.byteLength !== inputBuffer.byteLength ||
    !timingSafeEqual(reEncodedBuffer, inputBuffer)
  ) {
    throw new Error(
      "BRAIN_SOURCE_RECALL_ENCRYPTION_KEY base64 payload is invalid or non-canonical."
    );
  }
  return decoded;
}

/**
 * Encrypts one normalized Source Recall document into an authenticated envelope.
 *
 * **Why it exists:**
 * Production Source Recall stores raw source chunks. Encrypting the full document keeps raw text and
 * source metadata out of the SQLite row instead of relying on field-by-field redaction decisions.
 *
 * **What it talks to:**
 * - Uses `createCipheriv` and `randomBytes` from `node:crypto`.
 *
 * @param document - Source Recall document to persist.
 * @param encryptionKey - Decoded 32-byte key.
 * @returns Encrypted Source Recall envelope.
 */
export function encryptSourceRecallDocument(
  document: SourceRecallDocument,
  encryptionKey: Buffer
): EncryptedSourceRecallEnvelopeV1 {
  assertSourceRecallKeyLength(encryptionKey);
  const iv = randomBytes(SOURCE_RECALL_IV_BYTES);
  const cipher = createCipheriv(SOURCE_RECALL_CIPHER, encryptionKey, iv);
  const serialized = Buffer.from(JSON.stringify(document), "utf8");
  const ciphertext = Buffer.concat([cipher.update(serialized), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: SOURCE_RECALL_CIPHER,
    ivBase64: toBase64(iv),
    tagBase64: toBase64(tag),
    ciphertextBase64: toBase64(ciphertext)
  };
}

/**
 * Decrypts and normalizes a persisted Source Recall encrypted envelope.
 *
 * **Why it exists:**
 * Store reads should authenticate production Source Recall bytes before parsing and should normalize
 * recovered records through the same fail-closed document parser used by test storage.
 *
 * **What it talks to:**
 * - Uses `createDecipheriv` from `node:crypto`.
 * - Uses `parseSourceRecallDocument` from `./sourceRecallPersistence`.
 *
 * @param envelope - Persisted encrypted envelope.
 * @param encryptionKey - Decoded 32-byte key.
 * @returns Normalized Source Recall document.
 */
export function decryptSourceRecallDocument(
  envelope: EncryptedSourceRecallEnvelopeV1,
  encryptionKey: Buffer
): SourceRecallDocument {
  assertSourceRecallKeyLength(encryptionKey);
  if (envelope.version !== 1 || envelope.algorithm !== SOURCE_RECALL_CIPHER) {
    throw new Error("Unsupported Source Recall envelope version or algorithm.");
  }
  const iv = fromBase64(envelope.ivBase64);
  const tag = fromBase64(envelope.tagBase64);
  const ciphertext = fromBase64(envelope.ciphertextBase64);
  if (iv.byteLength !== SOURCE_RECALL_IV_BYTES) {
    throw new Error("Invalid encrypted Source Recall IV length.");
  }
  if (tag.byteLength !== SOURCE_RECALL_TAG_BYTES) {
    throw new Error("Invalid encrypted Source Recall tag length.");
  }
  const decipher = createDecipheriv(SOURCE_RECALL_CIPHER, encryptionKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return parseSourceRecallDocument(JSON.parse(plaintext.toString("utf8")));
}
