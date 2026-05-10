/**
 * @fileoverview Governed Source Recall capture helpers for live conversation turns.
 */

import { hashSha256 } from "../cryptoUtils";
import type { TaskPrincipalAccessEnvelope } from "../runtimeTypes/taskPlanningTypes";
import {
  buildSourceRecallAuthorityFlags,
  type SourceRecallChunk,
  type SourceRecallRecord,
  type SourceRecallPrincipalMetadata,
  type SourceRecallSourceKind,
  type SourceRecallSourceRole,
  type SourceRecallCaptureClass,
  type SourceRecallFreshness,
  type SourceRecallSourceTimeKind
} from "./contracts";
import {
  buildSourceRecallCaptureFailureDiagnostic,
  decideSourceRecallCapture,
  type SourceRecallCaptureFailureDiagnostic,
  type SourceRecallRetentionPolicy
} from "./sourceRecallRetention";

const LIVE_USER_TURN_MAX_CHUNK_CHARS = 2000;
const LIVE_USER_TURN_CHUNK_OVERLAP_CHARS = 200;
const LIVE_USER_TURN_MAX_CHUNKS = 128;

export interface SourceRecallRecordWriter {
  upsertSourceRecord(record: SourceRecallRecord, chunks: readonly SourceRecallChunk[]): Promise<void>;
}

export interface LiveUserTurnSourceRecallCaptureInput {
  scopeId: string;
  threadId: string;
  conversationId: string;
  turn: {
    id?: string;
    role: "user";
    text: string;
    at: string;
  };
  policy: SourceRecallRetentionPolicy;
  writer: SourceRecallRecordWriter;
  capturedAt?: string;
  principalAccess?: TaskPrincipalAccessEnvelope;
}

export type LiveUserTurnSourceRecallCaptureResult =
  | {
      status: "captured";
      sourceRecordId: string;
      chunkIds: string[];
      capturedAt: string;
      sourceRecordHash: string;
    }
  | {
      status: "blocked";
      diagnostic: SourceRecallCaptureFailureDiagnostic;
      reasons: readonly string[];
    }
  | {
      status: "failed";
      diagnostic: SourceRecallCaptureFailureDiagnostic;
    };

export interface LiveUserTurnSourceRecallArtifacts {
  record: SourceRecallRecord;
  chunks: SourceRecallChunk[];
}

export interface LowerAuthoritySourceRecallCaptureInput {
  scopeId: string;
  threadId: string;
  text: string;
  observedAt: string;
  sourceKind: Extract<
    SourceRecallSourceKind,
    | "assistant_turn"
    | "task_input"
    | "task_summary"
    | "media_transcript"
    | "ocr_text"
    | "media_model_summary"
    | "document_text"
    | "document_model_summary"
  >;
  sourceRole: Extract<SourceRecallSourceRole, "user" | "assistant" | "tool" | "runtime">;
  captureClass: Extract<
    SourceRecallCaptureClass,
    "ordinary_source" | "assistant_output" | "operational_output" | "external_output"
  >;
  sourceAuthority: Extract<
    SourceRecallRecord["sourceAuthority"],
    | "semantic_model"
    | "strict_schema"
    | "stale_runtime_context"
    | "media_transcript"
    | "media_model_summary"
    | "document_text"
    | "document_model_summary"
  >;
  sourceTimeKind: SourceRecallSourceTimeKind;
  freshness: SourceRecallFreshness;
  originSurface: string;
  originRefId: string;
  originParentRefId?: string;
  policy: SourceRecallRetentionPolicy;
  writer: SourceRecallRecordWriter;
  capturedAt?: string;
  principalAccess?: TaskPrincipalAccessEnvelope;
}

export type LowerAuthoritySourceRecallCaptureResult = LiveUserTurnSourceRecallCaptureResult;

/**
 * Captures one live user turn as Source Recall quoted evidence when policy allows it.
 *
 * **Why it exists:**
 * Live user text is useful recall evidence, but capture must be optional, governed, and unable to
 * crash the normal conversation write path. This helper stores only source records/chunks and
 * returns bounded diagnostics with no raw turn text on blocked or failed writes.
 *
 * **What it talks to:**
 * - Uses `decideSourceRecallCapture` from `./sourceRecallRetention`.
 * - Uses the caller-provided `SourceRecallRecordWriter` seam.
 *
 * @param input - Live user turn, policy, writer, and origin metadata.
 * @returns Capture result with source ids or bounded diagnostics.
 */
export async function captureLiveUserTurnSourceRecall(
  input: LiveUserTurnSourceRecallCaptureInput
): Promise<LiveUserTurnSourceRecallCaptureResult> {
  const artifacts = buildLiveUserTurnSourceRecallArtifacts(input);
  const decision = decideSourceRecallCapture(input.policy, {
    sourceKind: artifacts.record.sourceKind,
    sourceRole: artifacts.record.sourceRole,
    captureClass: artifacts.record.captureClass
  });

  if (!decision.allowed) {
    return {
      status: "blocked",
      reasons: decision.reasons,
      diagnostic: buildSourceRecallCaptureFailureDiagnostic(
        {
          sourceKind: artifacts.record.sourceKind,
          sourceRole: artifacts.record.sourceRole,
          captureClass: artifacts.record.captureClass
        },
        "source_recall_live_user_turn_capture_blocked",
        {
          originRefId: artifacts.record.originRef.refId,
          sourceHashPrefix: artifacts.record.sourceRecordHash.slice(0, 12)
        }
      )
    };
  }

  try {
    await input.writer.upsertSourceRecord(artifacts.record, artifacts.chunks);
    return {
      status: "captured",
      sourceRecordId: artifacts.record.sourceRecordId,
      chunkIds: artifacts.chunks.map((chunk) => chunk.chunkId),
      capturedAt: artifacts.record.capturedAt,
      sourceRecordHash: artifacts.record.sourceRecordHash
    };
  } catch {
    return {
      status: "failed",
      diagnostic: buildSourceRecallCaptureFailureDiagnostic(
        {
          sourceKind: artifacts.record.sourceKind,
          sourceRole: artifacts.record.sourceRole,
          captureClass: artifacts.record.captureClass
        },
        "source_recall_live_user_turn_capture_failed",
        {
          originRefId: artifacts.record.originRef.refId,
          sourceHashPrefix: artifacts.record.sourceRecordHash.slice(0, 12)
        }
      )
    };
  }
}

/**
 * Captures assistant output, task input, or task summary text as lower-authority Source Recall.
 *
 * **Why it exists:**
 * Assistant and task surfaces are useful for "what happened" recall, but they must remain
 * generated/runtime evidence rather than user truth, completion proof, or approval. Transport and
 * task origin refs are hashed so download URLs, provider ids, or raw remote handles are not stored.
 *
 * **What it talks to:**
 * - Uses `decideSourceRecallCapture` from `./sourceRecallRetention`.
 * - Uses the caller-provided `SourceRecallRecordWriter` seam.
 *
 * @param input - Lower-authority source text plus policy, writer, and origin metadata.
 * @returns Capture result with source ids or bounded diagnostics.
 */
export async function captureLowerAuthoritySourceRecall(
  input: LowerAuthoritySourceRecallCaptureInput
): Promise<LowerAuthoritySourceRecallCaptureResult> {
  const artifacts = buildLowerAuthoritySourceRecallArtifacts(input);
  const decision = decideSourceRecallCapture(input.policy, {
    sourceKind: artifacts.record.sourceKind,
    sourceRole: artifacts.record.sourceRole,
    captureClass: artifacts.record.captureClass
  });

  if (!decision.allowed) {
    return {
      status: "blocked",
      reasons: decision.reasons,
      diagnostic: buildSourceRecallCaptureFailureDiagnostic(
        {
          sourceKind: artifacts.record.sourceKind,
          sourceRole: artifacts.record.sourceRole,
          captureClass: artifacts.record.captureClass
        },
        "source_recall_lower_authority_capture_blocked",
        {
          originRefId: artifacts.record.originRef.refId,
          sourceHashPrefix: artifacts.record.sourceRecordHash.slice(0, 12)
        }
      )
    };
  }

  try {
    await input.writer.upsertSourceRecord(artifacts.record, artifacts.chunks);
    return {
      status: "captured",
      sourceRecordId: artifacts.record.sourceRecordId,
      chunkIds: artifacts.chunks.map((chunk) => chunk.chunkId),
      capturedAt: artifacts.record.capturedAt,
      sourceRecordHash: artifacts.record.sourceRecordHash
    };
  } catch {
    return {
      status: "failed",
      diagnostic: buildSourceRecallCaptureFailureDiagnostic(
        {
          sourceKind: artifacts.record.sourceKind,
          sourceRole: artifacts.record.sourceRole,
          captureClass: artifacts.record.captureClass
        },
        "source_recall_lower_authority_capture_failed",
        {
          originRefId: artifacts.record.originRef.refId,
          sourceHashPrefix: artifacts.record.sourceRecordHash.slice(0, 12)
        }
      )
    };
  }
}

/**
 * Builds deterministic Source Recall artifacts for one live user turn.
 *
 * **Why it exists:**
 * Capture, tests, and future idempotency checks need stable ids and hashes that do not contain raw
 * source text.
 *
 * **What it talks to:**
 * - Uses `hashSha256` from `../cryptoUtils`.
 * - Uses `buildSourceRecallAuthorityFlags` from `./contracts`.
 *
 * @param input - Live user turn and origin metadata.
 * @returns Source record and chunks for the turn.
 */
export function buildLiveUserTurnSourceRecallArtifacts(
  input: Omit<LiveUserTurnSourceRecallCaptureInput, "policy" | "writer">
): LiveUserTurnSourceRecallArtifacts {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const originRefId = buildLiveUserTurnOriginRefId(input.conversationId, input.turn);
  const sourceRecordHash = hashSha256(
    [
      "source_recall_live_user_turn_v1",
      input.scopeId,
      input.threadId,
      originRefId,
      input.turn.at,
      input.turn.text
    ].join("\n")
  );
  const sourceRecordId = `source_record_${sourceRecordHash.slice(0, 24)}`;
  const chunks = chunkLiveUserTurnText(input.turn.text).map((text, index) => {
    const chunkHash = hashSha256([sourceRecordId, index.toString(), text].join("\n"));
    return {
      chunkId: `source_chunk_${chunkHash.slice(0, 24)}`,
      sourceRecordId,
      chunkIndex: index,
      text,
      chunkHash,
      lifecycleState: "active" as const,
      recallAuthority: "quoted_evidence_only" as const,
      authority: buildSourceRecallAuthorityFlags()
    };
  });

  return {
    record: {
      sourceRecordId,
      scopeId: input.scopeId,
      threadId: input.threadId,
      sourceKind: "conversation_turn",
      sourceRole: "user",
      sourceAuthority: "explicit_user_statement",
      captureClass: "ordinary_source",
      recallAuthority: "quoted_evidence_only",
      lifecycleState: "active",
      originRef: {
        surface: "conversation_session",
        refId: originRefId,
        parentRefId: input.conversationId
      },
      sourceRecordHash,
      observedAt: input.turn.at,
      capturedAt,
      sourceTimeKind: "observed_event",
      freshness: "current_turn",
      sensitive: false,
      ...(() => {
        const principalMetadata = buildSourceRecallPrincipalMetadata(input.principalAccess);
        return principalMetadata ? { principalMetadata } : {};
      })()
    },
    chunks
  };
}

/**
 * Builds deterministic Source Recall artifacts for lower-authority generated/runtime text.
 *
 * @param input - Lower-authority source text and origin metadata.
 * @returns Source record and chunks.
 */
export function buildLowerAuthoritySourceRecallArtifacts(
  input: Omit<LowerAuthoritySourceRecallCaptureInput, "policy" | "writer">
): LiveUserTurnSourceRecallArtifacts {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const originRefId = buildHashedOriginRefId(input.originSurface, input.originRefId);
  const sourceRecordHash = hashSha256(
    [
      "source_recall_lower_authority_text_v1",
      input.scopeId,
      input.threadId,
      input.sourceKind,
      input.sourceRole,
      originRefId,
      input.observedAt,
      input.text
    ].join("\n")
  );
  const sourceRecordId = `source_record_${sourceRecordHash.slice(0, 24)}`;
  const chunks = chunkLiveUserTurnText(input.text).map((text, index) => {
    const chunkHash = hashSha256([sourceRecordId, index.toString(), text].join("\n"));
    return {
      chunkId: `source_chunk_${chunkHash.slice(0, 24)}`,
      sourceRecordId,
      chunkIndex: index,
      text,
      chunkHash,
      lifecycleState: "active" as const,
      recallAuthority: "quoted_evidence_only" as const,
      authority: buildSourceRecallAuthorityFlags()
    };
  });

  return {
    record: {
      sourceRecordId,
      scopeId: input.scopeId,
      threadId: input.threadId,
      sourceKind: input.sourceKind,
      sourceRole: input.sourceRole,
      sourceAuthority: input.sourceAuthority,
      captureClass: input.captureClass,
      recallAuthority: "quoted_evidence_only",
      lifecycleState: "active",
      originRef: {
        surface: input.originSurface,
        refId: originRefId,
        parentRefId: input.originParentRefId
      },
      sourceRecordHash,
      observedAt: input.observedAt,
      capturedAt,
      sourceTimeKind: input.sourceTimeKind,
      freshness: input.freshness,
      sensitive: false,
      ...(() => {
        const principalMetadata = buildSourceRecallPrincipalMetadata(input.principalAccess);
        return principalMetadata ? { principalMetadata } : {};
      })()
    },
    chunks
  };
}

/**
 * Builds redacted principal/access labels for Source Recall records.
 *
 * @param principalAccess - Operation-specific access envelope.
 * @returns Source Recall principal metadata, or `undefined` when no envelope exists.
 */
function buildSourceRecallPrincipalMetadata(
  principalAccess: TaskPrincipalAccessEnvelope | undefined
): SourceRecallPrincipalMetadata | undefined {
  if (!principalAccess) {
    return undefined;
  }
  const actor = readObject(principalAccess.principalContext.actor);
  const route = readObject(principalAccess.principalContext.route);
  const subject = readObject(principalAccess.principalContext.subject);
  const speakerSubject = readObject(subject?.speakerSubjectRef);
  const requestedSubject = readObject(subject?.requestedSubjectRef);
  const ownerSubject = readObject(subject?.ownerSubjectRef);
  const decision = principalAccess.accessDecision;
  return {
    actorPrincipalRole: readString(actor?.principalRole),
    actorProvider: readString(actor?.provider),
    actorPrincipalIdHash: readString(actor?.principalId),
    actorProviderUserIdHash: readString(actor?.providerUserIdHash),
    routeVisibility: readString(route?.visibility),
    identityAuthority: readString(actor?.identityAuthority),
    legacyIdentityState: readString(actor?.legacyIdentityState),
    ownerMatchSource: readString(actor?.ownerMatchSource),
    accessOperation: readString(decision.operation),
    accessClass: readString(decision.accessClass),
    accessAllowed: decision.allowed,
    accessReason: readString(decision.reason),
    speakerSubjectKind: readString(speakerSubject?.subjectKind),
    speakerSubjectId: readString(speakerSubject?.subjectId),
    requestedSubjectKind: readString(requestedSubject?.subjectKind),
    requestedSubjectId: readString(requestedSubject?.subjectId),
    ownerSubjectKind: readString(ownerSubject?.subjectKind),
    ownerSubjectId: readString(ownerSubject?.subjectId)
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Chunks live user source text with the accepted Source Recall bounds.
 *
 * @param text - Normalized live user turn text.
 * @returns Bounded chunks.
 */
function chunkLiveUserTurnText(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length && chunks.length < LIVE_USER_TURN_MAX_CHUNKS) {
    const next = text.slice(offset, offset + LIVE_USER_TURN_MAX_CHUNK_CHARS);
    chunks.push(next);
    if (offset + LIVE_USER_TURN_MAX_CHUNK_CHARS >= text.length) {
      break;
    }
    offset += LIVE_USER_TURN_MAX_CHUNK_CHARS - LIVE_USER_TURN_CHUNK_OVERLAP_CHARS;
  }
  return chunks.length > 0 ? chunks : [""];
}

/**
 * Builds a hashed origin ref for generated/runtime surfaces.
 *
 * @param surface - Source surface label.
 * @param refId - Potentially sensitive origin reference.
 * @returns Non-secret origin reference id.
 */
function buildHashedOriginRefId(surface: string, refId: string): string {
  const normalizedSurface = surface.trim() || "unknown";
  return `${normalizedSurface}:${hashSha256(refId).slice(0, 24)}`;
}

/**
 * Builds a non-text origin reference for one live user turn.
 *
 * @param conversationId - Conversation id.
 * @param turn - Live user turn.
 * @returns Stable origin reference id with no raw source text.
 */
function buildLiveUserTurnOriginRefId(
  conversationId: string,
  turn: LiveUserTurnSourceRecallCaptureInput["turn"]
): string {
  const turnRef = turn.id ?? hashSha256([conversationId, turn.at, turn.text].join("\n")).slice(0, 16);
  return `conversation:${conversationId}:turn:${turnRef}`;
}
