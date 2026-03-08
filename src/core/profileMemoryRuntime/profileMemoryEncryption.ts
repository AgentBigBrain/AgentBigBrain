/**
 * @fileoverview Deterministic encryption envelope helpers for secure profile-memory persistence.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import type { ProfileMemoryState } from "../profileMemory";
import { normalizeProfileMemoryState } from "./profileMemoryStateNormalization";

const PROFILE_MEMORY_CIPHER = "aes-256-gcm";
const PROFILE_MEMORY_IV_BYTES = 12;
const PROFILE_MEMORY_TAG_BYTES = 16;

export interface EncryptedProfileEnvelopeV1 {
  version: 1;
  algorithm: typeof PROFILE_MEMORY_CIPHER;
  ivBase64: string;
  tagBase64: string;
  ciphertextBase64: string;
}

/**
 * Converts binary profile-memory fields into base64 text for persisted envelopes.
 *
 * @param input - Raw bytes to encode.
 * @returns Base64 string form.
 */
function toBase64(input: Buffer): string {
  return input.toString("base64");
}

/**
 * Converts base64-encoded profile-memory fields back into raw bytes.
 *
 * @param input - Base64-encoded field value.
 * @returns Decoded buffer.
 */
function fromBase64(input: string): Buffer {
  return Buffer.from(input, "base64");
}

/**
 * Fails fast when a profile-memory encryption key is not exactly 32 bytes.
 *
 * @param key - Candidate profile-memory encryption key.
 */
export function assertProfileMemoryKeyLength(key: Buffer): void {
  if (key.byteLength !== 32) {
    throw new Error("Profile encryption key must be exactly 32 bytes.");
  }
}

/**
 * Parses the profile-memory encryption key from env-compatible text.
 *
 * @param raw - Raw environment value.
 * @returns Canonical 32-byte encryption key.
 */
export function decodeProfileMemoryEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("BRAIN_PROFILE_ENCRYPTION_KEY is empty.");
  }

  const hexPattern = /^[0-9a-fA-F]{64}$/;
  if (hexPattern.test(trimmed)) {
    const key = Buffer.from(trimmed, "hex");
    assertProfileMemoryKeyLength(key);
    return key;
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.byteLength !== 32) {
    throw new Error(
      "BRAIN_PROFILE_ENCRYPTION_KEY must be 64-char hex or base64-encoded 32 bytes."
    );
  }

  const reEncoded = toBase64(decoded).replace(/=+$/g, "");
  const normalizedInput = trimmed.replace(/=+$/g, "");
  const reEncodedBuffer = Buffer.from(reEncoded);
  const inputBuffer = Buffer.from(normalizedInput);
  if (
    reEncodedBuffer.byteLength !== inputBuffer.byteLength ||
    !timingSafeEqual(reEncodedBuffer, inputBuffer)
  ) {
    throw new Error(
      "BRAIN_PROFILE_ENCRYPTION_KEY base64 payload is invalid or non-canonical."
    );
  }

  return decoded;
}

/**
 * Encrypts normalized profile-memory state into an authenticated envelope.
 *
 * @param state - Normalized profile-memory state.
 * @param encryptionKey - Decoded encryption key.
 * @returns Authenticated profile-memory envelope.
 */
export function encryptProfileMemoryState(
  state: ProfileMemoryState,
  encryptionKey: Buffer
): EncryptedProfileEnvelopeV1 {
  const iv = randomBytes(PROFILE_MEMORY_IV_BYTES);
  const cipher = createCipheriv(PROFILE_MEMORY_CIPHER, encryptionKey, iv);
  const serialized = Buffer.from(JSON.stringify(state), "utf8");
  const ciphertext = Buffer.concat([cipher.update(serialized), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: PROFILE_MEMORY_CIPHER,
    ivBase64: toBase64(iv),
    tagBase64: toBase64(tag),
    ciphertextBase64: toBase64(ciphertext)
  };
}

/**
 * Decrypts and normalizes persisted profile-memory state from an authenticated envelope.
 *
 * @param envelope - Serialized encrypted envelope.
 * @param encryptionKey - Decoded encryption key.
 * @returns Normalized profile-memory state.
 */
export function decryptProfileMemoryState(
  envelope: EncryptedProfileEnvelopeV1,
  encryptionKey: Buffer
): ProfileMemoryState {
  if (envelope.version !== 1 || envelope.algorithm !== PROFILE_MEMORY_CIPHER) {
    throw new Error("Unsupported profile-memory envelope version or algorithm.");
  }

  const iv = fromBase64(envelope.ivBase64);
  const tag = fromBase64(envelope.tagBase64);
  const ciphertext = fromBase64(envelope.ciphertextBase64);
  if (iv.byteLength !== PROFILE_MEMORY_IV_BYTES) {
    throw new Error("Invalid encrypted profile-memory IV length.");
  }
  if (tag.byteLength !== PROFILE_MEMORY_TAG_BYTES) {
    throw new Error("Invalid encrypted profile-memory tag length.");
  }

  const decipher = createDecipheriv(PROFILE_MEMORY_CIPHER, encryptionKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
  return normalizeProfileMemoryState(parsed);
}
