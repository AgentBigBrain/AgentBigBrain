/**
 * @fileoverview Verifies duplicate interface-runtime protection and stale-lock recovery.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireInterfaceRuntimeLock } from "../../src/interfaces/interfaceRuntimeLock";

async function withTempDir(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "agentbigbrain-interface-runtime-lock-")
  );
  try {
    await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("acquireInterfaceRuntimeLock writes lock metadata and removes the lock on release", async () => {
  await withTempDir(async (tempDir) => {
    const lockPath = path.join(tempDir, "runtime", "interface_runtime.lock");
    const lock = await acquireInterfaceRuntimeLock({ lockPath });
    const persisted = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      argv: string[];
    };

    assert.equal(persisted.pid, process.pid);
    assert.ok(Array.isArray(persisted.argv));

    await lock.release();
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
  });
});

test("acquireInterfaceRuntimeLock reclaims stale lock files when the recorded pid is no longer alive", async () => {
  await withTempDir(async (tempDir) => {
    const lockPath = path.join(tempDir, "runtime", "interface_runtime.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 999_999,
        acquiredAt: "2026-03-16T00:00:00.000Z",
        argv: ["tsx", "src/interfaces/interfaceRuntime.ts"],
        cwd: tempDir
      })}\n`,
      "utf8"
    );

    const lock = await acquireInterfaceRuntimeLock({
      lockPath,
      isProcessAlive: () => false
    });
    const persisted = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
    };
    assert.equal(persisted.pid, process.pid);
    await lock.release();
  });
});

test("acquireInterfaceRuntimeLock fails closed when another interface runtime still owns the lock", async () => {
  await withTempDir(async (tempDir) => {
    const lockPath = path.join(tempDir, "runtime", "interface_runtime.lock");
    const firstLock = await acquireInterfaceRuntimeLock({ lockPath });
    await assert.rejects(
      acquireInterfaceRuntimeLock({
        lockPath,
        timeoutMs: 50,
        pollIntervalMs: 10,
        isProcessAlive: () => true
      }),
      /Another interface runtime is already running/
    );
    await firstLock.release();
  });
});
