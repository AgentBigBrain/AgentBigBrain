/**
 * @fileoverview Defines canonical media-artifact contracts and path helpers for runtime-owned upload persistence.
 */

import { createHash } from "node:crypto";

import type {
  ConversationInboundMediaAttachment
} from "../interfaces/mediaRuntime/contracts";

export type MediaArtifactProvider = "telegram";
export type MediaArtifactSourceSurface = "telegram_interface";

export interface MediaArtifactDerivedMeaning {
  summary: string | null;
  transcript: string | null;
  ocrText: string | null;
  entityHints: readonly string[];
}

export interface MediaArtifactRecord {
  artifactId: string;
  provider: MediaArtifactProvider;
  sourceSurface: MediaArtifactSourceSurface;
  kind: ConversationInboundMediaAttachment["kind"];
  recordedAt: string;
  sourceConversationKey: string | null;
  sourceUserId: string | null;
  fileId: string;
  fileUniqueId: string | null;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  caption: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  checksumSha256: string;
  ownedAssetPath: string;
  assetFileName: string;
  derivedMeaning: MediaArtifactDerivedMeaning;
}

export interface RecordMediaArtifactInput {
  attachment: ConversationInboundMediaAttachment;
  buffer: Buffer;
  sourceSurface: MediaArtifactSourceSurface;
  sourceConversationKey?: string | null;
  sourceUserId?: string | null;
  recordedAt?: string;
}

/**
 * Calculates a deterministic SHA-256 digest for one uploaded media payload.
 *
 * **Why it exists:**
 * The runtime needs a stable content fingerprint so artifact identity, deduplication, and mirrored
 * evidence references do not depend on transport-specific file ids alone.
 *
 * **What it talks to:**
 * - Uses `createHash` (import `createHash`) from `node:crypto`.
 *
 * @param buffer - Raw uploaded media bytes.
 * @returns Lowercase SHA-256 hex digest.
 */
export function computeMediaArtifactChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Resolves a bounded file extension for one media attachment.
 *
 * **Why it exists:**
 * Runtime-owned asset copies should keep a stable extension when possible so mirrored vault links
 * and desktop tooling remain readable without trusting arbitrary user-supplied file names.
 *
 * **What it talks to:**
 * - Uses MIME and attachment-kind allowlist rules within this module.
 *
 * @param attachment - Canonical inbound attachment metadata.
 * @returns Lowercase extension including the leading dot.
 */
export function resolveMediaArtifactExtension(
  attachment: ConversationInboundMediaAttachment
): string {
  const mimeExtension = resolveMimeExtension(attachment.mimeType);
  if (mimeExtension) {
    return mimeExtension;
  }

  switch (attachment.kind) {
    case "image":
      return ".jpg";
    case "voice":
      return ".ogg";
    case "video":
      return ".mp4";
    case "document":
      return ".bin";
    default:
      return ".bin";
  }
}

/**
 * Builds a stable runtime-owned asset filename for one artifact.
 *
 * **Why it exists:**
 * Artifact mirrors should not churn when captions or user-supplied names change, so the runtime
 * uses one deterministic filename based on the canonical artifact id.
 *
 * **What it talks to:**
 * - Uses `resolveMediaArtifactExtension(...)` within this module.
 *
 * @param artifactId - Canonical artifact identifier.
 * @param attachment - Canonical inbound attachment metadata.
 * @returns Stable runtime-owned asset filename.
 */
export function buildMediaArtifactFileName(
  artifactId: string,
  attachment: ConversationInboundMediaAttachment
): string {
  return `${artifactId}${resolveMediaArtifactExtension(attachment)}`;
}

/**
 * Extracts the derived-meaning payload stored beside a canonical media artifact.
 *
 * **Why it exists:**
 * Mirroring and review flows need stable access to transcript, OCR, and summary text without
 * reparsing the raw attachment every time the vault is rebuilt.
 *
 * **What it talks to:**
 * - Uses local attachment interpretation fields within this module.
 *
 * @param attachment - Canonical inbound attachment metadata.
 * @returns Derived meaning payload normalized for persistence.
 */
export function buildMediaArtifactDerivedMeaning(
  attachment: ConversationInboundMediaAttachment
): MediaArtifactDerivedMeaning {
  return {
    summary: attachment.interpretation?.summary?.trim() || null,
    transcript: attachment.interpretation?.transcript?.trim() || null,
    ocrText: attachment.interpretation?.ocrText?.trim() || null,
    entityHints: [...new Set(
      (attachment.interpretation?.entityHints ?? [])
        .map((hint) => hint.trim())
        .filter((hint) => hint.length > 0)
    )].sort((left, right) => left.localeCompare(right))
  };
}

/**
 * Resolves a bounded extension from one MIME type.
 *
 * **Why it exists:**
 * Uploaded documents often omit filenames, so MIME-derived extensions keep stored assets usable
 * without letting arbitrary content decide the on-disk suffix.
 *
 * **What it talks to:**
 * - Uses local MIME-to-extension rules within this module.
 *
 * @param mimeType - Attachment MIME type from the transport layer.
 * @returns Lowercase extension including the leading dot, or `null`.
 */
function resolveMimeExtension(mimeType: string | null): string | null {
  switch ((mimeType ?? "").trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "audio/ogg":
    case "audio/opus":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "video/mp4":
      return ".mp4";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return null;
  }
}
