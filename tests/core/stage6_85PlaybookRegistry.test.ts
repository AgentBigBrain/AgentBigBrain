/**
 * @fileoverview Tests canonical Stage 6.85 playbook-registry helpers.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  loadPlaybookRegistryEnvelope,
  validatePlaybookRegistryCoverageAgainstSeeds
} from "../../src/core/stage6_85/playbookRegistry";
import { createPlaybookEnvelopeV1 } from "../../src/core/stage6_85/playbookPolicy";
import { compileStage685SeedPlaybooks } from "../../src/core/stage6_85/playbookSeeds";

async function withTempRegistryPath(
  payload: string,
  callback: (registryPath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage685-playbook-registry-"));
  const registryPath = path.join(tempDir, "playbook_registry.json");
  try {
    await writeFile(registryPath, payload, "utf8");
    await callback(registryPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("stage 6.85 playbook registry loads verified registry envelopes and validates seed coverage", async () => {
  const createdAt = "2026-02-27T00:00:00.000Z";
  const seedPlaybooks = compileStage685SeedPlaybooks();
  const envelope = createSchemaEnvelopeV1(
    "PlaybookRegistryV1",
    {
      entries: seedPlaybooks.all.map((playbook) => ({
        playbookId: playbook.id,
        version: 1,
        hash: createPlaybookEnvelopeV1(playbook, createdAt).hash
      }))
    },
    createdAt
  );

  await withTempRegistryPath(`${JSON.stringify(envelope, null, 2)}\n`, async (registryPath) => {
    const loaded = await loadPlaybookRegistryEnvelope(registryPath);
    assert.notEqual(loaded, null);
    assert.equal(
      validatePlaybookRegistryCoverageAgainstSeeds(loaded!.payload.entries, seedPlaybooks.all),
      true
    );
  });
});

test("stage 6.85 playbook registry fails closed for invalid or mismatched coverage", async () => {
  const createdAt = "2026-02-27T00:00:00.000Z";
  const seedPlaybooks = compileStage685SeedPlaybooks();
  const envelope = createSchemaEnvelopeV1(
    "PlaybookRegistryV1",
    {
      entries: [
        {
          playbookId: seedPlaybooks.build.id,
          version: 1,
          hash: "invalid_hash"
        }
      ]
    },
    createdAt
  );

  await withTempRegistryPath(`${JSON.stringify(envelope, null, 2)}\n`, async (registryPath) => {
    const loaded = await loadPlaybookRegistryEnvelope(registryPath);
    assert.notEqual(loaded, null);
    assert.equal(
      validatePlaybookRegistryCoverageAgainstSeeds(loaded!.payload.entries, seedPlaybooks.all),
      false
    );
  });
});

test("stage 6.85 playbook registry returns null when the registry file is missing", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "agentbigbrain-stage685-playbook-registry-missing-")
  );
  const registryPath = path.join(tempDir, "missing_registry.json");
  try {
    const loaded = await loadPlaybookRegistryEnvelope(registryPath);
    assert.equal(loaded, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
