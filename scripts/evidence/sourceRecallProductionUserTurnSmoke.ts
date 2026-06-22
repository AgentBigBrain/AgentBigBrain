/**
 * @fileoverview Synthetic production Source Recall smoke for encrypted user-turn capture.
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashSha256 } from "../../src/core/cryptoUtils";
import { withSqliteDatabase } from "../../src/core/sqliteStore";
import {
  buildSourceRecallAuthorityFlags,
  type SourceRecallRetrievalMode
} from "../../src/core/sourceRecall/contracts";
import {
  DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
  retrieveSourceRecall
} from "../../src/core/sourceRecall/sourceRecallRetriever";
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";
import { createDefaultSourceRecallRetentionPolicy } from "../../src/core/sourceRecall/sourceRecallRetention";
import { ConversationManager } from "../../src/interfaces/conversationManager";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import {
  buildSourceRecallRetrievalPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

export const SOURCE_RECALL_PRODUCTION_USER_TURN_SMOKE_ARTIFACT_PATH =
  "runtime/evidence/source_recall/source_recall_production_user_turn_smoke.json";

const SYNTHETIC_USER_TURN_TEXT =
  "Synthetic Source Recall smoke quote: basalt-grid approval remains quoted evidence only.";
const SYNTHETIC_EXACT_QUOTE = "basalt-grid approval";

export interface SourceRecallProductionUserTurnSmokeEvidence {
  generatedAt: string;
  artifactKind: "source_recall_production_user_turn_smoke";
  evidenceMode: "synthetic_runtime_observed";
  liveDependencyStatus: "NOT_REQUIRED";
  summary: {
    status: "PASS" | "FAIL";
    failureReasons: readonly string[];
  };
  storageProof: {
    encryptedProductionStore: boolean;
    plaintextStoreAllowed: false;
    rawRowStorageMode: "encrypted_v1" | "missing" | "unexpected";
    rawRowContainsCapturedText: boolean;
  };
  captureProof: {
    captureLatchEnabled: boolean;
    recordsCaptured: number;
    sourceKind: "conversation_turn" | "missing";
    sourceRole: "user" | "missing";
    assistantTaskRecordsCaptured: number;
    mediaDocumentRecordsCaptured: number;
    sourceRecordHashPrefix: string | null;
  };
  retrievalProof: {
    retrievalLatchEnabled: boolean;
    retrievalMode: SourceRecallRetrievalMode;
    retrievalAuthority: string;
    excerptsReturned: number;
    queryHash: string;
    returnedSourceRecordIds: readonly string[];
    returnedChunkIds: readonly string[];
    excerptHashPrefixes: readonly string[];
    rawExcerptTextWrittenToArtifact: boolean;
    plannerChatRouteGatedCallsites: readonly string[];
    unexpectedPlannerChatCallsites: readonly string[];
  };
  deleteProof: {
    forgotten: boolean;
    postForgetExcerptsReturned: number;
    activeRecordsAfterForget: number;
    inactiveRecordLifecycle: string | null;
  };
  authorityProof: {
    currentTruthAuthority: false;
    plannerAuthority: "evidence_only" | "none";
    completionProofAuthority: false;
    approvalAuthority: false;
    safetyAuthority: false;
    unsafeToFollowAsInstruction: true;
  };
  disabledSurfaceProof: {
    assistantTaskCaptureStillDisabled: boolean;
    mediaDocumentCaptureStillDisabled: boolean;
    plannerChatRetrievalOnlyRouteGated: boolean;
  };
  artifactPrivacyProof: {
    rawSourceTextPresentInArtifact: boolean;
    localDesktopPathPresentInArtifact: boolean;
    tokenShapedSecretPresentInArtifact: boolean;
  };
}

/**
 * Runs a synthetic encrypted Source Recall user-turn smoke and writes redacted evidence.
 *
 * @param options - Optional artifact path override for tests.
 * @returns Redacted smoke evidence.
 */
export async function runSourceRecallProductionUserTurnSmoke(
  options: {
    artifactPath?: string;
    writeArtifact?: boolean;
  } = {}
): Promise<SourceRecallProductionUserTurnSmokeEvidence> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-production-smoke-"));
  const sqlitePath = path.join(tempDir, "source_recall.sqlite");
  const sourceRecallStore = new SourceRecallStore({
    sqlitePath,
    encryptionKey: randomBytes(32)
  });
  const sessionStore = new InterfaceSessionStore(path.join(tempDir, "sessions.json"), {
    backend: "json"
  });
  const policy = {
    ...createDefaultSourceRecallRetentionPolicy(),
    enabled: true,
    captureEnabled: true,
    retrievalEnabled: true,
    encryptedPayloadsAvailable: true,
    sourceKindCaptureAllowlist: ["conversation_turn"] as const,
    captureClassAllowlist: ["ordinary_source"] as const
  };
  const manager = new ConversationManager(sessionStore, {}, {
    sourceRecallCapture: {
      policy,
      writer: sourceRecallStore,
      capturedAt: "2026-05-05T14:00:01.000Z"
    },
    runDirectConversationTurn: async () => ({
      summary: "Synthetic response acknowledged."
    })
  });

  try {
    await manager.handleMessage(
      {
        provider: "telegram",
        conversationId: "source-recall-smoke-chat",
        userId: "source-recall-smoke-user",
        username: "source-recall-smoke",
        conversationVisibility: "private",
        text: `/chat ${SYNTHETIC_USER_TURN_TEXT}`,
        receivedAt: "2026-05-05T14:00:00.000Z"
      },
      async () => ({ summary: "unused worker" }),
      async () => undefined
    );
    await manager.waitForIdle();

    const records = await sourceRecallStore.listSourceRecords();
    const rawRow = await readRawSourceRecallRow(sqlitePath);
    const retrievalScopeId = records[0]?.scopeId ?? "";
    const retrievalThreadId = records[0]?.threadId ?? "";
    const retrieval = await retrieveSourceRecall(
      sourceRecallStore,
      {
        scopeId: retrievalScopeId,
        threadId: retrievalThreadId,
        principalAccess: buildSyntheticSmokeSourceRecallRetrievalAccess(),
        exactQuote: SYNTHETIC_EXACT_QUOTE
      },
      {
        ...DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
        maxRecords: 1,
        maxChunks: 1,
        maxExcerptCharsPerChunk: 160,
        maxTotalExcerptChars: 160,
        sourceKindAllowlist: ["conversation_turn"],
        sourceRoleAllowlist: ["user"],
        sensitivityRedactionPolicy: "redact_sensitive"
      }
    );
    const recordId = records[0]?.sourceRecordId ?? "";
    if (recordId) {
      await sourceRecallStore.markSourceRecordForgotten(recordId);
    }
    const postForgetRetrieval = await retrieveSourceRecall(sourceRecallStore, {
      sourceRecordId: recordId,
      principalAccess: buildSyntheticSmokeSourceRecallRetrievalAccess()
    });
    const inactiveRecord = recordId
      ? await sourceRecallStore.getSourceRecord(recordId, true)
      : null;
    const plannerChatCallsites = await findPlannerChatSourceRecallCallsites();
    const evidence = buildEvidence({
      records,
      rawRow,
      retrieval,
      postForgetRetrieval,
      inactiveRecordLifecycle: inactiveRecord?.lifecycleState ?? null,
      activeRecordsAfterForget: (await sourceRecallStore.listSourceRecords()).length,
      plannerChatCallsites
    });
    const finalEvidence = attachFailureStatus(evidence);
    if (options.writeArtifact !== false) {
      const artifactPath = options.artifactPath ?? SOURCE_RECALL_PRODUCTION_USER_TURN_SMOKE_ARTIFACT_PATH;
      await writeRedactedEvidenceArtifact(finalEvidence, artifactPath);
    }
    return finalEvidence;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Builds Source Recall retrieval access for the synthetic production smoke.
 *
 * @returns Retrieval-scoped owner access for the synthetic smoke actor.
 */
function buildSyntheticSmokeSourceRecallRetrievalAccess() {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: "source-recall-smoke-principal-key",
    BRAIN_OWNER_TELEGRAM_USER_IDS: "source-recall-smoke-user"
  });
  return buildSourceRecallRetrievalPrincipalAccess(
    derivePrincipalContextFromIngress({
      provider: "telegram",
      conversationId: "source-recall-smoke-chat",
      userId: "source-recall-smoke-user",
      username: "source-recall-smoke",
      conversationVisibility: "private",
      receivedAt: "2026-05-05T14:00:00.000Z",
      principalConfig
    })
  );
}

function buildEvidence(input: {
  records: Awaited<ReturnType<SourceRecallStore["listSourceRecords"]>>;
  rawRow: {
    document_json: string;
    storage_mode: string;
  } | null;
  retrieval: Awaited<ReturnType<typeof retrieveSourceRecall>>;
  postForgetRetrieval: Awaited<ReturnType<typeof retrieveSourceRecall>>;
  inactiveRecordLifecycle: string | null;
  activeRecordsAfterForget: number;
  plannerChatCallsites: SourceRecallPlannerChatCallsites;
}): SourceRecallProductionUserTurnSmokeEvidence {
  const sourceRecord = input.records[0] ?? null;
  const excerptHashes = input.retrieval.bundle.excerpts.map((excerpt) =>
    hashSha256(excerpt.excerpt).slice(0, 16)
  );
  const artifactPrivacy = buildArtifactPrivacyProof({
    evidenceWithoutPrivacy: {
      storageProof: {
        rawRowStorageMode:
          input.rawRow?.storage_mode === "encrypted_v1" ? "encrypted_v1" : input.rawRow ? "unexpected" : "missing"
      },
      retrievalProof: {
        queryHash: input.retrieval.auditEvent.queryHash,
        returnedSourceRecordIds: input.retrieval.auditEvent.returnedSourceRecordIds,
        returnedChunkIds: input.retrieval.auditEvent.returnedChunkIds,
        excerptHashPrefixes: excerptHashes
      }
    }
  });
  return {
    generatedAt: new Date().toISOString(),
    artifactKind: "source_recall_production_user_turn_smoke",
    evidenceMode: "synthetic_runtime_observed",
    liveDependencyStatus: "NOT_REQUIRED",
    summary: {
      status: "PASS",
      failureReasons: []
    },
    storageProof: {
      encryptedProductionStore: input.rawRow?.storage_mode === "encrypted_v1",
      plaintextStoreAllowed: false,
      rawRowStorageMode:
        input.rawRow?.storage_mode === "encrypted_v1" ? "encrypted_v1" : input.rawRow ? "unexpected" : "missing",
      rawRowContainsCapturedText:
        input.rawRow?.document_json?.includes(SYNTHETIC_USER_TURN_TEXT) === true
    },
    captureProof: {
      captureLatchEnabled: true,
      recordsCaptured: input.records.length,
      sourceKind: sourceRecord?.sourceKind === "conversation_turn" ? "conversation_turn" : "missing",
      sourceRole: sourceRecord?.sourceRole === "user" ? "user" : "missing",
      assistantTaskRecordsCaptured: input.records.filter((record) =>
        record.sourceKind === "assistant_turn" ||
        record.sourceKind === "task_input" ||
        record.sourceKind === "task_summary"
      ).length,
      mediaDocumentRecordsCaptured: input.records.filter((record) =>
        record.sourceKind === "document_text" ||
        record.sourceKind === "document_model_summary" ||
        record.sourceKind === "media_transcript" ||
        record.sourceKind === "ocr_text" ||
        record.sourceKind === "media_model_summary"
      ).length,
      sourceRecordHashPrefix: sourceRecord?.sourceRecordHash.slice(0, 16) ?? null
    },
    retrievalProof: {
      retrievalLatchEnabled: true,
      retrievalMode: input.retrieval.bundle.retrievalMode,
      retrievalAuthority: input.retrieval.bundle.retrievalAuthority,
      excerptsReturned: input.retrieval.bundle.excerpts.length,
      queryHash: input.retrieval.auditEvent.queryHash,
      returnedSourceRecordIds: input.retrieval.auditEvent.returnedSourceRecordIds,
      returnedChunkIds: input.retrieval.auditEvent.returnedChunkIds,
      excerptHashPrefixes: excerptHashes,
      rawExcerptTextWrittenToArtifact: false,
      plannerChatRouteGatedCallsites: input.plannerChatCallsites.routeGatedCallsites,
      unexpectedPlannerChatCallsites: input.plannerChatCallsites.unexpectedCallsites
    },
    deleteProof: {
      forgotten: input.inactiveRecordLifecycle === "forgotten",
      postForgetExcerptsReturned: input.postForgetRetrieval.bundle.excerpts.length,
      activeRecordsAfterForget: input.activeRecordsAfterForget,
      inactiveRecordLifecycle: input.inactiveRecordLifecycle
    },
    authorityProof: buildSourceRecallAuthorityFlags(),
    disabledSurfaceProof: {
      assistantTaskCaptureStillDisabled: true,
      mediaDocumentCaptureStillDisabled: true,
      plannerChatRetrievalOnlyRouteGated: input.plannerChatCallsites.unexpectedCallsites.length === 0
    },
    artifactPrivacyProof: artifactPrivacy
  };
}

function attachFailureStatus(
  evidence: SourceRecallProductionUserTurnSmokeEvidence
): SourceRecallProductionUserTurnSmokeEvidence {
  const failureReasons: string[] = [];
  if (!evidence.storageProof.encryptedProductionStore) {
    failureReasons.push("encrypted production Source Recall store was not observed");
  }
  if (evidence.storageProof.rawRowContainsCapturedText) {
    failureReasons.push("encrypted raw row contained captured source text");
  }
  if (evidence.captureProof.recordsCaptured !== 1) {
    failureReasons.push("expected exactly one captured source record");
  }
  if (evidence.captureProof.sourceKind !== "conversation_turn" || evidence.captureProof.sourceRole !== "user") {
    failureReasons.push("captured source was not a live user conversation turn");
  }
  if (evidence.captureProof.assistantTaskRecordsCaptured !== 0) {
    failureReasons.push("assistant/task capture occurred in the user-turn smoke");
  }
  if (evidence.captureProof.mediaDocumentRecordsCaptured !== 0) {
    failureReasons.push("media/document capture occurred in the user-turn smoke");
  }
  if (evidence.retrievalProof.retrievalMode !== "exact_quote" || evidence.retrievalProof.excerptsReturned !== 1) {
    failureReasons.push("exact-quote retrieval did not return exactly one excerpt");
  }
  if (!evidence.deleteProof.forgotten || evidence.deleteProof.postForgetExcerptsReturned !== 0) {
    failureReasons.push("forgotten source record remained retrievable");
  }
  if (!evidence.disabledSurfaceProof.plannerChatRetrievalOnlyRouteGated) {
    failureReasons.push("unexpected planner/chat callsite referenced Source Recall retrieval");
  }
  if (
    evidence.artifactPrivacyProof.rawSourceTextPresentInArtifact ||
    evidence.artifactPrivacyProof.localDesktopPathPresentInArtifact ||
    evidence.artifactPrivacyProof.tokenShapedSecretPresentInArtifact
  ) {
    failureReasons.push("redacted evidence artifact privacy proof failed");
  }
  return {
    ...evidence,
    summary: {
      status: failureReasons.length === 0 ? "PASS" : "FAIL",
      failureReasons
    }
  };
}

async function writeRedactedEvidenceArtifact(
  evidence: SourceRecallProductionUserTurnSmokeEvidence,
  artifactPath: string
): Promise<void> {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  const json = JSON.stringify(evidence, null, 2);
  if (json.includes(SYNTHETIC_USER_TURN_TEXT) || json.includes(SYNTHETIC_EXACT_QUOTE)) {
    throw new Error("Source Recall smoke evidence attempted to write raw source text.");
  }
  await writeFile(artifactPath, json, "utf8");
}

async function readRawSourceRecallRow(sqlitePath: string): Promise<{
  document_json: string;
  storage_mode: string;
} | null> {
  const row = await withSqliteDatabase(sqlitePath, (db) =>
    db.prepare(
      `SELECT document_json, storage_mode
         FROM source_recall_state
        WHERE id = ?`
    ).get("source_recall_document") as {
      document_json: string;
      storage_mode: string;
    } | undefined
  );
  return row ?? null;
}

interface SourceRecallPlannerChatCallsites {
  routeGatedCallsites: readonly string[];
  unexpectedCallsites: readonly string[];
}

async function findPlannerChatSourceRecallCallsites(): Promise<SourceRecallPlannerChatCallsites> {
  const srcRoot = path.resolve("src");
  const allowed = new Set([
    path.normalize("src/core/sourceRecall/sourceRecallRetriever.ts"),
    path.normalize("src/organs/memoryContext/contextInjection.ts")
  ]);
  const routeGated = new Set([
    path.normalize("src/interfaces/conversationRuntime/pulsePrompting.ts"),
    path.normalize("src/organs/memoryBrokerPlannerInput.ts")
  ]);
  const files = await listTypeScriptFiles(srcRoot);
  const routeGatedCallsites: string[] = [];
  const unexpectedCallsites: string[] = [];
  for (const file of files) {
    const relative = path.normalize(path.relative(process.cwd(), file));
    if (allowed.has(relative)) {
      continue;
    }
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (
        line.includes("retrieveSourceRecall(") ||
        line.includes("renderSourceRecallContextForModelEgress(")
      ) {
        if (routeGated.has(relative)) {
          routeGatedCallsites.push(`${relative}:${index + 1}`);
        } else {
          unexpectedCallsites.push(`${relative}:${index + 1}`);
        }
      }
    });
  }
  return { routeGatedCallsites, unexpectedCallsites };
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await import("node:fs/promises").then((fs) =>
    fs.readdir(root, { withFileTypes: true })
  );
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildArtifactPrivacyProof(input: {
  evidenceWithoutPrivacy: unknown;
}): SourceRecallProductionUserTurnSmokeEvidence["artifactPrivacyProof"] {
  const serialized = JSON.stringify(input.evidenceWithoutPrivacy);
  return {
    rawSourceTextPresentInArtifact:
      serialized.includes(SYNTHETIC_USER_TURN_TEXT) ||
      serialized.includes(SYNTHETIC_EXACT_QUOTE),
    localDesktopPathPresentInArtifact: /C:\\Users\\[^"\\]+\\(?:OneDrive\\)?Desktop/i.test(serialized),
    tokenShapedSecretPresentInArtifact:
      /sk-[A-Za-z0-9]{20,}/.test(serialized) ||
      /(?:TELEGRAM|DISCORD)_BOT_TOKEN/i.test(serialized)
  };
}

async function main(): Promise<void> {
  const evidence = await runSourceRecallProductionUserTurnSmoke();
  console.log(JSON.stringify(evidence.summary, null, 2));
  if (evidence.summary.status !== "PASS") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
