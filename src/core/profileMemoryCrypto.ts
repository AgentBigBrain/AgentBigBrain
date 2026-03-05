/**
 * @fileoverview Deterministic encryption envelope helpers for secure profile-memory persistence.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import { normalizeProfileMemoryState, ProfileMemoryState } from "./profileMemory";

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
 * Converts values into base64 form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for base64 deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Resulting string value.
 */
function toBase64(input: Buffer): string {
  return input.toString("base64");
}

/**
 * Converts values into base64 form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for base64 deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `Buffer` result.
 */
function fromBase64(input: string): Buffer {
  return Buffer.from(input, "base64");
}

/**
 * Applies deterministic validity checks for profile memory key length.
 *
 * **Why it exists:**
 * Fails fast when profile memory key length is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param key - Lookup key or map field identifier.
 */
export function assertProfileMemoryKeyLength(key: Buffer): void {
  if (key.byteLength !== 32) {
    throw new Error("Profile encryption key must be exactly 32 bytes.");
  }
}

/**
 * Parses profile memory encryption key and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for profile memory encryption key so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `timingSafeEqual` (import `timingSafeEqual`) from `node:crypto`.
 *
 * @param raw - Value for raw.
 * @returns Computed `Buffer` result.
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
 * Implements encrypt profile memory state behavior used by `profileMemoryCrypto`.
 *
 * **Why it exists:**
 * Defines public behavior from `profileMemoryCrypto.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 * - Uses `createCipheriv` (import `createCipheriv`) from `node:crypto`.
 * - Uses `randomBytes` (import `randomBytes`) from `node:crypto`.
 *
 * @param state - Value for state.
 * @param encryptionKey - Lookup key or map field identifier.
 * @returns Computed `EncryptedProfileEnvelopeV1` result.
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
 * Implements decrypt profile memory state behavior used by `profileMemoryCrypto`.
 *
 * **Why it exists:**
 * Defines public behavior from `profileMemoryCrypto.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileMemoryState` (import `normalizeProfileMemoryState`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 * - Uses `createDecipheriv` (import `createDecipheriv`) from `node:crypto`.
 *
 * @param envelope - Value for envelope.
 * @param encryptionKey - Lookup key or map field identifier.
 * @returns Computed `ProfileMemoryState` result.
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
