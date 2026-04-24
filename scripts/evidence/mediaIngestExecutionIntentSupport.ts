/**
 * @fileoverview Shared scenario, fixture, and artifact helpers for media-ingest evidence and live smoke.
 */

import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope,
  ConversationInboundMediaInterpretation,
  ConversationInboundMediaKind
} from "../../src/interfaces/mediaRuntime/contracts";
import type {
  TelegramDocumentAttachment,
  TelegramPhotoSize,
  TelegramVideoAttachment,
  TelegramVoiceAttachment
} from "../../src/interfaces/mediaRuntime/telegramMediaIngress";
import type { TelegramUpdate } from "../../src/interfaces/transportRuntime/telegramGatewayRuntime";
import type { MediaInterpretationFixtureCatalog } from "../../src/organs/mediaUnderstanding/contracts";
import { computeMediaFixtureKey } from "../../src/organs/mediaUnderstanding/mediaInterpretation";

export interface MediaIngestScenarioInterpretationExpectation {
  summary: string;
  transcript: string | null;
  ocrText: string | null;
  confidence: number | null;
  provenance: string;
  entityHints: readonly string[];
}

export interface MediaIngestExecutionIntentScenario {
  id: string;
  title: string;
  summary: string;
  mediaKind: ConversationInboundMediaKind;
  fixtureFile: string;
  userText: string;
  expectedInterpretation: MediaIngestScenarioInterpretationExpectation;
  expectedBehavior: readonly string[];
}

export interface MediaIngestExecutionIntentScenarioInventory {
  schemaVersion: number;
  scenarios: readonly MediaIngestExecutionIntentScenario[];
}

export interface MediaIngestExecutionIntentScenarioDiagnostic {
  scenarioId: string;
  message: string;
}

export interface MediaIngestExecutionIntentScenarioDiagnostics {
  errors: readonly MediaIngestExecutionIntentScenarioDiagnostic[];
  warnings: readonly MediaIngestExecutionIntentScenarioDiagnostic[];
  summary: {
    scenarioCount: number;
    mediaKindCounts: Record<ConversationInboundMediaKind, number>;
  };
}

export const WORKSPACE_ROOT = process.cwd();
export const MEDIA_INGEST_EXECUTION_INTENT_SCENARIO_FIXTURE_PATH = path.resolve(
  WORKSPACE_ROOT,
  "tests/fixtures/mediaIngestExecutionIntentScenarios.json"
);
export const MEDIA_INGEST_EXECUTION_INTENT_FIXTURE_DIR = path.resolve(
  WORKSPACE_ROOT,
  "tests/fixtures/media"
);
export const MEDIA_INGEST_EXECUTION_INTENT_ARTIFACT_PATH = path.resolve(
  WORKSPACE_ROOT,
  "runtime/evidence/media_ingest_execution_intent_report.json"
);
export const MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_ARTIFACT_PATH = path.resolve(
  WORKSPACE_ROOT,
  "runtime/evidence/media_ingest_execution_intent_live_smoke_report.json"
);
export const MEDIA_INGEST_EXECUTION_INTENT_EVIDENCE_COMMAND =
  "tsx scripts/evidence/mediaIngestExecutionIntentEvidence.ts";
export const MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_COMMAND =
  "tsx scripts/evidence/mediaIngestExecutionIntentLiveSmoke.ts";

function countSentences(text: string): number {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0).length;
}

function createEmptyMediaKindCounts(): Record<ConversationInboundMediaKind, number> {
  return {
    image: 0,
    voice: 0,
    video: 0,
    document: 0
  };
}

function buildScenarioInterpretation(
  expectation: MediaIngestScenarioInterpretationExpectation
): ConversationInboundMediaInterpretation {
  return {
    summary: expectation.summary,
    transcript: expectation.transcript,
    ocrText: expectation.ocrText,
    confidence: expectation.confidence,
    provenance: expectation.provenance,
    source: "fixture_catalog",
    entityHints: [...expectation.entityHints]
  };
}

function attachmentBase(
  scenario: MediaIngestExecutionIntentScenario,
  sizeBytes: number
): Omit<ConversationInboundMediaAttachment, "kind"> {
  return {
    provider: "telegram",
    fileId: `fixture_${scenario.id}`,
    fileUniqueId: `fixture_unique_${scenario.id}`,
    mimeType:
      scenario.mediaKind === "image"
        ? "image/png"
        : scenario.mediaKind === "video"
          ? "video/mp4"
          : scenario.mediaKind === "voice"
            ? "audio/ogg"
            : "application/octet-stream",
    fileName: scenario.fixtureFile,
    sizeBytes,
    caption: scenario.userText.trim() || null,
    durationSeconds:
      scenario.mediaKind === "voice"
        ? 11
        : scenario.mediaKind === "video"
          ? 9
          : null,
    width: scenario.mediaKind === "image" || scenario.mediaKind === "video" ? 1280 : null,
    height: scenario.mediaKind === "image" || scenario.mediaKind === "video" ? 720 : null
  };
}

async function assertFixtureFileExists(filePath: string): Promise<void> {
  await access(filePath);
}

export async function loadMediaIngestExecutionIntentScenarioInventory(
  fixturePath: string = MEDIA_INGEST_EXECUTION_INTENT_SCENARIO_FIXTURE_PATH
): Promise<MediaIngestExecutionIntentScenarioInventory> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as MediaIngestExecutionIntentScenarioInventory;
}

export async function computeMediaIngestExecutionIntentScenarioDiagnostics(
  inventory: MediaIngestExecutionIntentScenarioInventory,
  fixtureDir: string = MEDIA_INGEST_EXECUTION_INTENT_FIXTURE_DIR
): Promise<MediaIngestExecutionIntentScenarioDiagnostics> {
  const errors: MediaIngestExecutionIntentScenarioDiagnostic[] = [];
  const warnings: MediaIngestExecutionIntentScenarioDiagnostic[] = [];
  const mediaKindCounts = createEmptyMediaKindCounts();
  const seenIds = new Set<string>();

  if (inventory.schemaVersion !== 1) {
    errors.push({
      scenarioId: "inventory",
      message: `Unsupported schemaVersion ${inventory.schemaVersion}; expected 1.`
    });
  }

  if (!Array.isArray(inventory.scenarios) || inventory.scenarios.length === 0) {
    errors.push({
      scenarioId: "inventory",
      message: "Scenario inventory must include at least one scenario."
    });
  }

  for (const scenario of inventory.scenarios) {
    if (seenIds.has(scenario.id)) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario ids must be unique."
      });
    }
    seenIds.add(scenario.id);

    mediaKindCounts[scenario.mediaKind] += 1;

    if (scenario.title.trim().length === 0 || scenario.summary.trim().length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario title and summary must be non-empty."
      });
    }

    if (scenario.expectedBehavior.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario expectedBehavior must include at least one outcome tag."
      });
    }

    const evidenceText = scenario.userText.trim().length > 0
      ? scenario.userText
      : scenario.expectedInterpretation.transcript ?? scenario.expectedInterpretation.summary;
    const sentenceCount = countSentences(evidenceText);
    if (sentenceCount < 2 || sentenceCount > 4) {
      errors.push({
        scenarioId: scenario.id,
        message:
          `Scenario evidence text must be 2 to 4 sentences long for human-like proof; got ${sentenceCount}.`
      });
    }

    if (scenario.mediaKind === "voice" && !scenario.expectedInterpretation.transcript) {
      errors.push({
        scenarioId: scenario.id,
        message: "Voice scenarios must include an expected transcript."
      });
    }

    if (scenario.expectedInterpretation.summary.trim().length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario expected interpretation must include a non-empty summary."
      });
    }

    const fixturePath = path.join(fixtureDir, scenario.fixtureFile);
    try {
      await assertFixtureFileExists(fixturePath);
    } catch {
      errors.push({
        scenarioId: scenario.id,
        message: `Fixture file '${scenario.fixtureFile}' is missing.`
      });
    }
  }

  for (const requiredKind of ["image", "video", "voice"] as const) {
    if (mediaKindCounts[requiredKind] === 0) {
      errors.push({
        scenarioId: requiredKind,
        message: `Scenario inventory must include at least one ${requiredKind} scenario.`
      });
    }
  }

  if (inventory.scenarios.length < 4) {
    warnings.push({
      scenarioId: "inventory",
      message: "Scenario inventory is very small; add more cases if this feature expands."
    });
  }

  return {
    errors,
    warnings,
    summary: {
      scenarioCount: inventory.scenarios.length,
      mediaKindCounts
    }
  };
}

export async function assertMediaIngestExecutionIntentScenarioInventory(
  fixturePath: string = MEDIA_INGEST_EXECUTION_INTENT_SCENARIO_FIXTURE_PATH,
  fixtureDir: string = MEDIA_INGEST_EXECUTION_INTENT_FIXTURE_DIR
): Promise<MediaIngestExecutionIntentScenarioInventory> {
  const inventory = await loadMediaIngestExecutionIntentScenarioInventory(fixturePath);
  const diagnostics = await computeMediaIngestExecutionIntentScenarioDiagnostics(inventory, fixtureDir);
  if (diagnostics.errors.length > 0) {
    throw new Error(
      diagnostics.errors
        .map((entry) => `${entry.scenarioId}: ${entry.message}`)
        .join("\n")
    );
  }
  return inventory;
}

export async function loadMediaFixtureBuffers(
  inventory: MediaIngestExecutionIntentScenarioInventory,
  fixtureDir: string = MEDIA_INGEST_EXECUTION_INTENT_FIXTURE_DIR
): Promise<Map<string, Buffer>> {
  const buffers = new Map<string, Buffer>();
  for (const scenario of inventory.scenarios) {
    if (buffers.has(scenario.fixtureFile)) {
      continue;
    }
    const fixturePath = path.join(fixtureDir, scenario.fixtureFile);
    buffers.set(scenario.fixtureFile, await readFile(fixturePath));
  }
  return buffers;
}

export function createMediaFixtureCatalog(
  inventory: MediaIngestExecutionIntentScenarioInventory,
  fixtureBuffers: ReadonlyMap<string, Buffer>
): MediaInterpretationFixtureCatalog {
  const catalog: Record<string, ConversationInboundMediaInterpretation> = {};
  for (const scenario of inventory.scenarios) {
    const buffer = fixtureBuffers.get(scenario.fixtureFile);
    if (!buffer) {
      throw new Error(`Missing fixture buffer for ${scenario.fixtureFile}.`);
    }
    catalog[computeMediaFixtureKey(buffer)] = buildScenarioInterpretation(scenario.expectedInterpretation);
  }
  return catalog;
}

export function buildScenarioMediaEnvelope(
  scenario: MediaIngestExecutionIntentScenario,
  sizeBytes: number
): ConversationInboundMediaEnvelope {
  const base = attachmentBase(scenario, sizeBytes);
  switch (scenario.mediaKind) {
    case "image":
      return {
        attachments: [{ ...base, kind: "image" }]
      };
    case "voice":
      return {
        attachments: [{ ...base, kind: "voice" }]
      };
    case "video":
      return {
        attachments: [{ ...base, kind: "video" }]
      };
    case "document":
      return {
        attachments: [{ ...base, kind: "document" }]
      };
  }
}

export function buildTelegramUpdateForScenario(
  scenario: MediaIngestExecutionIntentScenario,
  sizeBytes: number,
  options: {
    updateId?: number;
    chatId?: string;
    userId?: string;
    username?: string;
    dateSeconds?: number;
  } = {}
): TelegramUpdate {
  const attachmentFileId = `fixture_${scenario.id}`;
  const chatId = options.chatId ?? "2001";
  const userId = options.userId ?? "3001";
  const username = options.username ?? "fixtureuser";
  const dateSeconds = options.dateSeconds ?? Math.floor(Date.now() / 1000);

  const message: TelegramUpdate["message"] = {
    chat: {
      id: chatId,
      type: "private"
    },
    from: {
      id: userId,
      username
    },
    date: dateSeconds
  };

  const caption = scenario.userText.trim() || undefined;
  if (scenario.mediaKind === "image") {
    const photo: TelegramPhotoSize = {
      file_id: attachmentFileId,
      file_unique_id: `${attachmentFileId}_unique`,
      width: 1280,
      height: 720,
      file_size: sizeBytes
    };
    message.caption = caption;
    message.photo = [photo];
  } else if (scenario.mediaKind === "voice") {
    const voice: TelegramVoiceAttachment = {
      file_id: attachmentFileId,
      file_unique_id: `${attachmentFileId}_unique`,
      duration: 11,
      mime_type: "audio/ogg",
      file_size: sizeBytes
    };
    if (caption) {
      message.caption = caption;
    }
    message.voice = voice;
  } else if (scenario.mediaKind === "video") {
    const video: TelegramVideoAttachment = {
      file_id: attachmentFileId,
      file_unique_id: `${attachmentFileId}_unique`,
      width: 1280,
      height: 720,
      duration: 9,
      mime_type: "video/mp4",
      file_size: sizeBytes,
      file_name: scenario.fixtureFile
    };
    message.caption = caption;
    message.video = video;
  } else {
    const document: TelegramDocumentAttachment = {
      file_id: attachmentFileId,
      file_unique_id: `${attachmentFileId}_unique`,
      file_name: scenario.fixtureFile,
      mime_type: "application/octet-stream",
      file_size: sizeBytes
    };
    message.caption = caption;
    message.document = document;
  }

  return {
    update_id: options.updateId ?? Math.abs(hashScenarioIdToNumber(scenario.id)),
    message
  };
}

export async function ensureMediaIngestEvidenceDirectory(): Promise<void> {
  await mkdir(path.dirname(MEDIA_INGEST_EXECUTION_INTENT_ARTIFACT_PATH), { recursive: true });
}

function hashScenarioIdToNumber(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return hash;
}
