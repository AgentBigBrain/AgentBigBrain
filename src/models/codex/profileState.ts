/**
 * @fileoverview Resolves repo-owned Codex profile state directories and environment overrides.
 */

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_PROFILE_ID = "default";

/**
 * Returns the preferred home directory for user-owned Codex profile state.
 *
 * @param env - Environment source for optional overrides.
 * @returns Absolute home directory path.
 */
function resolveUserHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim();
  const userProfile = env.USERPROFILE?.trim();
  return home || userProfile || os.homedir();
}

/**
 * Returns the requested Codex auth profile id, or the bounded default profile.
 *
 * @param env - Environment source for optional overrides.
 * @returns Stable profile identifier.
 */
export function resolveCodexProfileId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_AUTH_PROFILE?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_PROFILE_ID;
}

/**
 * Resolves the repo-owned root directory that stores all Codex auth profiles.
 *
 * @param env - Environment source for optional overrides.
 * @returns Absolute profile-root path.
 */
export function resolveCodexProfilesRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_AUTH_STATE_DIR?.trim();
  if (configured && configured.length > 0) {
    return path.resolve(configured);
  }
  return path.join(resolveUserHomeDirectory(env), ".agentbigbrain", "codex", "profiles");
}

/**
 * Resolves the user-owned home directory for one Codex auth profile.
 *
 * @param env - Environment source for optional overrides.
 * @param explicitProfileId - Optional profile id override.
 * @returns Absolute per-profile state directory path.
 */
export function resolveCodexProfileHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  explicitProfileId?: string | null
): string {
  const profileId = explicitProfileId?.trim() || resolveCodexProfileId(env);
  const explicitCodeHome = env.CODEX_HOME?.trim();
  if (explicitCodeHome && explicitCodeHome.length > 0) {
    return path.resolve(explicitCodeHome);
  }
  return path.join(resolveCodexProfilesRootDir(env), profileId);
}

/**
 * Resolves the legacy local Codex home used before repo-owned profile directories were introduced.
 *
 * @param env - Environment source for optional overrides.
 * @returns Absolute legacy Codex home path.
 */
export function resolveLegacyCodexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveUserHomeDirectory(env), ".codex");
}

/**
 * Returns the auth.json path inside a Codex home directory.
 *
 * @param codexHomeDir - Profile or legacy Codex home directory.
 * @returns Absolute auth.json path.
 */
export function resolveCodexAuthFilePathForHome(codexHomeDir: string): string {
  return path.join(codexHomeDir, "auth.json");
}

/**
 * Resolves the active auth.json path, preserving a fail-closed legacy fallback for the default profile.
 *
 * @param env - Environment source for optional overrides.
 * @param explicitProfileId - Optional profile id override.
 * @returns Absolute auth.json path plus whether legacy fallback was used.
 */
export function resolveCodexAuthFileLocation(
  env: NodeJS.ProcessEnv = process.env,
  explicitProfileId?: string | null
): {
  profileId: string;
  stateDir: string;
  authFilePath: string;
  usingLegacyFallback: boolean;
} {
  const profileId = explicitProfileId?.trim() || resolveCodexProfileId(env);
  const stateDir = resolveCodexProfileHomeDir(env, profileId);
  const authFilePath = resolveCodexAuthFilePathForHome(stateDir);
  const hasExplicitAuthRoot = Boolean(env.CODEX_AUTH_STATE_DIR?.trim() || env.CODEX_HOME?.trim());
  if (existsSync(authFilePath)) {
    return {
      profileId,
      stateDir,
      authFilePath,
      usingLegacyFallback: false
    };
  }

  if (profileId === DEFAULT_PROFILE_ID && !hasExplicitAuthRoot) {
    const legacyStateDir = resolveLegacyCodexHomeDir(env);
    const legacyAuthFilePath = resolveCodexAuthFilePathForHome(legacyStateDir);
    if (existsSync(legacyAuthFilePath)) {
      return {
        profileId,
        stateDir: legacyStateDir,
        authFilePath: legacyAuthFilePath,
        usingLegacyFallback: true
      };
    }
  }

  return {
    profileId,
    stateDir,
    authFilePath,
    usingLegacyFallback: false
  };
}

/**
 * Builds a child-process environment that pins Codex CLI auth to one profile home.
 *
 * @param env - Base environment to extend.
 * @param explicitProfileId - Optional profile id override.
 * @returns Environment map with stable Codex profile routing.
 */
export function buildCodexProfileEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  explicitProfileId?: string | null
): NodeJS.ProcessEnv {
  const profileId = explicitProfileId?.trim() || resolveCodexProfileId(env);
  const profileHome = resolveCodexProfileHomeDir(env, profileId);
  return {
    ...env,
    CODEX_AUTH_PROFILE: profileId,
    CODEX_HOME: profileHome,
    CODEX_AUTH_STATE_DIR: resolveCodexProfilesRootDir(env)
  };
}
