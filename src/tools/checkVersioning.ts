/**
 * @fileoverview Verifies that repo version metadata and changelog structure stay aligned.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REQUIRED_UNRELEASED_HEADINGS = [
  "### Added",
  "### Changed",
  "### Fixed",
  "### Security"
] as const;

export interface VersioningDiagnostics {
  packageVersion: string | null;
  latestReleaseVersion: string | null;
  issues: string[];
}

/**
 * Reads and validates the current package version from package.json text.
 *
 * **Why it exists:**
 * Tests and the repo-level check both need one deterministic parser for the version source of
 * truth instead of duplicating JSON validation in multiple places.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param packageJsonText - Raw package.json contents.
 * @returns Current semantic version string, or `null` when invalid.
 */
function readPackageVersionFromText(packageJsonText: string): string | null {
  const parsed = JSON.parse(packageJsonText) as { version?: unknown };
  return typeof parsed.version === "string" && parsed.version.trim().length > 0
    ? parsed.version.trim()
    : null;
}

/**
 * Escapes a literal string for regex use.
 *
 * **Why it exists:**
 * Changelog heading checks build regexes from literal heading text, so escaping stays centralized
 * and deterministic instead of hand-written inline at each callsite.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Literal text that will be embedded in a regular expression.
 * @returns Regex-safe literal text.
 */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extracts the raw `[Unreleased]` section body from changelog text.
 *
 * **Why it exists:**
 * The versioning gate needs to validate the unreleased section shape independently from released
 * version headings, so this helper keeps the section slicing logic in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param changelogText - Raw `CHANGELOG.md` contents.
 * @returns Unreleased section body, or `null` when the section is missing.
 */
function extractUnreleasedSection(changelogText: string): string | null {
  const match = changelogText.match(/^## \[Unreleased\]\s*$([\s\S]*?)(?=^## \[|\Z)/m);
  return match?.[1] ?? null;
}

/**
 * Collects any required `[Unreleased]` headings that are missing.
 *
 * **Why it exists:**
 * Agents should keep the changelog in one consistent Keep a Changelog shape, so the gate needs a
 * precise list of missing headings instead of a vague pass/fail result.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param unreleasedSection - Raw `[Unreleased]` section body.
 * @returns Missing heading labels in display order.
 */
function collectMissingUnreleasedHeadings(unreleasedSection: string): string[] {
  return REQUIRED_UNRELEASED_HEADINGS.filter(
    (heading) => !new RegExp(`^${escapeRegexLiteral(heading)}\\s*$`, "m").test(unreleasedSection)
  );
}

/**
 * Extracts the latest released version heading from changelog text.
 *
 * **Why it exists:**
 * The repo treats `package.json` as the release-version source of truth, but it still needs to
 * verify the top released changelog heading stays aligned with that version.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param changelogText - Raw `CHANGELOG.md` contents.
 * @returns Latest released version string, or `null` when no release heading is present.
 */
function readLatestChangelogReleaseVersionFromText(changelogText: string): string | null {
  const releaseMatches = [
    ...changelogText.matchAll(/^## \[(?!Unreleased\])([^\]]+)\]\s*(?:[-—].*)?$/gm)
  ];
  return releaseMatches[0]?.[1]?.trim() ?? null;
}

/**
 * Computes repo versioning diagnostics from raw package and changelog text.
 *
 * **Why it exists:**
 * Tests need stable, file-free diagnostics and the CLI check needs one fail-closed source of truth
 * for package-version alignment plus changelog structure rules.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param packageJsonText - Raw package.json contents.
 * @param changelogText - Raw `CHANGELOG.md` contents.
 * @returns Structured versioning diagnostics.
 */
export function computeVersioningDiagnosticsFromText(
  packageJsonText: string,
  changelogText: string
): VersioningDiagnostics {
  const issues: string[] = [];
  const packageVersion = readPackageVersionFromText(packageJsonText);
  if (!packageVersion) {
    issues.push('package.json is missing a valid "version" string.');
  }

  const unreleasedSection = extractUnreleasedSection(changelogText);
  if (unreleasedSection === null) {
    issues.push("CHANGELOG.md must contain a top-level [Unreleased] section.");
  } else {
    const missingHeadings = collectMissingUnreleasedHeadings(unreleasedSection);
    if (missingHeadings.length > 0) {
      issues.push(
        `CHANGELOG.md [Unreleased] must contain headings: ${missingHeadings.join(", ")}.`
      );
    }
  }

  if (changelogText.includes("â€”")) {
    issues.push(
      "CHANGELOG.md contains mojibake heading text (`â€”`). Use plain `-` or a real em dash in release headings."
    );
  }

  const latestReleaseVersion = readLatestChangelogReleaseVersionFromText(changelogText);
  if (!latestReleaseVersion) {
    issues.push("CHANGELOG.md must contain at least one released version section.");
  } else if (packageVersion && packageVersion !== latestReleaseVersion) {
    issues.push(
      `Version mismatch: package.json=${packageVersion}, CHANGELOG.md latest release=${latestReleaseVersion}. ` +
      "Keep package.json as the single source of truth for the current release version, and keep " +
      "CHANGELOG.md aligned to that released version while unreleased work stays under [Unreleased]."
    );
  }

  return {
    packageVersion,
    latestReleaseVersion,
    issues
  };
}

/**
 * Runs the version-alignment and changelog-shape check for one repo root.
 *
 * **Why it exists:**
 * Package scripts and CI need one exported assertion entrypoint instead of duplicating file reads
 * and diagnostics formatting in multiple callers.
 *
 * **What it talks to:**
 * - Uses `computeVersioningDiagnosticsFromText` (import local) from this module.
 *
 * @param rootDir - Repository root containing `package.json` and `CHANGELOG.md`.
 * @returns Nothing. Throws when versioning or changelog structure drift is present.
 */
export function assertVersioning(rootDir: string): void {
  const packageJsonPath = path.resolve(rootDir, "package.json");
  const changelogPath = path.resolve(rootDir, "CHANGELOG.md");
  const diagnostics = computeVersioningDiagnosticsFromText(
    readFileSync(packageJsonPath, "utf8"),
    readFileSync(changelogPath, "utf8")
  );
  if (diagnostics.issues.length > 0) {
    throw new Error(`Versioning check failed:\n- ${diagnostics.issues.join("\n- ")}`);
  }
}

/**
 * Runs the repo versioning check and reports human-readable output.
 *
 * **Why it exists:**
 * Makes the versioning contract runnable from package scripts and CI without repeating the same
 * assertion wrapper logic in shell scripts.
 *
 * **What it talks to:**
 * - Uses `assertVersioning` (import local) from this module.
 * - Uses `computeVersioningDiagnosticsFromText` (import local) from this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  const rootDir = process.cwd();
  assertVersioning(rootDir);
  const packageJsonPath = path.resolve(rootDir, "package.json");
  const changelogPath = path.resolve(rootDir, "CHANGELOG.md");
  const diagnostics = computeVersioningDiagnosticsFromText(
    readFileSync(packageJsonPath, "utf8"),
    readFileSync(changelogPath, "utf8")
  );
  console.log(
    `Versioning check passed. Current release version: ${diagnostics.packageVersion}. ` +
    "CHANGELOG.md structure and release alignment are valid."
  );
}

main();
