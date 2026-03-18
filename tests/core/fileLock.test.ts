/**
 * @fileoverview Validates deterministic entropy-boundary behavior for file-lock and atomic-write helpers.
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAtomicWriteTempFilePath,
  withFileLock,
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

test("withFileLock reclaims a stale malformed legacy lock file", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "runtime", "state.json");
    const lockPath = `${targetPath}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "", "utf8");
    const staleAt = new Date((Date.now() - 120_000) / 1000 * 1000);
    await utimes(lockPath, staleAt, staleAt);

    let ran = false;
    await withFileLock(
      targetPath,
      async () => {
        ran = true;
      },
      {
        malformedStaleAfterMs: 1_000
      }
    );

    assert.equal(ran, true);
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
  });
});

test("withFileLock reclaims a stale lock when the recorded pid is no longer alive", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "runtime", "state.json");
    const lockPath = `${targetPath}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          pid: 999_999,
          acquiredAt: "2026-03-15T00:00:00.000Z",
          targetPath
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    let ran = false;
    await withFileLock(
      targetPath,
      async () => {
        ran = true;
      },
      {
        isProcessAlive: () => false
      }
    );

    assert.equal(ran, true);
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
  });
});

test("withFileLock tolerates a transient unreadable lock file until the owning handle releases", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "runtime", "state.json");
    const lockPath = `${targetPath}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });

    const heldHandle = await open(lockPath, "wx");
    let ran = false;

    const releaseTimer = setTimeout(async () => {
      await heldHandle.close();
      await rm(lockPath, { force: true });
    }, 75);

    try {
      await withFileLock(
        targetPath,
        async () => {
          ran = true;
        },
        {
          timeoutMs: 2_000,
          pollIntervalMs: 25
        }
      );
    } finally {
      clearTimeout(releaseTimer);
      await heldHandle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }

    assert.equal(ran, true);
  });
});
