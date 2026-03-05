/**
 * @fileoverview Tests deterministic capability-claim audit behavior, including schema, command, and reward-ledger checks.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  auditCapabilityClaimManifest,
  CapabilityClaimManifest,
  CommandRunner,
  parseCapabilityClaimManifest
} from "../../scripts/evidence/claimAuditCore";

/**
 * Implements `withTempDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempDir(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-claim-audit-"));
  try {
    await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `writeJson` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Implements `buildCommandRunner` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCommandRunner(exitCodeByCommand: Record<string, number>): CommandRunner {
  return async (command: string): Promise<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
  }> => {
    const exitCode = exitCodeByCommand[command] ?? 1;
    return {
      command,
      exitCode,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 1
    };
  };
}

test("claim audit passes for verified runtime evidence and reward ledger assertions", async () => {
  await withTempDir(async (tempDir) => {
    const proofPath = path.join(tempDir, "runtime", "evidence", "proof.txt");
    const testPath = path.join(tempDir, "src", "core", "proof.test.ts");
    const rewardPath = path.join(tempDir, "runtime", "reward_score.json");

    await mkdir(path.dirname(proofPath), { recursive: true });
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, "export {};\n", "utf8");
    await writeFile(proofPath, "verified-proof\n", "utf8");
    await writeJson(rewardPath, {
      stages: [
        {
          id: "stage_6_5_advanced_autonomy",
          status: "pending",
          checkpoints: [{ id: "6.12", status: "passed" }],
          review: { decision: "pending" }
        }
      ]
    });

    const manifest: CapabilityClaimManifest = {
      schemaVersion: 1,
      generatedAt: "2026-02-27T00:00:00.000Z",
      claims: [
        {
          id: "runtime_validation_baseline",
          summary: "Build gate is green.",
          status: "VERIFIED",
          verificationLevel: "runtime_path",
          evidence: [
            {
              type: "command",
              id: "build",
              command: "npm run build"
            },
            {
              type: "artifact",
              path: path.relative(tempDir, proofPath),
              minBytes: 5,
              mustContain: "verified-proof"
            },
            {
              type: "test_path",
              path: path.relative(tempDir, testPath)
            }
          ]
        },
        {
          id: "checkpoint_6_12_reward_claim",
          summary: "Checkpoint 6.12 is passed in reward ledger.",
          status: "PARTIALLY VERIFIED",
          verificationLevel: "boundary_only",
          evidence: [
            {
              type: "reward_stage",
              path: path.relative(tempDir, rewardPath),
              stageId: "stage_6_5_advanced_autonomy",
              expectedStatus: "pending",
              expectedReviewDecision: "pending"
            },
            {
              type: "reward_checkpoint",
              path: path.relative(tempDir, rewardPath),
              stageId: "stage_6_5_advanced_autonomy",
              checkpointId: "6.12",
              expectedStatus: "passed"
            }
          ]
        }
      ]
    };

    const report = await auditCapabilityClaimManifest(manifest, "docs/evidence/capability_claims.json", {
      cwd: tempDir,
      commandRunner: buildCommandRunner({
        "npm run build": 0
      })
    });

    assert.equal(report.overallPass, true);
    assert.equal(report.totals.failedClaims, 0);
    assert.equal(report.totals.passedClaims, 2);
  });
});

test("claim audit fails when verified claim contract is inconsistent", async () => {
  await withTempDir(async (tempDir) => {
    const testPath = path.join(tempDir, "src", "core", "contract.test.ts");
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(testPath, "export {};\n", "utf8");

    const manifest: CapabilityClaimManifest = {
      schemaVersion: 1,
      generatedAt: "2026-02-27T00:00:00.000Z",
      claims: [
        {
          id: "bad_verified_claim",
          summary: "This claim is malformed.",
          status: "VERIFIED",
          verificationLevel: "boundary_only",
          evidence: [
            {
              type: "test_path",
              path: path.relative(tempDir, testPath)
            }
          ]
        }
      ]
    };

    const report = await auditCapabilityClaimManifest(manifest, "docs/evidence/capability_claims.json", {
      cwd: tempDir,
      commandRunner: buildCommandRunner({})
    });

    assert.equal(report.overallPass, false);
    assert.equal(report.totals.failedClaims, 1);
    assert.equal(
      report.claims[0].failures.some((failure) =>
        failure.includes("VERIFIED claim must use verificationLevel `runtime_path`")
      ),
      true
    );
    assert.equal(
      report.claims[0].failures.some((failure) =>
        failure.includes("VERIFIED claim requires at least one command evidence entry")
      ),
      true
    );
  });
});

test("claim audit fails when reward checkpoint evidence does not match ledger", async () => {
  await withTempDir(async (tempDir) => {
    const rewardPath = path.join(tempDir, "runtime", "reward_score.json");
    await writeJson(rewardPath, {
      stages: [
        {
          id: "stage_6_5_advanced_autonomy",
          status: "pending",
          checkpoints: [{ id: "6.12", status: "pending" }],
          review: { decision: "pending" }
        }
      ]
    });

    const manifest: CapabilityClaimManifest = {
      schemaVersion: 1,
      generatedAt: "2026-02-27T00:00:00.000Z",
      claims: [
        {
          id: "incorrect_reward_claim",
          summary: "Incorrectly claims checkpoint pass.",
          status: "PARTIALLY VERIFIED",
          verificationLevel: "boundary_only",
          evidence: [
            {
              type: "reward_checkpoint",
              path: path.relative(tempDir, rewardPath),
              stageId: "stage_6_5_advanced_autonomy",
              checkpointId: "6.12",
              expectedStatus: "passed"
            }
          ]
        }
      ]
    };

    const report = await auditCapabilityClaimManifest(manifest, "docs/evidence/capability_claims.json", {
      cwd: tempDir,
      commandRunner: buildCommandRunner({})
    });

    assert.equal(report.overallPass, false);
    assert.equal(
      report.claims[0].failures.some((failure) =>
        failure.includes("Checkpoint status mismatch")
      ),
      true
    );
  });
});

test("manifest parser rejects invalid schema payloads", () => {
  assert.throws(
    () =>
      parseCapabilityClaimManifest(
        JSON.stringify({
          schemaVersion: 2,
          generatedAt: "2026-02-27T00:00:00.000Z",
          claims: []
        })
      ),
    /Capability claim manifest is invalid/
  );
});
