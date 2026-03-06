/**
 * @fileoverview Validates deterministic entropy-boundary behavior for file-lock and atomic-write helpers.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAtomicWriteTempFilePath,
  writeFileAtomic
} from "../../src/core/fileLock";
import { RuntimeEntropySource } from "../../src/core/runtimeEntropy";

/**
 * Builds deterministic entropy source fixture for file-lock tests.
 *
 * @returns Runtime entropy source with stable timestamp/token outputs.
 */
function buildDeterministicEntropySource(): RuntimeEntropySource {
  return {
    nowMs: () => 1_700_000_000_123,
    randomBase36: () => "abc123",
    randomHex: () => "deadbeefcafe"
  };
}

/**
 * Runs callback in a temporary directory and removes it afterwards.
 *
 * @param callback - Async work to execute within the temp directory.
 * @returns Promise resolving when callback and cleanup complete.
 */
async function withTempDir(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-filelock-"));
  try {
    await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("buildAtomicWriteTempFilePath uses injected entropy source deterministically", () => {
  const targetPath = path.join("runtime", "state.json");
  const tempPath = buildAtomicWriteTempFilePath(targetPath, buildDeterministicEntropySource());
  assert.equal(
    tempPath.endsWith(`state.json.tmp-${process.pid}-1700000000123-deadbeefcafe`),
    true
  );
});

test("writeFileAtomic writes destination file and leaves no temp artifact", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "runtime", "artifact.json");
    await writeFileAtomic(targetPath, '{"ok":true}', buildDeterministicEntropySource());

    const persisted = await readFile(targetPath, "utf8");
    assert.equal(persisted, '{"ok":true}');

    const files = await readdir(path.dirname(targetPath));
    const tempFiles = files.filter((fileName) => fileName.includes(".tmp-"));
    assert.equal(tempFiles.length, 0);
  });
});
