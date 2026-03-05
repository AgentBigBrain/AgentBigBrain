/**
 * @fileoverview Append-only local evidence store for Stage 6.75 artifacts, using `SchemaEnvelopeV1` for deterministic hash-wrapped payload persistence.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EvidenceArtifactLink,
  EvidenceArtifactV1,
  EvidenceStoreDocumentV1
} from "./types";
import {
  createSchemaEnvelopeV1,
  isSchemaEnvelopeV1,
  verifySchemaEnvelopeV1
} from "./schemaEnvelope";
import { sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";

export interface AppendEvidenceArtifactInput<TPayload> {
  schemaName: string;
  payload: TPayload;
  createdAt: string;
  linkedFrom: EvidenceArtifactLink;
}

/**
 * Implements an append-only artifact store for deterministic stage evidence.
 */
export class EvidenceStore {
  /**
   * Constructs a deterministic evidence store bound to a single JSON path.
   */
  constructor(private readonly storagePath: string) {}

  /**
   * Reads input needed for this execution step.
   *
   * **Why it exists:**
   * Separates input read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `EvidenceStoreDocumentV1` (import `EvidenceStoreDocumentV1`) from `./types`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to EvidenceStoreDocumentV1.
   */
  async load(): Promise<EvidenceStoreDocumentV1> {
    try {
      const raw = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return parseEvidenceStoreDocument(parsed);
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          schemaVersion: "v1",
          artifacts: []
        };
      }
      throw error;
    }
  }

  /**
   * Persists artifact with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes artifact mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
   * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `./schemaEnvelope`.
   * - Uses `EvidenceArtifactV1` (import `EvidenceArtifactV1`) from `./types`.
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param input - Structured input object for this operation.
   * @returns Promise resolving to EvidenceArtifactV1<TPayload>.
   */
  async appendArtifact<TPayload>(
    input: AppendEvidenceArtifactInput<TPayload>
  ): Promise<EvidenceArtifactV1<TPayload>> {
    assertValidIsoTimestamp(input.createdAt, "createdAt");
    assertLinkedFrom(input.linkedFrom);

    const document = await this.load();
    const schemaEnvelope = createSchemaEnvelopeV1(input.schemaName, input.payload, input.createdAt);
    const artifactHash = sha256HexFromCanonicalJson(schemaEnvelope);
    const artifact: EvidenceArtifactV1<TPayload> = {
      artifactId: `evidence_${artifactHash.slice(0, 16)}`,
      artifactHash,
      createdAt: input.createdAt,
      schemaEnvelope,
      linkedFrom: {
        ...input.linkedFrom
      }
    };

    document.artifacts.push(artifact as EvidenceArtifactV1);
    await mkdir(path.dirname(this.storagePath), { recursive: true });
    await writeFile(this.storagePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return artifact;
  }
}

/**
 * Evaluates missing file error and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the missing file error policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param error - Value for error.
 * @returns `true` when this check passes.
 */
function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: string }).code === "ENOENT";
}

/**
 * Applies deterministic validity checks for linked from.
 *
 * **Why it exists:**
 * Fails fast when linked from is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `EvidenceArtifactLink` (import `EvidenceArtifactLink`) from `./types`.
 *
 * @param linkedFrom - Value for linked from.
 */
function assertLinkedFrom(linkedFrom: EvidenceArtifactLink): void {
  const hasReceiptHash = typeof linkedFrom.receiptHash === "string" && linkedFrom.receiptHash.length > 0;
  const hasTraceId = typeof linkedFrom.traceId === "string" && linkedFrom.traceId.length > 0;
  if (!hasReceiptHash && !hasTraceId) {
    throw new Error("Evidence artifact linkage requires either linkedFrom.receiptHash or linkedFrom.traceId.");
  }
}

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * **Why it exists:**
 * Fails fast when valid iso timestamp is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fieldName - Value for field name.
 */
function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Parses evidence store document and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for evidence store document so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `EvidenceStoreDocumentV1` (import `EvidenceStoreDocumentV1`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `EvidenceStoreDocumentV1` result.
 */
function parseEvidenceStoreDocument(value: unknown): EvidenceStoreDocumentV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed evidence store document: expected object root.");
  }
  const candidate = value as {
    schemaVersion?: unknown;
    artifacts?: unknown;
  };
  if (candidate.schemaVersion !== "v1") {
    throw new Error("Malformed evidence store document: schemaVersion must be 'v1'.");
  }
  if (!Array.isArray(candidate.artifacts)) {
    throw new Error("Malformed evidence store document: artifacts must be an array.");
  }

  const artifacts = candidate.artifacts.map((entry, index) => parseEvidenceArtifact(entry, index));
  return {
    schemaVersion: "v1",
    artifacts
  };
}

/**
 * Parses evidence artifact and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for evidence artifact so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `isSchemaEnvelopeV1` (import `isSchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `verifySchemaEnvelopeV1` (import `verifySchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `EvidenceArtifactV1` (import `EvidenceArtifactV1`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @param index - Numeric bound, counter, or index used by this logic.
 * @returns Computed `EvidenceArtifactV1` result.
 */
function parseEvidenceArtifact(value: unknown, index: number): EvidenceArtifactV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed evidence artifact at index ${index}.`);
  }

  const candidate = value as Partial<EvidenceArtifactV1>;
  if (typeof candidate.artifactId !== "string" || candidate.artifactId.length === 0) {
    throw new Error(`Malformed evidence artifact at index ${index}: missing artifactId.`);
  }
  if (typeof candidate.artifactHash !== "string" || candidate.artifactHash.length === 0) {
    throw new Error(`Malformed evidence artifact at index ${index}: missing artifactHash.`);
  }
  if (typeof candidate.createdAt !== "string") {
    throw new Error(`Malformed evidence artifact at index ${index}: missing createdAt.`);
  }
  assertValidIsoTimestamp(candidate.createdAt, `artifacts[${index}].createdAt`);
  if (!candidate.schemaEnvelope || !isSchemaEnvelopeV1(candidate.schemaEnvelope)) {
    throw new Error(`Malformed evidence artifact at index ${index}: invalid schemaEnvelope.`);
  }
  if (!verifySchemaEnvelopeV1(candidate.schemaEnvelope)) {
    throw new Error(`Malformed evidence artifact at index ${index}: schemaEnvelope hash mismatch.`);
  }
  if (!candidate.linkedFrom || typeof candidate.linkedFrom !== "object") {
    throw new Error(`Malformed evidence artifact at index ${index}: missing linkedFrom.`);
  }
  assertLinkedFrom(candidate.linkedFrom);

  return {
    artifactId: candidate.artifactId,
    artifactHash: candidate.artifactHash,
    createdAt: candidate.createdAt,
    schemaEnvelope: candidate.schemaEnvelope,
    linkedFrom: {
      receiptHash: candidate.linkedFrom.receiptHash,
      traceId: candidate.linkedFrom.traceId
    }
  };
}
