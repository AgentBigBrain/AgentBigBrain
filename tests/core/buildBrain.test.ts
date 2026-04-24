import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  applyEntityExtractionToGraph,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";

test("createSharedBrainRuntimeDependencies keeps sqlite bootstrap imports inside the configured runtime root", async () => {
  const buildBrainModule = await import("../../src/core/buildBrain");
  const { createSharedBrainRuntimeDependencies } = buildBrainModule as {
    createSharedBrainRuntimeDependencies: (env: NodeJS.ProcessEnv) => {
      entityGraphStore: { getGraph(): Promise<{ entities: readonly unknown[]; edges: readonly unknown[] }> };
    };
  };
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "abb-buildbrain-"));
  const cwdRoot = path.join(tempRoot, "cwd-root");
  const isolatedRuntimeRoot = path.join(tempRoot, "isolated-runtime");
  const observedAt = "2026-04-12T16:00:00.000Z";

  await mkdir(path.join(cwdRoot, "runtime"), { recursive: true });
  await mkdir(isolatedRuntimeRoot, { recursive: true });

  const contaminatedGraph = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Billy met Garrett about the Harbor project.",
      observedAt,
      evidenceRef: "test:cwd",
      domainHint: "relationship"
    }),
    observedAt,
    "test:cwd"
  ).graph;

  await writeFile(
    path.join(cwdRoot, "runtime", "entity_graph.json"),
    `${JSON.stringify(contaminatedGraph, null, 2)}\n`,
    "utf8"
  );

  const previousCwd = process.cwd();
  process.chdir(cwdRoot);
  try {
    const shared = createSharedBrainRuntimeDependencies({
      ...process.env,
      BRAIN_ENABLE_EMBEDDINGS: "false",
      BRAIN_LEDGER_BACKEND: "sqlite",
      BRAIN_LEDGER_SQLITE_PATH: path.join(isolatedRuntimeRoot, "ledgers.sqlite"),
      BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
      BRAIN_STATE_JSON_PATH: path.join(isolatedRuntimeRoot, "state.json"),
      BRAIN_PROFILE_MEMORY_ENABLED: "false",
      BRAIN_PROJECTION_SINKS: ""
    });

    const graph = await shared.entityGraphStore.getGraph();
    assert.equal(graph.entities.length, 0);
    assert.equal(graph.edges.length, 0);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
