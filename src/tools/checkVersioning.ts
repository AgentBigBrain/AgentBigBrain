/**
 * @fileoverview Verifies that repo version metadata stays aligned across package.json and CHANGELOG.md.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reads and validates the current package version from package.json.
 *
 * @returns Current semantic version string from package.json.
 */
function readPackageVersion(): string {
  const packageJsonPath = path.resolve(process.cwd(), "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error("package.json is missing a valid \"version\" string.");
  }
  return parsed.version.trim();
}

/**
 * Reads the changelog and extracts the latest released version heading.
 *
 * @returns Latest released version from CHANGELOG.md.
 */
function readLatestChangelogReleaseVersion(): string {
  const changelogPath = path.resolve(process.cwd(), "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");

  if (!/^## \[Unreleased\]\s*$/m.test(changelog)) {
    throw new Error("CHANGELOG.md must contain a top-level [Unreleased] section.");
  }

  const releaseMatches = [...changelog.matchAll(/^## \[(?!Unreleased\])([^\]]+)\]\s*(?:—.*)?$/gm)];
  if (releaseMatches.length === 0) {
    throw new Error("CHANGELOG.md must contain at least one released version section.");
  }

  const latestRelease = releaseMatches[0]?.[1]?.trim();
  if (!latestRelease) {
    throw new Error("Could not parse the latest released version from CHANGELOG.md.");
  }
  return latestRelease;
}

/**
 * Runs the version-alignment check and exits nonzero on drift.
 */
function main(): void {
  const packageVersion = readPackageVersion();
  const changelogVersion = readLatestChangelogReleaseVersion();

  if (packageVersion !== changelogVersion) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, CHANGELOG.md latest release=${changelogVersion}. ` +
      "Keep package.json as the single source of truth for the current release version, and keep " +
      "CHANGELOG.md aligned to that released version while unreleased work stays under [Unreleased]."
    );
  }

  console.log(
    `Versioning check passed. Current release version: ${packageVersion}. ` +
    "CHANGELOG.md and package.json are aligned."
  );
}

main();
