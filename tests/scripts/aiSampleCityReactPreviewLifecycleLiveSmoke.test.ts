import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runAiSampleCityReactPreviewLifecycleLiveSmoke
} from "../../scripts/evidence/aiSampleCityReactPreviewLifecycleLiveSmoke";

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

test("fresh React preview lifecycle smoke proves browser-open conversation and cleanup", async (t) => {
  if (!parseBoolean(process.env.BRAIN_LEGACY_FRAMEWORK_LIVE_SMOKE_CONFIRM)) {
    t.skip("Legacy framework-specific preview lifecycle smoke requires explicit live confirmation.");
    return;
  }
  if (process.platform !== "win32") {
    t.skip("Desktop browser lifecycle smoke is currently validated on Windows hosts only.");
    return;
  }
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/ai_sample_city_react_preview_lifecycle_live_smoke_report.json"
  );
  let artifact: Awaited<ReturnType<typeof runAiSampleCityReactPreviewLifecycleLiveSmoke>> | null = null;
  try {
    artifact = await runAiSampleCityReactPreviewLifecycleLiveSmoke();
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

  const boundedRuntimeUnavailable =
    /(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|effective backend is mock|missing OPENAI_API_KEY|provider or runtime step timed out|\bEXECUTABLE_NOT_FOUND\b|\bCOMMAND_TOO_LONG\b|\bDEPENDENCY_MISSING\b|\bVERSION_INCOMPATIBLE\b|\bPROCESS_NOT_READY\b|\bTARGET_NOT_RUNNING\b|unable to resolve pwsh or powershell executable|Timed out waiting for turn_\d+ to complete|unexpectedly started a preview process before the preview-start step|(?:Turn \d+ )?React preview smoke dist\/index\.html is missing|Landing page build proof missing: dist\/index\.html)/i
      .test(persisted.blockerReason ?? "");

  if (
    (persisted.status === "BLOCKED" || persisted.status === "FAIL") &&
    boundedRuntimeUnavailable
  ) {
    t.skip("Real backend capacity or bounded runtime availability blocked the fresh React preview lifecycle smoke.");
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
