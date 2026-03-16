import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BrowserSessionRegistry,
  isOrphanedAttributableBrowserSessionSnapshot
} from "../../src/organs/liveRun/browserSessionRegistry";
import { ManagedProcessRegistry } from "../../src/organs/liveRun/managedProcessRegistry";

test("ManagedProcessRegistry reconciles persisted dead started leases to stopped", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-managed-registry-"));
  try {
    const snapshotPath = path.join(tempDir, "managed_processes.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          snapshots: [
            {
              leaseId: "proc_dead_preview",
              taskId: null,
              actionId: "action_dead_preview",
              pid: 999999,
              commandFingerprint: "fingerprint",
              cwd: "C:\\workspace\\drone-company",
              shellExecutable: "python",
              shellKind: "powershell",
              startedAt: "2026-03-14T12:00:00.000Z",
              statusCode: "PROCESS_STARTED",
              exitCode: null,
              signal: null,
              stopRequested: false
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const registry = new ManagedProcessRegistry({ snapshotPath });
    const snapshot = registry.getSnapshot("proc_dead_preview");

    assert.equal(snapshot?.statusCode, "PROCESS_STOPPED");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BrowserSessionRegistry reconciles persisted dead managed sessions to closed", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-browser-registry-"));
  try {
    const snapshotPath = path.join(tempDir, "browser_sessions.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: [
            {
              sessionId: "browser_session:dead_preview",
              url: "http://127.0.0.1:4177/index.html",
              status: "open",
              openedAt: "2026-03-14T12:00:00.000Z",
              closedAt: null,
              visibility: "visible",
              controllerKind: "playwright_managed",
              controlAvailable: true,
              browserProcessPid: 999999
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const registry = new BrowserSessionRegistry({ snapshotPath });
    const snapshot = registry.getSnapshot("browser_session:dead_preview");

    assert.equal(snapshot?.status, "closed");
    assert.equal(
      registry.findOpenSessionByUrl("http://127.0.0.1:4177/index.html"),
      null
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BrowserSessionRegistry keeps detached sessions orphaned when it cannot prove they closed", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-browser-registry-detached-"));
  try {
    const snapshotPath = path.join(tempDir, "browser_sessions.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: [
            {
              sessionId: "browser_session:detached_preview",
              url: "http://127.0.0.1:4178/index.html",
              status: "open",
              openedAt: "2026-03-14T12:00:00.000Z",
              closedAt: null,
              visibility: "visible",
              controllerKind: "os_default",
              controlAvailable: false,
              browserProcessPid: null
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const registry = new BrowserSessionRegistry({ snapshotPath });
    const snapshot = registry.getSnapshot("browser_session:detached_preview");

    assert.ok(snapshot);
    assert.equal(snapshot?.status, "open");
    assert.equal(snapshot?.controlAvailable, false);
    assert.equal(
      isOrphanedAttributableBrowserSessionSnapshot(snapshot),
      true
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BrowserSessionRegistry closes orphaned managed sessions when their linked preview pid is dead", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-browser-registry-linked-dead-"));
  try {
    const snapshotPath = path.join(tempDir, "browser_sessions.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: [
            {
              sessionId: "browser_session:linked_preview_dead",
              url: "http://127.0.0.1:59999/index.html",
              status: "open",
              openedAt: "2026-03-14T12:00:00.000Z",
              closedAt: null,
              visibility: "visible",
              controllerKind: "playwright_managed",
              controlAvailable: false,
              browserProcessPid: null,
              linkedProcessLeaseId: "proc_dead_preview",
              linkedProcessPid: 999999
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const registry = new BrowserSessionRegistry({ snapshotPath });
    const snapshot = registry.getSnapshot("browser_session:linked_preview_dead");

    assert.equal(snapshot?.status, "closed");
    assert.equal(
      registry.findOpenSessionByUrl("http://127.0.0.1:59999/index.html"),
      null
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BrowserSessionRegistry closes stale uncontrollable managed sessions with no remaining liveness proof", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-browser-registry-stale-managed-"));
  try {
    const snapshotPath = path.join(tempDir, "browser_sessions.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: [
            {
              sessionId: "browser_session:stale_managed",
              url: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
              status: "open",
              openedAt: "2026-03-14T12:00:00.000Z",
              closedAt: null,
              visibility: "visible",
              controllerKind: "playwright_managed",
              controlAvailable: false,
              browserProcessPid: null,
              linkedProcessLeaseId: null,
              linkedProcessPid: null
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const registry = new BrowserSessionRegistry({ snapshotPath });
    const snapshot = registry.getSnapshot("browser_session:stale_managed");

    assert.equal(snapshot?.status, "closed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BrowserSessionRegistry can downgrade one linked managed session to stale after its preview resource shuts down", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-browser-registry-linked-shutdown-"));
  try {
    const snapshotPath = path.join(tempDir, "browser_sessions.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: [
            {
              sessionId: "browser_session:linked_preview_shutdown",
              url: "http://127.0.0.1:60001/index.html",
              status: "open",
              openedAt: "2026-03-14T12:00:00.000Z",
              closedAt: null,
              visibility: "visible",
              controllerKind: "playwright_managed",
              controlAvailable: false,
              browserProcessPid: null,
              workspaceRootPath: "C:\\workspace\\drone-company",
              linkedProcessLeaseId: "proc_preview_shutdown",
              linkedProcessCwd: "C:\\workspace\\drone-company",
              linkedProcessPid: 45678
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const registry = new BrowserSessionRegistry({ snapshotPath });
    const snapshot = registry.markSessionClosedFromLinkedResourceShutdown(
      "browser_session:linked_preview_shutdown"
    );

    assert.equal(snapshot?.status, "closed");
    assert.equal(snapshot?.controlAvailable, false);
    assert.equal(
      registry.findOpenSessionByUrl("http://127.0.0.1:60001/index.html"),
      null
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
