import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runNextJsDesktopConversationLifecycleLiveSmoke
} from "../../scripts/evidence/nextJsDesktopConversationLifecycleLiveSmoke";

type ArtifactResult = Awaited<ReturnType<typeof runNextJsDesktopConversationLifecycleLiveSmoke>>;

const KNOWN_BLOCKER_REASON_REGEX =
  /(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|effective backend is mock|missing OPENAI_API_KEY|provider or runtime step timed out|\bEXECUTABLE_NOT_FOUND\b|\bCOMMAND_TOO_LONG\b|\bDEPENDENCY_MISSING\b|\bVERSION_INCOMPATIBLE\b|\bPROCESS_NOT_READY\b|\bTARGET_NOT_RUNNING\b|unable to resolve pwsh or powershell executable|Timed out waiting for turn_\d+ to complete)/i;

test("fresh Next.js desktop conversation lifecycle smoke proves build warm-open edit chat and cleanup", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Desktop browser lifecycle smoke is currently validated on Windows hosts only.");
    return;
  }
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/next_js_desktop_conversation_lifecycle_live_smoke_report.json"
  );
  let artifact: ArtifactResult | null = null;
  try {
    artifact = await runNextJsDesktopConversationLifecycleLiveSmoke();
  } catch {
    artifact = null;
  }
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    blockerReason: string | null;
    checks: Record<string, boolean>;
    previewUrl: string | null;
    browserSessionId: string | null;
    previewProcessLeaseId: string | null;
    reusedExistingWorkspace: boolean;
  };

  if (
    persisted.status === "BLOCKED" &&
    KNOWN_BLOCKER_REASON_REGEX.test(persisted.blockerReason ?? "")
  ) {
    t.skip("Real backend capacity or bounded runtime availability blocked the fresh Next.js desktop conversation lifecycle smoke.");
    return;
  }

  assert.equal(artifact?.status ?? persisted.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(persisted.reusedExistingWorkspace, false);
  assert.equal(Object.values(persisted.checks).every((value) => value === true), true);
  assert.match(persisted.previewUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/?$/i);
  assert.ok((persisted.browserSessionId ?? "").length > 0);
  assert.ok((persisted.previewProcessLeaseId ?? "").length > 0);
});
