/**
 * @fileoverview Tests deterministic Stage 6.85 playbook runtime selection and fail-closed fallback behavior for live planning context.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  compileStage685SeedPlaybooks,
  resolveStage685PlaybookPlanningContext
} from "../../src/core/stage6_85PlaybookRuntime";
import { createPlaybookEnvelopeV1 } from "../../src/core/stage6_85PlaybookPolicy";

/**
 * Implements `buildRegistryEnvelopeJson` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRegistryEnvelopeJson(createdAt = "2026-02-27T00:00:00.000Z"): string {
  const seedPlaybooks = compileStage685SeedPlaybooks();
  const entries = seedPlaybooks.all.map((playbook) => ({
    playbookId: playbook.id,
    version: 1,
    hash: createPlaybookEnvelopeV1(playbook, createdAt).hash
  }));
  const envelope = createSchemaEnvelopeV1(
    "PlaybookRegistryV1",
    { entries },
    createdAt
  );
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * Implements `withTempRegistryPath` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempRegistryPath(
  payload: string,
  callback: (registryPath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage685-playbook-runtime-"));
  const registryPath = path.join(tempDir, "playbook_registry.json");
  try {
    await writeFile(registryPath, payload, "utf8");
    await callback(registryPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("stage 6.85 playbook runtime selects deterministic build playbook for build-scaffold requests", async () => {
  await withTempRegistryPath(buildRegistryEnvelopeJson(), async (registryPath) => {
    const context = await resolveStage685PlaybookPlanningContext({
      userInput:
        "Build and test a deterministic TypeScript CLI scaffold, then propose a reusable playbook candidate if repeatable.",
      nowIso: "2026-02-28T00:00:00.000Z",
      registryPath
    });

    assert.equal(context.selectedPlaybookId, "playbook_stage685_a_build");
    assert.equal(context.fallbackToPlanner, false);
    assert.equal(context.registryValidated, true);
    assert.equal(context.requiredInputSchema, "build_cli_v1");
  });
});

test("stage 6.85 playbook runtime selects deterministic research playbook for research requests", async () => {
  await withTempRegistryPath(buildRegistryEnvelopeJson(), async (registryPath) => {
    const context = await resolveStage685PlaybookPlanningContext({
      userInput:
        "Research deterministic sandboxing controls and provide distilled findings with proof refs.",
      nowIso: "2026-02-28T00:00:00.000Z",
      registryPath
    });

    assert.equal(context.selectedPlaybookId, "playbook_stage685_a_research");
    assert.equal(context.fallbackToPlanner, false);
    assert.equal(context.requiredInputSchema, "research_v1");
  });
});

test("stage 6.85 playbook runtime isolates current-user request marker from prior turn context", async () => {
  await withTempRegistryPath(buildRegistryEnvelopeJson(), async (registryPath) => {
    const wrappedInput = [
      "Recent conversation context (oldest to newest):",
      "- user: Build a minimal deterministic TypeScript CLI scaffold with README, runbook, and tests.",
      "- assistant: I will proceed to run the deterministic build workflow.",
      "Current user request:",
      "Research deterministic sandboxing controls and provide distilled findings with proof refs."
    ].join("\n");

    const context = await resolveStage685PlaybookPlanningContext({
      userInput: wrappedInput,
      nowIso: "2026-02-28T00:00:00.000Z",
      registryPath
    });

    assert.equal(context.selectedPlaybookId, "playbook_stage685_a_research");
    assert.equal(context.fallbackToPlanner, false);
    assert.deepEqual(context.requestedTags, ["research", "security"]);
    assert.equal(context.requiredInputSchema, "research_v1");
  });
});

test("stage 6.85 playbook runtime fails closed to normal planning for unmatched intent tags", async () => {
  await withTempRegistryPath(buildRegistryEnvelopeJson(), async (registryPath) => {
    const context = await resolveStage685PlaybookPlanningContext({
      userInput: "Explain why this unfamiliar request cannot use a playbook.",
      nowIso: "2026-02-28T00:00:00.000Z",
      registryPath
    });

    assert.equal(context.selectedPlaybookId, null);
    assert.equal(context.fallbackToPlanner, true);
    assert.equal(context.registryValidated, false);
    assert.match(context.reason, /no deterministic playbook tag match/i);
  });
});

test("stage 6.85 playbook runtime fails closed to planner fallback for workflow replay asks without a matching workflow playbook", async () => {
  await withTempRegistryPath(buildRegistryEnvelopeJson(), async (registryPath) => {
    const context = await resolveStage685PlaybookPlanningContext({
      userInput: "Capture this browser workflow, compile replay steps, and block if selector drift appears.",
      nowIso: "2026-02-28T00:00:00.000Z",
      registryPath
    });

    assert.equal(context.selectedPlaybookId, null);
    assert.equal(context.fallbackToPlanner, true);
    assert.equal(context.registryValidated, true);
    assert.equal(context.requiredInputSchema, "workflow_replay_v1");
    assert.deepEqual(context.requestedTags, ["computer_use", "replay", "workflow"]);
    assert.match(context.reason, /tag\/schema compatibility gates/i);
  });
});

test("stage 6.85 playbook runtime fails closed when registry hash coverage is invalid", async () => {
  const createdAt = "2026-02-27T00:00:00.000Z";
  const seedPlaybooks = compileStage685SeedPlaybooks();
  const invalidEnvelope = createSchemaEnvelopeV1(
    "PlaybookRegistryV1",
    {
      entries: [
        {
          playbookId: seedPlaybooks.build.id,
          version: 1,
          hash: "invalid_hash"
        },
        {
          playbookId: seedPlaybooks.research.id,
          version: 1,
          hash: createPlaybookEnvelopeV1(seedPlaybooks.research, createdAt).hash
        }
      ]
    },
    createdAt
  );

  await withTempRegistryPath(
    `${JSON.stringify(invalidEnvelope, null, 2)}\n`,
    async (registryPath) => {
      const context = await resolveStage685PlaybookPlanningContext({
        userInput: "Build deterministic TypeScript CLI scaffold with tests.",
        nowIso: "2026-02-28T00:00:00.000Z",
        registryPath
      });

      assert.equal(context.selectedPlaybookId, null);
      assert.equal(context.fallbackToPlanner, true);
      assert.equal(context.registryValidated, false);
      assert.match(context.reason, /registry hash coverage mismatch/i);
    }
  );
});
