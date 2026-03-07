/**
 * @fileoverview Verifies that high-value subsystem READMEs exist, keep required sections, and reference local files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface SubsystemReadmeSpec {
  name: string;
  codeDir: string;
  readmePath: string;
  requiredHeadings: readonly string[];
}

export interface SubsystemReadmeIssue {
  subsystem: string;
  readmePath: string;
  missingReadme: boolean;
  missingHeadings: string[];
  missingFileReferences: string[];
}

export interface SubsystemReadmeSyncDiagnostics {
  issues: SubsystemReadmeIssue[];
}

const REQUIRED_README_HEADINGS = [
  "## Responsibility",
  "## Inputs",
  "## Outputs",
  "## Invariants",
  "## Related Tests",
  "## When to Update This README"
] as const;

export const DEFAULT_SUBSYSTEM_README_SPECS: readonly SubsystemReadmeSpec[] = [
  {
    name: "core",
    codeDir: "src/core",
    readmePath: "src/core/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "governors",
    codeDir: "src/governors",
    readmePath: "src/governors/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "interfaces",
    codeDir: "src/interfaces",
    readmePath: "src/interfaces/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "models",
    codeDir: "src/models",
    readmePath: "src/models/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "organs",
    codeDir: "src/organs",
    readmePath: "src/organs/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "tools",
    codeDir: "src/tools",
    readmePath: "src/tools/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "autonomy",
    codeDir: "src/core/autonomy",
    readmePath: "src/core/autonomy/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "liveRun",
    codeDir: "src/organs/liveRun",
    readmePath: "src/organs/liveRun/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "defaultCouncil",
    codeDir: "src/governors/defaultCouncil",
    readmePath: "src/governors/defaultCouncil/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "plannerPolicy",
    codeDir: "src/organs/plannerPolicy",
    readmePath: "src/organs/plannerPolicy/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  },
  {
    name: "userFacing",
    codeDir: "src/interfaces/userFacing",
    readmePath: "src/interfaces/userFacing/README.md",
    requiredHeadings: REQUIRED_README_HEADINGS
  }
] as const;

/**
 * Computes subsystem README diagnostics for the supplied specs.
 *
 * **Why it exists:**
 * Tests need deterministic coverage for missing headings and missing file references without
 * depending on the live repo layout, and the CLI check should share the same validation logic.
 *
 * **What it talks to:**
 * - Uses `existsSync`, `readFileSync`, and directory helpers from `node:fs`.
 * - Uses local README parsing helpers within this module.
 *
 * @param rootDir - Repository root used to resolve subsystem paths.
 * @param specs - Subsystem README specs to validate.
 * @returns Diagnostics listing any README drift or coverage gaps.
 */
export function computeSubsystemReadmeSyncDiagnostics(
  rootDir: string,
  specs: readonly SubsystemReadmeSpec[] = DEFAULT_SUBSYSTEM_README_SPECS
): SubsystemReadmeSyncDiagnostics {
  const issues: SubsystemReadmeIssue[] = [];

  for (const spec of specs) {
    const absoluteReadmePath = path.join(rootDir, spec.readmePath);
    if (!existsSync(absoluteReadmePath)) {
      issues.push({
        subsystem: spec.name,
        readmePath: spec.readmePath,
        missingReadme: true,
        missingHeadings: [...spec.requiredHeadings],
        missingFileReferences: collectDirectTypeScriptFileNames(path.join(rootDir, spec.codeDir))
      });
      continue;
    }

    const readmeText = readFileSync(absoluteReadmePath, "utf8");
    const missingHeadings = spec.requiredHeadings.filter((heading) => !readmeText.includes(heading));
    const missingFileReferences = collectDirectTypeScriptFileNames(path.join(rootDir, spec.codeDir)).filter(
      (fileName) => !readmeText.includes(fileName)
    );

    if (missingHeadings.length > 0 || missingFileReferences.length > 0) {
      issues.push({
        subsystem: spec.name,
        readmePath: spec.readmePath,
        missingReadme: false,
        missingHeadings,
        missingFileReferences
      });
    }
  }

  return { issues };
}

/**
 * Fails closed when subsystem READMEs are missing required sections or stop naming local files.
 *
 * **Why it exists:**
 * The AI-first refactor depends on local subsystem docs staying accurate. This check makes README
 * drift visible as a contract failure instead of relying on memory.
 *
 * **What it talks to:**
 * - Uses local diagnostics helpers within this module.
 *
 * @param rootDir - Repository root used to resolve subsystem paths.
 * @param specs - Optional subsystem README specs for focused tests.
 */
export function assertSubsystemReadmeSync(
  rootDir: string,
  specs: readonly SubsystemReadmeSpec[] = DEFAULT_SUBSYSTEM_README_SPECS
): void {
  const diagnostics = computeSubsystemReadmeSyncDiagnostics(rootDir, specs);
  if (diagnostics.issues.length === 0) {
    return;
  }

  const lines = ["Subsystem README sync check found issues:"];
  for (const issue of diagnostics.issues) {
    lines.push(`- ${issue.subsystem} (${issue.readmePath})`);
    if (issue.missingReadme) {
      lines.push("  - README is missing.");
    }
    for (const heading of issue.missingHeadings) {
      lines.push(`  - Missing heading: ${heading}`);
    }
    for (const fileReference of issue.missingFileReferences) {
      lines.push(`  - README does not mention local file: ${fileReference}`);
    }
  }
  throw new Error(lines.join("\n"));
}

/**
 * Runs the subsystem README sync check entrypoint.
 *
 * **Why it exists:**
 * Makes README freshness enforcement runnable from package scripts and CI without duplicating
 * assertion logic.
 *
 * **What it talks to:**
 * - Uses `assertSubsystemReadmeSync` from this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  try {
    assertSubsystemReadmeSync(process.cwd());
    console.log("Subsystem README sync check passed.");
  } catch (error) {
    console.error("Subsystem README sync check failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Collects direct `.ts` file names from a subsystem directory.
 *
 * **Why it exists:**
 * README freshness is enforced by requiring the README to name the local files it documents.
 *
 * **What it talks to:**
 * - Uses `existsSync`, `readdirSync`, and `statSync` from `node:fs`.
 *
 * @param directoryPath - Absolute subsystem directory path.
 * @returns Sorted direct `.ts` file names in that directory.
 */
function collectDirectTypeScriptFileNames(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) {
    return [];
  }
  return readdirSync(directoryPath)
    .map((entry) => path.join(directoryPath, entry))
    .filter((absolutePath) => statSync(absolutePath).isFile() && absolutePath.endsWith(".ts"))
    .map((absolutePath) => path.basename(absolutePath))
    .sort((left, right) => left.localeCompare(right));
}

if (require.main === module) {
  main();
}
