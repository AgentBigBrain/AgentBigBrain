/**
 * @fileoverview Reads bounded Codex auth metadata from the operator-owned Codex profile store.
 */

import { readFile } from "node:fs/promises";

import type { CodexAuthStatus } from "./contracts";
import {
  resolveCodexAuthFileLocation,
  resolveCodexProfileHomeDir
} from "./profileState";

interface RawCodexAuthFile {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  last_refresh?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    account_id?: unknown;
  } | null;
}

interface ParsedRawCodexAuthRecord {
  authMode: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
  lastRefreshAt: string | null;
  openAIApiKey: string | null;
}

/**
 * Normalizes one optional auth-file value into a trimmed string or `null`.
 *
 * @param value - Raw JSON field value from the local Codex auth file.
 * @returns Trimmed string when present, otherwise `null`.
 */
function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Parses one raw local Codex auth payload into the bounded metadata shape used by this repo.
 *
 * @param parsed - Decoded auth JSON payload.
 * @returns Parsed auth metadata with token fields normalized but not exposed.
 */
function parseRawCodexAuthRecord(parsed: RawCodexAuthFile): ParsedRawCodexAuthRecord {
  return {
    authMode: normalizeOptionalString(parsed.auth_mode) ?? "",
    accessToken: normalizeOptionalString(parsed.tokens?.access_token),
    refreshToken: normalizeOptionalString(parsed.tokens?.refresh_token),
    idToken: normalizeOptionalString(parsed.tokens?.id_token),
    accountId: normalizeOptionalString(parsed.tokens?.account_id),
    lastRefreshAt: normalizeOptionalString(parsed.last_refresh),
    openAIApiKey: normalizeOptionalString(parsed.OPENAI_API_KEY)
  };
}

/**
 * Resolves the active Codex auth state directory for the selected profile.
 *
 * @param env - Environment source for optional profile or auth-root overrides.
 * @returns Absolute path for the active profile home directory.
 */
export function resolveCodexAuthStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCodexProfileHomeDir(env);
}

/**
 * Resolves the auth.json path inside the Codex state directory.
 *
 * @param env - Environment source for optional overrides.
 * @returns Absolute auth.json path.
 */
export function resolveCodexAuthFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCodexAuthFileLocation(env).authFilePath;
}

/**
 * Reads bounded Codex auth metadata without ever returning raw token material.
 *
 * @param env - Environment source for optional overrides.
 * @returns Redacted auth status for owner-facing status checks and backend readiness.
 */
export async function readCodexAuthStatus(
  env: NodeJS.ProcessEnv = process.env
): Promise<CodexAuthStatus> {
  const location = resolveCodexAuthFileLocation(env);
  const { stateDir, authFilePath, profileId, usingLegacyFallback } = location;

  try {
    const raw = await readFile(authFilePath, "utf8");
    const parsed = parseRawCodexAuthRecord(JSON.parse(raw) as RawCodexAuthFile);
    const accessTokenPresent = parsed.accessToken !== null;
    const refreshTokenPresent = parsed.refreshToken !== null;
    const idTokenPresent = parsed.idToken !== null;
    const apiKeyPresent = parsed.openAIApiKey !== null;

    return {
      stateDir,
      authFilePath,
      profileId,
      usingLegacyFallback,
      available: Boolean(parsed.authMode) && (accessTokenPresent || refreshTokenPresent || apiKeyPresent),
      auth: {
        authMode: parsed.authMode,
        accessTokenPresent,
        refreshTokenPresent,
        idTokenPresent,
        accountId: parsed.accountId,
        lastRefreshAt: parsed.lastRefreshAt
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        stateDir,
        authFilePath,
        profileId,
        usingLegacyFallback,
        available: false,
        auth: null
      };
    }
    throw error;
  }
}

/**
 * Reads the current bearer credential needed for provider-backed Codex-authenticated requests.
 *
 * @param env - Environment source for optional overrides.
 * @returns Access token when available, otherwise legacy API key, else `null`.
 */
export async function readCodexBearerToken(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const authFilePath = resolveCodexAuthFilePath(env);
  try {
    const raw = await readFile(authFilePath, "utf8");
    const parsed = parseRawCodexAuthRecord(JSON.parse(raw) as RawCodexAuthFile);
    return parsed.accessToken ?? parsed.openAIApiKey ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
