/**
 * @fileoverview Persistence helpers for environment configuration and encrypted profile-memory state I/O.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type ProfileMemoryState
} from "../profileMemory";
import {
  createEmptyProfileMemoryState,
  DEFAULT_PROFILE_STALE_AFTER_DAYS
} from "./profileMemoryState";
import {
  decodeProfileMemoryEncryptionKey,
  decryptProfileMemoryState,
  encryptProfileMemoryState,
  type EncryptedProfileEnvelopeV1
} from "./profileMemoryEncryption";
import { ensureEnvLoaded } from "../envLoader";

export const PROFILE_MEMORY_DEFAULT_FILE = "runtime/profile_memory.secure.json";

export interface ProfileMemoryPersistenceConfig {
  filePath: string;
  encryptionKey: Buffer;
  staleAfterDays: number;
}

/**
 * Builds persistence config from environment variables when profile memory is enabled.
 *
 * @param env - Environment source used for profile-memory configuration.
 * @returns Persistence config, or `undefined` when profile memory is disabled.
 */
export function createProfileMemoryPersistenceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ProfileMemoryPersistenceConfig | undefined {
  if (env === process.env) {
    ensureEnvLoaded();
  }

  const enabled = (env.BRAIN_PROFILE_MEMORY_ENABLED ?? "false").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(enabled)) {
    return undefined;
  }

  const keyRaw = env.BRAIN_PROFILE_ENCRYPTION_KEY;
  if (!keyRaw) {
    throw new Error(
      "Profile memory is enabled but BRAIN_PROFILE_ENCRYPTION_KEY is missing."
    );
  }

  const staleAfterDays = Number(env.BRAIN_PROFILE_STALE_AFTER_DAYS);
  const normalizedStaleAfterDays =
    Number.isFinite(staleAfterDays) && staleAfterDays > 0
      ? Math.floor(staleAfterDays)
      : DEFAULT_PROFILE_STALE_AFTER_DAYS;

  return {
    filePath: env.BRAIN_PROFILE_MEMORY_PATH?.trim() || PROFILE_MEMORY_DEFAULT_FILE,
    encryptionKey: decodeProfileMemoryEncryptionKey(keyRaw),
    staleAfterDays: normalizedStaleAfterDays
  };
}

/**
 * Loads and decrypts profile-memory state, returning empty state when no file exists yet.
 *
 * @param filePath - Encrypted profile-memory file path.
 * @param encryptionKey - Decoded profile-memory encryption key.
 * @returns Decrypted normalized profile-memory state.
 */
export async function loadPersistedProfileMemoryState(
  filePath: string,
  encryptionKey: Buffer
): Promise<ProfileMemoryState> {
  try {
    const raw = await readFile(filePath, "utf8");
    const envelope = JSON.parse(raw) as EncryptedProfileEnvelopeV1;
    return decryptProfileMemoryState(envelope, encryptionKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyProfileMemoryState();
    }
    throw error;
  }
}

/**
 * Encrypts and persists normalized profile-memory state.
 *
 * @param filePath - Encrypted profile-memory file path.
 * @param encryptionKey - Decoded profile-memory encryption key.
 * @param state - Normalized profile-memory state to persist.
 * @returns Promise resolving when the encrypted state is flushed to disk.
 */
export async function saveProfileMemoryState(
  filePath: string,
  encryptionKey: Buffer,
  state: ProfileMemoryState
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const envelope = encryptProfileMemoryState(state, encryptionKey);
  await writeFile(filePath, JSON.stringify(envelope, null, 2), "utf8");
}
