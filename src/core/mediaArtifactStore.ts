/**
 * @fileoverview Persists canonical runtime-owned media artifacts with JSON or SQLite parity plus durable asset copies.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "./config";
import {
  buildMediaArtifactDerivedMeaning,
  buildMediaArtifactFileName,
  computeMediaArtifactChecksum,
  type MediaArtifactDerivedMeaningLayer,
  type MediaArtifactRecord,
  type RecordMediaArtifactInput
} from "./mediaArtifacts";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";
import { withSqliteDatabase } from "./sqliteStore";
import type {
  ProjectionChangeSet
} from "./projections/contracts";

const SQLITE_MEDIA_ARTIFACT_STATE_TABLE = "media_artifact_state";
const MAX_MEDIA_ARTIFACT_BYTES = 50 * 1024 * 1024;

interface MediaArtifactDocument {
  schemaVersion: "v1";
  updatedAt: string;
  artifacts: MediaArtifactRecord[];
}

interface MediaArtifactStoreOptions {
  backend?: LedgerBackend;
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
  assetDirectory?: string;
  onChange?: (changeSet: ProjectionChangeSet) => Promise<void> | void;
}

/**
 * Parses one persisted media-artifact document into the canonical in-memory shape.
 *
 * **Why it exists:**
 * Rebuilds and replay-safe artifact writes should fail closed on malformed persistence while still
 * recovering to an empty deterministic document when the store has not been created yet.
 *
 * **What it talks to:**
 * - Uses local contract-normalization helpers within this module.
 *
 * @param input - Unknown persisted JSON payload.
 * @returns Canonical media-artifact document.
 */
function parseMediaArtifactDocument(input: unknown): MediaArtifactDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createEmptyMediaArtifactDocument();
  }
  const candidate = input as Partial<MediaArtifactDocument>;
  return {
    schemaVersion: "v1",
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
    artifacts: Array.isArray(candidate.artifacts)
      ? candidate.artifacts
          .map((artifact) => parseMediaArtifactRecord(artifact))
          .filter((artifact): artifact is MediaArtifactRecord => artifact !== null)
      : []
  };
}

/**
 * Builds an empty deterministic media-artifact document.
 *
 * **Why it exists:**
 * Bootstrap and recovery paths need one shared zero-value document instead of repeating ad hoc
 * object literals across JSON and SQLite branches.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @returns Empty media-artifact document.
 */
function createEmptyMediaArtifactDocument(): MediaArtifactDocument {
  return {
    schemaVersion: "v1",
    updatedAt: new Date().toISOString(),
    artifacts: []
  };
}

/**
 * Parses one persisted artifact row into the canonical media-artifact shape.
 *
 * **Why it exists:**
 * Stored artifact records may be reloaded across versions, and this helper keeps field validation
 * centralized so bad rows cannot silently poison projection or review flows.
 *
 * **What it talks to:**
 * - Uses local validation helpers within this module.
 *
 * @param input - Unknown persisted artifact payload.
 * @returns Canonical artifact record, or `null` when invalid.
 */
function parseMediaArtifactRecord(input: unknown): MediaArtifactRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<MediaArtifactRecord>;
  if (
    typeof candidate.artifactId !== "string" ||
    typeof candidate.provider !== "string" ||
    typeof candidate.sourceSurface !== "string" ||
    typeof candidate.kind !== "string" ||
    typeof candidate.recordedAt !== "string" ||
    typeof candidate.fileId !== "string" ||
    typeof candidate.checksumSha256 !== "string" ||
    typeof candidate.ownedAssetPath !== "string" ||
    typeof candidate.assetFileName !== "string" ||
    !candidate.derivedMeaning ||
    typeof candidate.derivedMeaning !== "object"
  ) {
    return null;
  }

  return {
    artifactId: candidate.artifactId,
    provider: candidate.provider,
    sourceSurface: candidate.sourceSurface,
    kind: candidate.kind,
    recordedAt: candidate.recordedAt,
    sourceConversationKey:
      candidate.sourceConversationKey === null || typeof candidate.sourceConversationKey === "string"
        ? (candidate.sourceConversationKey ?? null)
        : null,
    sourceUserId:
      candidate.sourceUserId === null || typeof candidate.sourceUserId === "string"
        ? (candidate.sourceUserId ?? null)
        : null,
    fileId: candidate.fileId,
    fileUniqueId:
      candidate.fileUniqueId === null || typeof candidate.fileUniqueId === "string"
        ? (candidate.fileUniqueId ?? null)
        : null,
    mimeType:
      candidate.mimeType === null || typeof candidate.mimeType === "string"
        ? (candidate.mimeType ?? null)
        : null,
    fileName:
      candidate.fileName === null || typeof candidate.fileName === "string"
        ? (candidate.fileName ?? null)
        : null,
    sizeBytes: typeof candidate.sizeBytes === "number" ? candidate.sizeBytes : null,
    caption:
      candidate.caption === null || typeof candidate.caption === "string"
        ? (candidate.caption ?? null)
        : null,
    durationSeconds: typeof candidate.durationSeconds === "number" ? candidate.durationSeconds : null,
    width: typeof candidate.width === "number" ? candidate.width : null,
    height: typeof candidate.height === "number" ? candidate.height : null,
    checksumSha256: candidate.checksumSha256,
    ownedAssetPath: candidate.ownedAssetPath,
    assetFileName: candidate.assetFileName,
    derivedMeaning: {
      summary:
        candidate.derivedMeaning.summary === null || typeof candidate.derivedMeaning.summary === "string"
          ? (candidate.derivedMeaning.summary ?? null)
          : null,
      transcript:
        candidate.derivedMeaning.transcript === null || typeof candidate.derivedMeaning.transcript === "string"
          ? (candidate.derivedMeaning.transcript ?? null)
          : null,
      ocrText:
        candidate.derivedMeaning.ocrText === null || typeof candidate.derivedMeaning.ocrText === "string"
          ? (candidate.derivedMeaning.ocrText ?? null)
          : null,
      entityHints: Array.isArray(candidate.derivedMeaning.entityHints)
        ? candidate.derivedMeaning.entityHints.filter((hint): hint is string => typeof hint === "string")
        : [],
      layers: Array.isArray(candidate.derivedMeaning.layers)
        ? candidate.derivedMeaning.layers
            .map((layer) => parseMediaArtifactDerivedMeaningLayer(layer))
            .filter((layer): layer is MediaArtifactDerivedMeaningLayer => layer !== null)
        : []
    }
  };
}

/**
 * Parses one persisted derived-meaning layer.
 *
 * @param input - Unknown persisted layer payload.
 * @returns Canonical layer, or `null` when malformed.
 */
function parseMediaArtifactDerivedMeaningLayer(
  input: unknown
): MediaArtifactDerivedMeaningLayer | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<MediaArtifactDerivedMeaningLayer>;
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.source !== "string" ||
    typeof candidate.text !== "string" ||
    typeof candidate.provenance !== "string" ||
    typeof candidate.memoryAuthority !== "string"
  ) {
    return null;
  }
  return {
    kind: candidate.kind,
    source: candidate.source,
    text: candidate.text,
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : null,
    provenance: candidate.provenance,
    memoryAuthority: candidate.memoryAuthority
  } as MediaArtifactDerivedMeaningLayer;
}

/**
 * Returns the existing canonical artifact record that matches one transport attachment.
 *
 * **Why it exists:**
 * Telegram may resend the same asset, and the runtime should reuse one artifact record when the
 * durable identity and checksum already match instead of writing duplicate evidence copies.
 *
 * **What it talks to:**
 * - Uses local artifact-matching rules within this module.
 *
 * @param artifacts - Existing canonical artifact records.
 * @param input - Incoming artifact write request.
 * @param checksumSha256 - Stable content checksum for the incoming bytes.
 * @returns Matching persisted artifact record, or `null`.
 */
function findExistingMediaArtifact(
  artifacts: readonly MediaArtifactRecord[],
  input: RecordMediaArtifactInput,
  checksumSha256: string
): MediaArtifactRecord | null {
  const fileUniqueId = input.attachment.fileUniqueId?.trim() || null;
  return artifacts.find((artifact) => {
    if (artifact.provider !== input.attachment.provider || artifact.kind !== input.attachment.kind) {
      return false;
    }
    if (fileUniqueId && artifact.fileUniqueId === fileUniqueId) {
      return artifact.checksumSha256 === checksumSha256;
    }
    return artifact.fileId === input.attachment.fileId && artifact.checksumSha256 === checksumSha256;
  }) ?? null;
}

/**
 * Fails closed on media payloads that are unsafe to persist as runtime-owned assets.
 *
 * @param input - Incoming media artifact write request.
 */
function assertSafeMediaArtifactInput(input: RecordMediaArtifactInput): void {
  if (!Buffer.isBuffer(input.buffer)) {
    throw new Error("Media artifact payload must be a Buffer.");
  }
  if (input.buffer.length > MAX_MEDIA_ARTIFACT_BYTES) {
    throw new Error("Media artifact payload exceeds the runtime-owned asset size limit.");
  }
}

/**
 * Resolves an owned media asset path and rejects traversal before any untrusted bytes are written.
 *
 * @param assetDirectory - Runtime-owned asset directory.
 * @param assetFileName - Sanitized artifact filename.
 * @returns Absolute asset path inside the configured directory.
 */
function resolveOwnedMediaAssetPath(assetDirectory: string, assetFileName: string): string {
  if (
    assetFileName !== path.basename(assetFileName) ||
    assetFileName !== path.posix.basename(assetFileName) ||
    assetFileName !== path.win32.basename(assetFileName)
  ) {
    throw new Error("Media artifact filename must not contain path separators.");
  }

  const assetDirectoryPath = path.resolve(assetDirectory);
  const ownedAssetPath = path.resolve(assetDirectoryPath, assetFileName);
  const relativeAssetPath = path.relative(assetDirectoryPath, ownedAssetPath);
  if (
    relativeAssetPath.length === 0 ||
    relativeAssetPath.startsWith("..") ||
    path.isAbsolute(relativeAssetPath)
  ) {
    throw new Error("Media artifact asset path must stay inside the runtime-owned directory.");
  }
  return ownedAssetPath;
}

/**
 * Writes already-validated media bytes into a runtime-owned asset path.
 *
 * @param ownedAssetPath - Absolute path resolved by `resolveOwnedMediaAssetPath`.
 * @param buffer - Bounded uploaded media bytes.
 */
async function writeOwnedMediaAsset(ownedAssetPath: string, buffer: Buffer): Promise<void> {
  await writeFile(ownedAssetPath, Buffer.from(buffer));
}

/**
 * Builds one projection change-set describing a media-artifact mutation.
 *
 * **Why it exists:**
 * Projection sinks need one normalized signal for artifact writes so they can rebuild mirror state
 * without being coupled to Telegram-specific ingress details.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param artifactId - Canonical artifact identifier affected by the write.
 * @param recordedAt - Mutation timestamp.
 * @returns Projection change-set for the artifact write.
 */
function buildMediaArtifactProjectionChange(
  artifactId: string,
  recordedAt: string
): ProjectionChangeSet {
  return {
    changeId: `projection_media_artifact_${artifactId}`,
    observedAt: recordedAt,
    kinds: ["media_artifact_changed"],
    reasons: [`media_artifact:${artifactId}`],
    metadata: {
      artifactId
    }
  };
}

/**
 * Implements a canonical runtime-owned media-artifact store.
 */
export class MediaArtifactStore {
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;
  private readonly assetDirectory: string;
  private readonly onChange?: MediaArtifactStoreOptions["onChange"];

  /**
   * Initializes the media-artifact store with deterministic persistence and asset-copy settings.
   *
   * **Why it exists:**
   * Uploaded media needs one stable runtime-owned persistence surface so later mirror rebuilds do
   * not depend on replaying transport downloads or transient request envelopes.
   *
   * **What it talks to:**
   * - Uses `path.resolve` (import `default`) from `node:path`.
   *
   * @param filePath - JSON document path used for export or JSON-backed persistence.
   * @param options - Persistence, asset-directory, and projection callback options.
   */
  constructor(
    private readonly filePath = path.resolve(process.cwd(), "runtime/media_artifacts.json"),
    options: MediaArtifactStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath = options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
    this.assetDirectory = options.assetDirectory ?? path.resolve(process.cwd(), "runtime/media_artifacts/assets");
    this.onChange = options.onChange;
  }

  /**
   * Reads the canonical media-artifact document from persistence.
   *
   * **Why it exists:**
   * Mirror rebuilds and review tools need one stable load seam for artifact metadata and owned
   * asset paths regardless of whether the runtime uses JSON or SQLite persistence.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   *
   * @returns Canonical media-artifact document.
   */
  async load(): Promise<MediaArtifactDocument> {
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      return withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        return this.readSqliteDocument(db);
      });
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseMediaArtifactDocument(JSON.parse(raw));
    } catch {
      return createEmptyMediaArtifactDocument();
    }
  }

  /**
   * Persists one uploaded media attachment and its owned runtime copy.
   *
   * **Why it exists:**
   * The runtime needs a single canonical write seam that captures attachment identity, checksum,
   * derived meaning, and an owned asset path while the downloaded bytes are still available.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   * - Uses `makeId` (import `makeId`) from `./ids`.
   * - Uses media-artifact helpers from `./mediaArtifacts`.
   *
   * @param input - Attachment metadata, raw bytes, and source context for the artifact write.
   * @returns Canonical artifact record.
   */
  async recordArtifact(input: RecordMediaArtifactInput): Promise<MediaArtifactRecord> {
    assertSafeMediaArtifactInput(input);
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const checksumSha256 = computeMediaArtifactChecksum(input.buffer);

    if (this.backend === "sqlite") {
      const artifact = await this.recordArtifactSqlite(input, recordedAt, checksumSha256);
      await this.notifyProjectionChange(artifact.artifactId, recordedAt);
      return artifact;
    }

    const artifact = await withFileLock(this.filePath, async () => {
      const document = await this.load();
      const existingArtifact = findExistingMediaArtifact(document.artifacts, input, checksumSha256);
      if (existingArtifact) {
        return existingArtifact;
      }

      const artifact = await this.persistNewArtifactDocument(document, input, recordedAt, checksumSha256);
      return artifact;
    });
    await this.notifyProjectionChange(artifact.artifactId, recordedAt);
    return artifact;
  }

  /**
   * Persists one new artifact into the JSON-backed document plus owned asset directory.
   *
   * **Why it exists:**
   * Separates the happy-path artifact creation flow from duplicate detection and callback handling,
   * which keeps the JSON write branch easier to reason about and test.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   * - Uses local artifact-building helpers within this module.
   *
   * @param document - Existing persisted document.
   * @param input - Incoming artifact write request.
   * @param recordedAt - Mutation timestamp.
   * @param checksumSha256 - Stable content checksum.
   * @returns Canonical artifact record that was appended.
   */
  private async persistNewArtifactDocument(
    document: MediaArtifactDocument,
    input: RecordMediaArtifactInput,
    recordedAt: string,
    checksumSha256: string
  ): Promise<MediaArtifactRecord> {
    await mkdir(this.assetDirectory, { recursive: true });
    const artifactId = makeId("media_artifact");
    const assetFileName = buildMediaArtifactFileName(artifactId, input.attachment);
    const ownedAssetPath = resolveOwnedMediaAssetPath(this.assetDirectory, assetFileName);
    await writeOwnedMediaAsset(ownedAssetPath, input.buffer);

    const artifact = buildMediaArtifactRecord(input, recordedAt, checksumSha256, artifactId, assetFileName, ownedAssetPath);
    const nextDocument: MediaArtifactDocument = {
      schemaVersion: "v1",
      updatedAt: recordedAt,
      artifacts: [...document.artifacts, artifact].sort((left, right) =>
        left.recordedAt.localeCompare(right.recordedAt) || left.artifactId.localeCompare(right.artifactId)
      )
    };
    await writeFileAtomic(this.filePath, `${JSON.stringify(nextDocument, null, 2)}\n`);
    return artifact;
  }

  /**
   * Persists one uploaded media attachment through the SQLite-backed document path.
   *
   * **Why it exists:**
   * The runtime supports JSON and SQLite persistence backends, so artifact storage needs a SQLite
   * branch that still keeps one deterministic JSON export when configured.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   *
   * @param input - Attachment metadata, raw bytes, and source context for the artifact write.
   * @param recordedAt - Mutation timestamp.
   * @param checksumSha256 - Stable content checksum.
   * @returns Canonical artifact record.
   */
  private async recordArtifactSqlite(
    input: RecordMediaArtifactInput,
    recordedAt: string,
    checksumSha256: string
  ): Promise<MediaArtifactRecord> {
    await this.ensureSqliteReady();
    await mkdir(this.assetDirectory, { recursive: true });

    return withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const document = this.readSqliteDocument(db);
      const existingArtifact = findExistingMediaArtifact(document.artifacts, input, checksumSha256);
      if (existingArtifact) {
        return existingArtifact;
      }

      const artifactId = makeId("media_artifact");
      const assetFileName = buildMediaArtifactFileName(artifactId, input.attachment);
      const ownedAssetPath = resolveOwnedMediaAssetPath(this.assetDirectory, assetFileName);
      await writeOwnedMediaAsset(ownedAssetPath, input.buffer);
      const artifact = buildMediaArtifactRecord(input, recordedAt, checksumSha256, artifactId, assetFileName, ownedAssetPath);
      const nextDocument: MediaArtifactDocument = {
        schemaVersion: "v1",
        updatedAt: recordedAt,
        artifacts: [...document.artifacts, artifact].sort((left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) || left.artifactId.localeCompare(right.artifactId)
        )
      };
      db.prepare(
        `INSERT INTO ${SQLITE_MEDIA_ARTIFACT_STATE_TABLE} (singleton_id, document_json)
         VALUES (1, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET document_json = excluded.document_json`
      ).run(JSON.stringify(nextDocument));

      if (this.exportJsonOnWrite) {
        await writeFileAtomic(this.filePath, `${JSON.stringify(nextDocument, null, 2)}\n`);
      }
      return artifact;
    });
  }

  /**
   * Ensures the SQLite database path exists before artifact persistence.
   *
   * **Why it exists:**
   * JSON/SQLite parity stores share one bootstrap rule: create the parent directory exactly once so
   * later write branches can stay focused on domain logic instead of path setup.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `path.dirname` (import `default`) from `node:path`.
   *
   * @returns Promise resolving after the SQLite parent directory exists.
   */
  private async ensureSqliteReady(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }
    await mkdir(path.dirname(this.sqlitePath), { recursive: true });
    this.sqliteReady = true;
  }

  /**
   * Ensures the SQLite schema exists for the media-artifact singleton document.
   *
   * **Why it exists:**
   * Artifact persistence uses one compact document table so rebuilds can read a canonical snapshot
   * without spreading media metadata across many loosely coupled rows.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import type `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Open SQLite handle.
   */
  private ensureSqliteSchema(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_MEDIA_ARTIFACT_STATE_TABLE} (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        document_json TEXT NOT NULL
      )`
    );
  }

  /**
   * Reads the canonical SQLite media-artifact document.
   *
   * **Why it exists:**
   * The SQLite backend stores one authoritative JSON document, and this helper keeps row parsing
   * and malformed-document recovery out of the higher-level load path.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import type `DatabaseSync`) from `node:sqlite`.
   * - Uses local document parser helpers within this module.
   *
   * @param db - Open SQLite handle.
   * @returns Canonical media-artifact document.
   */
  private readSqliteDocument(db: DatabaseSync): MediaArtifactDocument {
    const row = db.prepare(
      `SELECT document_json
       FROM ${SQLITE_MEDIA_ARTIFACT_STATE_TABLE}
       WHERE singleton_id = 1`
    ).get() as { document_json?: unknown } | undefined;
    if (typeof row?.document_json !== "string") {
      return createEmptyMediaArtifactDocument();
    }
    return parseMediaArtifactDocument(JSON.parse(row.document_json));
  }

  /**
   * Emits the normalized projection change-set for one artifact write when projection is enabled.
   *
   * **Why it exists:**
   * Projection is optional, so artifact persistence should not fail closed on a mirror callback,
   * but successful writes still need a bounded notification path when a mirror is configured.
   *
   * **What it talks to:**
   * - Uses local projection-change helpers within this module.
   *
   * @param artifactId - Canonical artifact identifier affected by the write.
   * @param recordedAt - Mutation timestamp.
   * @returns Promise resolving after the optional callback completes.
   */
  private async notifyProjectionChange(artifactId: string, recordedAt: string): Promise<void> {
    if (!this.onChange) {
      return;
    }
    await this.onChange(buildMediaArtifactProjectionChange(artifactId, recordedAt));
  }
}

/**
 * Builds one canonical artifact record from transport metadata and an owned asset copy path.
 *
 * **Why it exists:**
 * Artifact creation should stay deterministic across JSON and SQLite branches, so both code paths
 * share one record-building helper instead of reassembling fields independently.
 *
 * **What it talks to:**
 * - Uses `buildMediaArtifactDerivedMeaning(...)` from `./mediaArtifacts`.
 *
 * @param input - Incoming artifact write request.
 * @param recordedAt - Mutation timestamp.
 * @param checksumSha256 - Stable content checksum.
 * @param artifactId - Canonical generated artifact identifier.
 * @param assetFileName - Runtime-owned asset filename.
 * @param ownedAssetPath - Absolute runtime-owned asset path.
 * @returns Canonical artifact record.
 */
function buildMediaArtifactRecord(
  input: RecordMediaArtifactInput,
  recordedAt: string,
  checksumSha256: string,
  artifactId: string,
  assetFileName: string,
  ownedAssetPath: string
): MediaArtifactRecord {
  return {
    artifactId,
    provider: input.attachment.provider,
    sourceSurface: input.sourceSurface,
    kind: input.attachment.kind,
    recordedAt,
    sourceConversationKey: input.sourceConversationKey ?? null,
    sourceUserId: input.sourceUserId ?? null,
    fileId: input.attachment.fileId,
    fileUniqueId: input.attachment.fileUniqueId ?? null,
    mimeType: input.attachment.mimeType ?? null,
    fileName: input.attachment.fileName ?? null,
    sizeBytes: input.attachment.sizeBytes ?? null,
    caption: input.attachment.caption ?? null,
    durationSeconds: input.attachment.durationSeconds ?? null,
    width: input.attachment.width ?? null,
    height: input.attachment.height ?? null,
    checksumSha256,
    ownedAssetPath,
    assetFileName,
    derivedMeaning: buildMediaArtifactDerivedMeaning(input.attachment)
  };
}
