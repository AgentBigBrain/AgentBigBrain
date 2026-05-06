/**
 * @fileoverview Live Telegram/Desktop Source Recall smoke with redacted evidence output.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashSha256 } from "../../src/core/cryptoUtils";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { withSqliteDatabase } from "../../src/core/sqliteStore";
import {
  DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
  retrieveSourceRecall
} from "../../src/core/sourceRecall/sourceRecallRetriever";
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";
import { runTelegramDesktopWorkflowAndCleanupLiveSmoke } from "./telegramDesktopWorkflowAndCleanupLiveSmoke";

export const SOURCE_RECALL_TELEGRAM_DESKTOP_LIVE_SMOKE_ARTIFACT_PATH =
  "runtime/evidence/source_recall/source_recall_telegram_desktop_live_smoke.json";

interface EnvSnapshot {
  [key: string]: string | undefined;
}

interface RawSourceRecallRow {
  document_json: string;
  storage_mode: string;
}

interface SourceRecallTelegramDesktopLiveSmokeEvidence {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  evidenceMode: "live_telegram_desktop_observed";
  liveDependencyStatus: "LIVE_SMOKE";
  failureReasons: readonly string[];
  desktopWorkflowProof: {
    status: "PASS" | "FAIL" | "BLOCKED";
    browserOpened: boolean;
    browserClosed: boolean;
    desktopCleanupMovedTargetFolder: boolean;
    targetFolderNameHashPrefix: string | null;
  };
  sourceRecallProof: {
    encryptedProductionStore: boolean;
    plaintextStoreAllowed: false;
    rawRowStorageMode: string | null;
    rawRowContainsTargetQuote: boolean;
    recordsCaptured: number;
    conversationTurnRecordsCaptured: number;
    assistantTurnRecordsCaptured: number;
    taskRecordsCaptured: number;
    mediaDocumentRecordsCaptured: number;
    exactQuoteRetrieved: boolean;
    retrievalMode: string | null;
    retrievalAuthority: string | null;
    excerptsReturned: number;
    queryHash: string | null;
    returnedSourceRecordIds: readonly string[];
    returnedChunkIds: readonly string[];
    excerptHashPrefixes: readonly string[];
    authority: {
      currentTruthAuthority: false;
      plannerAuthority: "evidence_only" | "none";
      completionProofAuthority: false;
      approvalAuthority: false;
      safetyAuthority: false;
      unsafeToFollowAsInstruction: true;
    } | null;
  };
  artifactPrivacyProof: {
    rawTargetFolderNamePresentInArtifact: boolean;
    localDesktopPathPresentInArtifact: boolean;
    tokenShapedSecretPresentInArtifact: boolean;
  };
}

const COMMAND = "npx tsx scripts/evidence/sourceRecallTelegramDesktopLiveSmoke.ts";
const TOKEN_SHAPED_SECRET_PATTERN =
  /(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|\b[0-9]{8,10}:[A-Za-z0-9_-]{35,}\b)/;

function applyEnvOverrides(overrides: Readonly<Record<string, string>>): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const [key, value] of Object.entries(overrides)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

/**
 * Runs the live Telegram/Desktop workflow with encrypted Source Recall enabled.
 *
 * @param options - Optional artifact-writing controls.
 * @returns Redacted evidence for the live Source Recall run.
 */
export async function runSourceRecallTelegramDesktopLiveSmoke(
  options: {
    writeArtifact?: boolean;
    artifactPath?: string;
  } = {}
): Promise<SourceRecallTelegramDesktopLiveSmokeEvidence> {
  ensureEnvLoaded();
  const runId = `${Date.now()}`;
  const sqlitePath = path.resolve(
    process.cwd(),
    `runtime/tmp-source-recall-telegram-desktop-live-${runId}.sqlite`
  );
  const encryptionKey = randomBytes(32);
  const envSnapshot = applyEnvOverrides({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_RETRIEVAL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_PROJECTION_ENABLED: "false",
    BRAIN_SOURCE_RECALL_OPERATOR_FULL_PROJECTION_ENABLED: "false",
    BRAIN_SOURCE_RECALL_INDEX_ENABLED: "false",
    BRAIN_SOURCE_RECALL_EVIDENCE_MODE: "false",
    BRAIN_SOURCE_RECALL_SQLITE_PATH: sqlitePath,
    BRAIN_SOURCE_RECALL_ENCRYPTION_KEY: encryptionKey.toString("base64"),
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS:
      "conversation_turn,assistant_turn,task_input,task_summary",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES:
      "ordinary_source,assistant_output,operational_output"
  });

  try {
    const desktopArtifact = await runTelegramDesktopWorkflowAndCleanupLiveSmoke();
    const store = new SourceRecallStore({
      sqlitePath,
      encryptionKey
    });
    const rawRow = await readRawSourceRecallRow(sqlitePath);
    const records = await store.listSourceRecords({ includeInactive: true });
    const targetFolderName = desktopArtifact.targetFolderName;
    const retrieval = await retrieveSourceRecall(
      store,
      {
        exactQuote: targetFolderName,
        sourceKinds: ["conversation_turn"],
        sourceRoles: ["user"]
      },
      {
        ...DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
        maxRecords: 2,
        maxChunks: 2,
        maxExcerptCharsPerChunk: 180,
        maxTotalExcerptChars: 360,
        sourceKindAllowlist: ["conversation_turn"],
        sourceRoleAllowlist: ["user"],
        sensitivityRedactionPolicy: "redact_sensitive"
      }
    );

    const sourceRecallProof = {
      encryptedProductionStore: rawRow?.storage_mode === "encrypted_v1",
      plaintextStoreAllowed: false as const,
      rawRowStorageMode: rawRow?.storage_mode ?? null,
      rawRowContainsTargetQuote: rawRow?.document_json.includes(targetFolderName) === true,
      recordsCaptured: records.length,
      conversationTurnRecordsCaptured: records.filter(
        (record) => record.sourceKind === "conversation_turn"
      ).length,
      assistantTurnRecordsCaptured: records.filter(
        (record) => record.sourceKind === "assistant_turn"
      ).length,
      taskRecordsCaptured: records.filter(
        (record) => record.sourceKind === "task_input" || record.sourceKind === "task_summary"
      ).length,
      mediaDocumentRecordsCaptured: records.filter(
        (record) =>
          record.sourceKind === "document_text" ||
          record.sourceKind === "document_model_summary" ||
          record.sourceKind === "media_transcript" ||
          record.sourceKind === "ocr_text" ||
          record.sourceKind === "media_model_summary"
      ).length,
      exactQuoteRetrieved: retrieval.bundle.excerpts.length > 0,
      retrievalMode: retrieval.bundle.retrievalMode,
      retrievalAuthority: retrieval.bundle.retrievalAuthority,
      excerptsReturned: retrieval.bundle.excerpts.length,
      queryHash: retrieval.auditEvent.queryHash,
      returnedSourceRecordIds: retrieval.auditEvent.returnedSourceRecordIds,
      returnedChunkIds: retrieval.auditEvent.returnedChunkIds,
      excerptHashPrefixes: retrieval.bundle.excerpts.map((excerpt) =>
        hashSha256(excerpt.excerpt).slice(0, 16)
      ),
      authority: retrieval.bundle.authority
    };

    const failureReasons = buildFailureReasons({
      desktopStatus: desktopArtifact.status,
      sourceRecallProof
    });
    const evidenceWithoutPrivacy: Omit<
      SourceRecallTelegramDesktopLiveSmokeEvidence,
      "artifactPrivacyProof"
    > = {
      generatedAt: new Date().toISOString(),
      command: COMMAND,
      status:
        failureReasons.length === 0
          ? "PASS"
          : desktopArtifact.status === "BLOCKED"
            ? "BLOCKED"
            : "FAIL",
      evidenceMode: "live_telegram_desktop_observed",
      liveDependencyStatus: "LIVE_SMOKE",
      failureReasons,
      desktopWorkflowProof: {
        status: desktopArtifact.status,
        browserOpened: desktopArtifact.checks.buildOpenedBrowser,
        browserClosed: desktopArtifact.checks.browserClosed,
        desktopCleanupMovedTargetFolder: desktopArtifact.checks.desktopCleanupMovedTargetFolder,
        targetFolderNameHashPrefix: hashSha256(targetFolderName).slice(0, 16)
      },
      sourceRecallProof
    };
    const evidence = {
      ...evidenceWithoutPrivacy,
      artifactPrivacyProof: buildArtifactPrivacyProof(evidenceWithoutPrivacy, targetFolderName)
    };

    if (options.writeArtifact !== false) {
      const artifactPath =
        options.artifactPath ?? SOURCE_RECALL_TELEGRAM_DESKTOP_LIVE_SMOKE_ARTIFACT_PATH;
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    return evidence;
  } finally {
    restoreEnv(envSnapshot);
    await rm(sqlitePath, { force: true }).catch(() => undefined);
    await rm(`${sqlitePath}-shm`, { force: true }).catch(() => undefined);
    await rm(`${sqlitePath}-wal`, { force: true }).catch(() => undefined);
  }
}

function buildFailureReasons(input: {
  desktopStatus: "PASS" | "FAIL" | "BLOCKED";
  sourceRecallProof: SourceRecallTelegramDesktopLiveSmokeEvidence["sourceRecallProof"];
}): string[] {
  const reasons: string[] = [];
  if (input.desktopStatus !== "PASS") {
    reasons.push(`desktop_workflow_${input.desktopStatus.toLowerCase()}`);
  }
  if (!input.sourceRecallProof.encryptedProductionStore) {
    reasons.push("source_recall_storage_not_encrypted");
  }
  if (input.sourceRecallProof.rawRowContainsTargetQuote) {
    reasons.push("source_recall_raw_row_contains_live_quote");
  }
  if (input.sourceRecallProof.recordsCaptured === 0) {
    reasons.push("source_recall_no_records_captured");
  }
  if (input.sourceRecallProof.conversationTurnRecordsCaptured === 0) {
    reasons.push("source_recall_no_conversation_turn_records");
  }
  if (!input.sourceRecallProof.exactQuoteRetrieved) {
    reasons.push("source_recall_exact_quote_not_retrieved");
  }
  if (input.sourceRecallProof.authority?.currentTruthAuthority !== false) {
    reasons.push("source_recall_current_truth_authority_not_false");
  }
  if (input.sourceRecallProof.authority?.completionProofAuthority !== false) {
    reasons.push("source_recall_completion_proof_authority_not_false");
  }
  if (input.sourceRecallProof.authority?.approvalAuthority !== false) {
    reasons.push("source_recall_approval_authority_not_false");
  }
  if (input.sourceRecallProof.authority?.safetyAuthority !== false) {
    reasons.push("source_recall_safety_authority_not_false");
  }
  if (input.sourceRecallProof.authority?.unsafeToFollowAsInstruction !== true) {
    reasons.push("source_recall_instruction_isolation_not_true");
  }
  return reasons;
}

function buildArtifactPrivacyProof(
  evidence: Omit<SourceRecallTelegramDesktopLiveSmokeEvidence, "artifactPrivacyProof">,
  targetFolderName: string
): SourceRecallTelegramDesktopLiveSmokeEvidence["artifactPrivacyProof"] {
  const serialized = JSON.stringify(evidence);
  return {
    rawTargetFolderNamePresentInArtifact: serialized.includes(targetFolderName),
    localDesktopPathPresentInArtifact: /(?:[A-Z]:\\Users\\|\/home\/runner\/)/i.test(serialized),
    tokenShapedSecretPresentInArtifact: TOKEN_SHAPED_SECRET_PATTERN.test(serialized)
  };
}

async function readRawSourceRecallRow(sqlitePath: string): Promise<RawSourceRecallRow | null> {
  return withSqliteDatabase(sqlitePath, (database) => {
    const row = database
      .prepare(
        "SELECT document_json, storage_mode FROM source_recall_state WHERE id = 'source_recall_document'"
      )
      .get() as RawSourceRecallRow | undefined;
    return row ?? null;
  });
}

async function main(): Promise<void> {
  const evidence = await runSourceRecallTelegramDesktopLiveSmoke();
  console.log(`Source Recall Telegram/Desktop live smoke status: ${evidence.status}`);
  console.log(`Artifact: ${path.resolve(SOURCE_RECALL_TELEGRAM_DESKTOP_LIVE_SMOKE_ARTIFACT_PATH)}`);
  if (evidence.failureReasons.length > 0) {
    console.error(`Failures: ${evidence.failureReasons.join(", ")}`);
  }
  if (evidence.status !== "PASS") {
    process.exit(1);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
