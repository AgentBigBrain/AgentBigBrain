/**
 * @fileoverview Reports lexical semantic-routing vocabulary in frozen route-owner files.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export type LexicalRoutingBoundaryFindingKind =
  | "pattern_declaration"
  | "semantic_token_set"
  | "semantic_phrase_array";

export interface LexicalRoutingBoundaryRecord {
  path: string;
  content: string;
}

export interface LexicalRoutingBoundaryFinding {
  path: string;
  lineNumber: number;
  kind: LexicalRoutingBoundaryFindingKind;
  excerpt: string;
}

export interface LexicalRoutingBoundaryDiagnostics {
  checkedFileCount: number;
  findings: LexicalRoutingBoundaryFinding[];
}

export type LexicalRoutingBoundaryMode = "all" | "touched";

export const DEFAULT_LEXICAL_ROUTING_BOUNDARY_FILES: readonly string[] = [
  "src/interfaces/conversationRuntime/intentModeResolution.ts",
  "src/interfaces/conversationRuntime/intentModeRouteMetadata.ts",
  "src/interfaces/conversationRuntime/executionIntentClarification.ts",
  "src/interfaces/conversationRuntime/executionPreferenceIntentSignals.ts",
  "src/interfaces/conversationRuntime/directConversationIntent.ts",
  "src/interfaces/contextualFollowupLexicalClassifier.ts",
  "src/interfaces/conversationRuntime/contextualFollowupInterpretationSupport.ts",
  "src/interfaces/conversationRuntime/followUpResolution.ts",
  "src/interfaces/conversationRuntime/pulseContextualFollowup.ts",
  "src/interfaces/conversationRuntime/recentAssistantTurnContext.ts",
  "src/interfaces/routingMap.ts",
  "src/interfaces/conversationExecutionInputPolicy.ts",
  "src/organs/plannerPolicy/liveVerificationPolicy.ts",
  "src/organs/plannerPolicy/liveVerificationRequestPatterns.ts",
  "src/organs/plannerPolicy/explicitActionIntent.ts",
  "src/organs/plannerPolicy/buildExecutionRecoveryPolicy.ts",
  "src/organs/plannerPolicy/promptAssemblyRecoveryGuidance.ts",
  "src/organs/plannerPolicy/workspaceRecoveryFallback.ts",
  "src/core/autonomy/workspaceRecoveryContextClassification.ts",
  "src/core/autonomy/workspaceRecoveryPolicy.ts",
  "src/core/autonomy/liveRunRecovery.ts",
  "src/interfaces/conversationRuntime/conversationWorkerAutoRecovery.ts",
  "src/interfaces/conversationRuntime/workspaceRecoveryContext.ts",
  "src/interfaces/conversationRuntime/sessionDomainRouting.ts",
  "src/interfaces/conversationRuntime/chatTurnRelationshipRecall.ts",
  "src/core/profileMemoryRuntime/profileMemoryContactExtraction.ts",
  "src/core/profileMemoryRuntime/profileMemoryContactCurrentRelationshipExtraction.ts",
  "src/core/profileMemoryRuntime/profileMemoryContactRelationshipHistoryExtraction.ts",
  "src/core/profileMemoryRuntime/profileMemoryContactEmployeeLinkExtraction.ts",
  "src/core/profileMemoryRuntime/profileMemoryContactWorkPeerLinkExtraction.ts",
  "src/core/profileMemoryRuntime/profileMemoryEpisodeExtraction.ts",
  "src/core/profileMemoryRuntime/profileMemoryEpisodeScenarioPrimitives.ts",
  "src/core/profileMemoryRuntime/profileMemoryEpisodeScenarioSupport.ts",
  "src/core/profileMemoryRuntime/profileMemoryHistoricalExtraction.ts",
  "src/core/profileMemoryRuntime/profileMemoryIngestPolicy.ts",
  "src/core/profileMemoryRuntime/profileMemoryTruthGovernanceSources.ts",
  "src/interfaces/trustLexicalClassifier.ts",
  "src/organs/intentRuntime/pulseLexicalRules.ts",
  "src/organs/pulseLexicalClassifier.ts",
  "src/core/hardConstraintCommunicationPolicy.ts"
] as const;

const ALLOWED_BOUNDARY_COMMENT_PATTERN =
  /lexical-boundary:\s*(?:exact|candidate-only|safety|proof|compatibility)/i;
const PATTERN_DECLARATION_PATTERN =
  /\b(?:const|export\s+const)\s+[A-Z0-9_]*(?:PATTERN|PATTERNS)\b/;
const TOKEN_SET_DECLARATION_PATTERN =
  /\b(?:const|export\s+const)\s+[A-Z0-9_]*(?:TOKEN|TOKENS|TERM|TERMS)\b.*\bnew\s+Set\b/;
const PHRASE_ARRAY_DECLARATION_PATTERN =
  /\b(?:const|export\s+const)\s+[A-Z0-9_]*(?:SEQUENCE|SEQUENCES|PHRASE|PHRASES)\b/;
const SEMANTIC_ROUTE_TERMS = [
  "route",
  "routing",
  "intent",
  "relationship",
  "recall",
  "followup",
  "follow-up",
  "workflow",
  "status",
  "browser",
  "build",
  "framework",
  "static"
] as const;

/**
 * Normalizes a filesystem path for stable repo-relative comparison.
 *
 * **Why it exists:**
 * Tool callers and tests pass Windows and POSIX-like paths; the boundary file list should match
 * both without depending on the host separator.
 *
 * **What it talks to:**
 * - Uses local string normalization helpers within this module.
 *
 * @param value - Candidate path to normalize.
 * @returns Slash-separated normalized path.
 */
function normalizeRecordPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Returns repo-relative files touched by the current working tree.
 *
 * **Why it exists:**
 * Branch work needs a lightweight guardrail that catches newly edited frozen route-owner files
 * without forcing maintainers to adjudicate the whole historical lexical inventory on every slice.
 *
 * **What it talks to:**
 * - Uses `execFileSync` (import `execFileSync`) from `node:child_process`.
 *
 * @param rootDir - Repository root used as the Git working directory.
 * @returns Slash-normalized changed file paths.
 */
function listTouchedRepoFiles(rootDir: string): readonly string[] {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", "--relative", "HEAD"],
    {
      cwd: rootDir,
      encoding: "utf8"
    }
  );
  return output
    .split(/\r?\n/)
    .map((entry) => normalizeRecordPath(entry.trim()))
    .filter((entry) => entry.length > 0);
}

/**
 * Classifies one line of source as lexical boundary-relevant when it declares broad route wording.
 *
 * **Why it exists:**
 * Reviewers need a lightweight signal when frozen route-owner files grow regex, token, or phrase
 * surfaces that could become hidden semantic routing.
 *
 * **What it talks to:**
 * - Uses local declaration patterns within this module.
 *
 * @param line - One source line from a frozen file.
 * @returns Finding kind for the line, or `null` when it is not boundary-relevant.
 */
function classifyLexicalBoundaryLine(
  line: string
): LexicalRoutingBoundaryFindingKind | null {
  const normalizedLine = line.toLowerCase();
  if (
    ALLOWED_BOUNDARY_COMMENT_PATTERN.test(line) ||
    !SEMANTIC_ROUTE_TERMS.some((term) => normalizedLine.includes(term))
  ) {
    return null;
  }
  if (PATTERN_DECLARATION_PATTERN.test(line)) {
    return "pattern_declaration";
  }
  if (TOKEN_SET_DECLARATION_PATTERN.test(line)) {
    return "semantic_token_set";
  }
  if (PHRASE_ARRAY_DECLARATION_PATTERN.test(line)) {
    return "semantic_phrase_array";
  }
  return null;
}

/**
 * Computes lexical routing boundary diagnostics from in-memory file records.
 *
 * **Why it exists:**
 * Tests need deterministic coverage without depending on the local repository tree, and the CLI
 * entrypoint needs the same analysis logic.
 *
 * **What it talks to:**
 * - Uses local classification helpers within this module.
 *
 * @param records - Source file records to scan.
 * @param frozenFiles - Repo-relative frozen file paths that should be scanned.
 * @returns Diagnostics containing advisory lexical boundary findings.
 */
export function computeLexicalRoutingBoundaryDiagnosticsFromRecords(
  records: readonly LexicalRoutingBoundaryRecord[],
  frozenFiles: readonly string[] = DEFAULT_LEXICAL_ROUTING_BOUNDARY_FILES
): LexicalRoutingBoundaryDiagnostics {
  const frozenPathSet = new Set(frozenFiles.map(normalizeRecordPath));
  const findings: LexicalRoutingBoundaryFinding[] = [];
  let checkedFileCount = 0;

  for (const record of records) {
    const normalizedPath = normalizeRecordPath(record.path);
    if (!frozenPathSet.has(normalizedPath)) {
      continue;
    }
    checkedFileCount += 1;
    const lines = record.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const kind = classifyLexicalBoundaryLine(line);
      if (!kind) {
        return;
      }
      findings.push({
        path: normalizedPath,
        lineNumber: index + 1,
        kind,
        excerpt: line.trim()
      });
    });
  }

  return {
    checkedFileCount,
    findings
  };
}

/**
 * Computes lexical routing boundary diagnostics for the current repository tree.
 *
 * **Why it exists:**
 * Provides a local review report for frozen route-owner files before behavior slices add more
 * lexical vocabulary.
 *
 * **What it talks to:**
 * - Uses `existsSync` and `readFileSync` from `node:fs`.
 * - Uses `path` from `node:path`.
 *
 * @param rootDir - Repository root used to resolve frozen file paths.
 * @param frozenFiles - Repo-relative frozen file paths that should be scanned.
 * @returns Diagnostics containing advisory lexical boundary findings.
 */
export function computeLexicalRoutingBoundaryDiagnostics(
  rootDir: string,
  frozenFiles: readonly string[] = DEFAULT_LEXICAL_ROUTING_BOUNDARY_FILES,
  mode: LexicalRoutingBoundaryMode = "all"
): LexicalRoutingBoundaryDiagnostics {
  const touchedFileSet = mode === "touched"
    ? new Set(listTouchedRepoFiles(rootDir))
    : null;
  const filesToScan = touchedFileSet === null
    ? [...frozenFiles]
    : frozenFiles.filter((filePath) => touchedFileSet.has(normalizeRecordPath(filePath)));
  const records = filesToScan
    .map((filePath): LexicalRoutingBoundaryRecord | null => {
      const absolutePath = path.join(rootDir, filePath);
      if (!existsSync(absolutePath)) {
        return null;
      }
      return {
        path: filePath,
        content: readFileSync(absolutePath, "utf8")
      };
    })
    .filter((record): record is LexicalRoutingBoundaryRecord => record !== null);
  return computeLexicalRoutingBoundaryDiagnosticsFromRecords(records, frozenFiles);
}

/**
 * Parses CLI arguments for the lexical-boundary report.
 *
 * **Why it exists:**
 * The command needs to support both full advisory scans and touched-file review gates without
 * pulling in a command framework.
 *
 * **What it talks to:**
 * - Uses local string parsing helpers within this module.
 *
 * @param argv - Process argument tail.
 * @returns Parsed scan mode.
 */
function parseLexicalRoutingBoundaryMode(
  argv: readonly string[]
): LexicalRoutingBoundaryMode {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length);
  return mode === "touched" ? "touched" : "all";
}

/**
 * Runs the advisory lexical routing boundary report.
 *
 * **Why it exists:**
 * Gives maintainers and agents one repeatable command to see when a behavior slice grows frozen
 * lexical route-owner vocabulary.
 *
 * **What it talks to:**
 * - Uses `computeLexicalRoutingBoundaryDiagnostics` from this module.
 *
 * @returns Nothing. Results are written to stdout.
 */
function main(): void {
  const mode = parseLexicalRoutingBoundaryMode(process.argv.slice(2));
  const diagnostics = computeLexicalRoutingBoundaryDiagnostics(process.cwd(), undefined, mode);
  console.log(
    `Lexical routing boundary check scanned ${diagnostics.checkedFileCount} frozen files in ${mode} mode.`
  );
  if (diagnostics.findings.length === 0) {
    console.log("No lexical routing boundary findings.");
    return;
  }
  console.log("Lexical routing boundary findings are advisory:");
  for (const finding of diagnostics.findings) {
    console.log(
      `- ${finding.path}:${finding.lineNumber} [${finding.kind}] ${finding.excerpt}`
    );
  }
}

if (require.main === module) {
  main();
}
