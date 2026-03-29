/**
 * @fileoverview Canonical Stage 6.85 playbook-registry helpers for envelope loading and deterministic hash coverage validation.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { isSchemaEnvelopeV1, verifySchemaEnvelopeV1 } from "../schemaEnvelope";
import { createPlaybookEnvelopeV1 } from "./playbookPolicy";
import { type PlaybookV1, type SchemaEnvelopeV1 } from "../types";

export interface PlaybookRegistryEntryV1 {
  playbookId: string;
  version: number;
  hash: string;
}

export interface PlaybookRegistryPayloadV1 {
  entries: PlaybookRegistryEntryV1[];
}

export const DEFAULT_PLAYBOOK_REGISTRY_PATH = path.resolve(
  process.cwd(),
  "runtime/playbooks/playbook_registry.json"
);

/**
 * Narrows unknown data into a single playbook-registry entry contract.
 *
 * @param value - Unknown parsed JSON value.
 * @returns `true` when the value matches the registry-entry contract.
 */
function isPlaybookRegistryEntryV1(value: unknown): value is PlaybookRegistryEntryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PlaybookRegistryEntryV1>;
  return (
    typeof candidate.playbookId === "string" &&
    typeof candidate.version === "number" &&
    Number.isFinite(candidate.version) &&
    typeof candidate.hash === "string"
  );
}

/**
 * Narrows unknown data into the Stage 6.85 playbook-registry payload contract.
 *
 * @param value - Unknown parsed JSON value.
 * @returns `true` when the value matches the registry payload contract.
 */
function isPlaybookRegistryPayloadV1(value: unknown): value is PlaybookRegistryPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PlaybookRegistryPayloadV1>;
  return Array.isArray(candidate.entries) && candidate.entries.every(isPlaybookRegistryEntryV1);
}

/**
 * Loads and verifies the Stage 6.85 playbook registry envelope from disk.
 *
 * @param registryPath - Registry file path to read.
 * @returns Verified registry envelope or `null` when the registry is unavailable or invalid.
 */
export async function loadPlaybookRegistryEnvelope(
  registryPath: string
): Promise<SchemaEnvelopeV1<PlaybookRegistryPayloadV1> | null> {
  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSchemaEnvelopeV1(parsed) || !verifySchemaEnvelopeV1(parsed)) {
      return null;
    }
    if (parsed.schemaName !== "PlaybookRegistryV1") {
      return null;
    }
    if (!isPlaybookRegistryPayloadV1(parsed.payload)) {
      return null;
    }
    return parsed as SchemaEnvelopeV1<PlaybookRegistryPayloadV1>;
  } catch {
    return null;
  }
}

/**
 * Verifies that registry entries cover the deterministic Stage 6.85 seed playbooks by hash.
 *
 * @param registryEntries - Registry payload entries keyed by playbook id.
 * @param seedPlaybooks - Deterministic seed playbooks that must be covered.
 * @returns `true` when the registry covers every seed playbook with the expected hash.
 */
export function validatePlaybookRegistryCoverageAgainstSeeds(
  registryEntries: readonly PlaybookRegistryEntryV1[],
  seedPlaybooks: readonly PlaybookV1[]
): boolean {
  const entriesByPlaybookId = new Map(registryEntries.map((entry) => [entry.playbookId, entry]));

  for (const playbook of seedPlaybooks) {
    const entry = entriesByPlaybookId.get(playbook.id);
    if (!entry) {
      return false;
    }
    const expectedHash = createPlaybookEnvelopeV1(
      playbook,
      "2026-02-27T00:00:00.000Z"
    ).hash;
    if (entry.hash !== expectedHash) {
      return false;
    }
  }

  return true;
}
