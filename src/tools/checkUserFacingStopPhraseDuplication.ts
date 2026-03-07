/**
 * @fileoverview Detects duplicated canonical autonomous stop-phrase summaries in the shared stop-reason renderer.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface StopPhraseOccurrence {
  phrase: string;
  count: number;
}

export interface StopPhraseDuplicationDiagnostics {
  duplicatePhrases: StopPhraseOccurrence[];
}

const DEFAULT_STOP_REASON_FILE = "src/core/autonomy/stopReasonText.ts";
const STOP_PHRASE_PATTERN = /appendActionableNextStep\(\s*"([^"]+)"/g;

/**
 * Computes stop-phrase duplication diagnostics from raw source text.
 *
 * **Why it exists:**
 * Tests can validate phrase-deduplication behavior without depending on the real repository file,
 * and the CLI check can share the same extraction logic.
 *
 * **What it talks to:**
 * - Uses local parsing helpers within this module.
 *
 * @param sourceText - Source text to scan for `appendActionableNextStep` summary phrases.
 * @returns Diagnostics describing duplicate normalized phrases.
 */
export function computeStopPhraseDuplicationDiagnosticsFromText(
  sourceText: string
): StopPhraseDuplicationDiagnostics {
  const counts = new Map<string, number>();
  for (const match of sourceText.matchAll(STOP_PHRASE_PATTERN)) {
    const normalized = normalizePhrase(match[1]);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return {
    duplicatePhrases: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([phrase, count]) => ({ phrase, count }))
      .sort((left, right) => left.phrase.localeCompare(right.phrase))
  };
}

/**
 * Computes stop-phrase duplication diagnostics for the repository rooted at `rootDir`.
 *
 * **Why it exists:**
 * Keeps the shared stop-language surface from drifting into duplicate summaries that are hard to
 * differentiate in reviews or chat output.
 *
 * **What it talks to:**
 * - Uses `readFileSync` from `node:fs`.
 * - Uses local parsing helpers within this module.
 *
 * @param rootDir - Repository root used to resolve the stop-reason source file.
 * @param relativeFilePath - Optional source-file override for focused tests.
 * @returns Diagnostics describing duplicate normalized stop phrases.
 */
export function computeStopPhraseDuplicationDiagnostics(
  rootDir: string,
  relativeFilePath = DEFAULT_STOP_REASON_FILE
): StopPhraseDuplicationDiagnostics {
  const sourceText = readFileSync(path.join(rootDir, relativeFilePath), "utf8");
  return computeStopPhraseDuplicationDiagnosticsFromText(sourceText);
}

/**
 * Fails closed when canonical autonomous stop phrases are duplicated exactly.
 *
 * **Why it exists:**
 * The shared stop-reason renderer is the highest-value stop-language surface. Duplicate summaries
 * make later edits ambiguous and increase drift risk, so exact duplicates should fail fast.
 *
 * **What it talks to:**
 * - Uses local diagnostics helpers within this module.
 *
 * @param rootDir - Repository root used to resolve the stop-reason source file.
 * @param relativeFilePath - Optional source-file override for focused tests.
 */
export function assertUserFacingStopPhraseDuplication(
  rootDir: string,
  relativeFilePath = DEFAULT_STOP_REASON_FILE
): void {
  const diagnostics = computeStopPhraseDuplicationDiagnostics(rootDir, relativeFilePath);
  if (diagnostics.duplicatePhrases.length === 0) {
    return;
  }

  const lines = [
    "Duplicate canonical autonomous stop phrases detected:",
    ...diagnostics.duplicatePhrases.map(
      (duplicate) => `- ${duplicate.phrase} (count ${duplicate.count})`
    )
  ];
  throw new Error(lines.join("\n"));
}

/**
 * Runs the user-facing stop-phrase duplication check entrypoint.
 *
 * **Why it exists:**
 * Makes the shared stop-language duplication contract runnable from package scripts and CI without
 * duplicating assertion logic.
 *
 * **What it talks to:**
 * - Uses `assertUserFacingStopPhraseDuplication` from this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  try {
    assertUserFacingStopPhraseDuplication(process.cwd());
    console.log("User-facing stop-phrase duplication check passed.");
  } catch (error) {
    console.error("User-facing stop-phrase duplication check failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Normalizes stop-phrase text for duplicate detection.
 *
 * **Why it exists:**
 * Exact stop-language duplication checks should ignore trivial whitespace drift.
 *
 * **What it talks to:**
 * - Uses local string normalization only.
 *
 * @param value - Raw phrase extracted from source text.
 * @returns Whitespace-normalized phrase.
 */
function normalizePhrase(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

if (require.main === module) {
  main();
}
