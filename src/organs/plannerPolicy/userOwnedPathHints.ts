/**
 * @fileoverview Resolves stable user-owned path hints for planner guidance.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface UserOwnedPathHints {
  desktopPath: string | null;
  documentsPath: string | null;
  downloadsPath: string | null;
}

/**
 * Picks the first existing path from a candidate list and otherwise falls back to the first
 * non-empty candidate so planner guidance still stays concrete.
 *
 * @param candidates - Candidate filesystem paths ordered by preference.
 * @returns Preferred path or `null` when no candidate is available.
 */
function pickPreferredPath(candidates: readonly string[]): string | null {
  const normalizedCandidates = candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
  if (normalizedCandidates.length === 0) {
    return null;
  }
  for (const candidate of normalizedCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return normalizedCandidates[0] ?? null;
}

/**
 * Resolves concrete user-owned Desktop/Documents/Downloads hints from the local machine.
 *
 * @param env - Environment source used for home-directory overrides.
 * @returns Concrete user-owned path hints for planner/environment guidance.
 */
export function resolveUserOwnedPathHints(
  env: NodeJS.ProcessEnv = process.env
): UserOwnedPathHints {
  const homeDirectory =
    (env.USERPROFILE ?? "").trim() ||
    (env.HOME ?? "").trim() ||
    os.homedir();
  const oneDriveDirectory =
    (env.OneDrive ?? env.ONEDRIVE ?? "").trim() || null;

  const desktopPath = pickPreferredPath([
    oneDriveDirectory ? path.join(oneDriveDirectory, "Desktop") : "",
    path.join(homeDirectory, "OneDrive", "Desktop"),
    path.join(homeDirectory, "Desktop")
  ]);
  const documentsPath = pickPreferredPath([
    oneDriveDirectory ? path.join(oneDriveDirectory, "Documents") : "",
    path.join(homeDirectory, "OneDrive", "Documents"),
    path.join(homeDirectory, "Documents")
  ]);
  const downloadsPath = pickPreferredPath([
    path.join(homeDirectory, "Downloads")
  ]);

  return {
    desktopPath,
    documentsPath,
    downloadsPath
  };
}
