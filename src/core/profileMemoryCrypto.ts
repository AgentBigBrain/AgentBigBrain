/**
 * @fileoverview Thin compatibility entrypoint for profile-memory encryption helpers.
 */

export type { EncryptedProfileEnvelopeV1 } from "./profileMemoryRuntime/profileMemoryEncryption";
export {
  assertProfileMemoryKeyLength,
  decodeProfileMemoryEncryptionKey,
  decryptProfileMemoryState,
  encryptProfileMemoryState
} from "./profileMemoryRuntime/profileMemoryEncryption";
