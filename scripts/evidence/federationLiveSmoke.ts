/**
 * @fileoverview Runs a federated runtime live smoke through the production inbound delegation path and writes a deterministic artifact.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FederatedHttpClient } from "../../src/interfaces/federatedClient";
import {
  createFederationRuntimeConfigFromEnv,
  startFederationRuntime
} from "../../src/interfaces/federationRuntime";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/federation_live_smoke_report.json");
const LIVE_SMOKE_AGENT_ID = "federation_live_smoke_agent";
const LIVE_SMOKE_SECRET = "federation_live_smoke_secret";

interface FederationLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  runtimeAddress: string;
  delegation: {
    accepted: boolean;
    httpStatus: number;
    taskId: string | null;
  };
  result: {
    ok: boolean;
    status: "pending" | "completed" | "failed" | "unknown";
    outputPreview: string | null;
    errorPreview: string | null;
  };
  passCriteria: {
    accepted: boolean;
    terminalResultObserved: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements SHA-256 digest derivation for deterministic contract fixtures.
 */
function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Executes callback with temporary working directory and deterministic cleanup.
 */
async function withTempDirectory<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-federation-live-smoke-"));
  try {
    return await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Runs one federation runtime live smoke and returns a structured artifact payload.
 */
async function runLiveSmoke(): Promise<FederationLiveSmokeArtifact> {
  return withTempDirectory(async (tempDir) => {
    const previousBackend = process.env.BRAIN_MODEL_BACKEND;
    if (!previousBackend || previousBackend.trim().length === 0) {
      process.env.BRAIN_MODEL_BACKEND = "mock";
    }

    const config = createFederationRuntimeConfigFromEnv({
      BRAIN_ENABLE_FEDERATION_RUNTIME: "true",
      BRAIN_FEDERATION_HOST: "127.0.0.1",
      BRAIN_FEDERATION_PORT: "0",
      BRAIN_FEDERATION_MAX_BODY_BYTES: "65536",
      BRAIN_FEDERATION_RESULT_TTL_MS: "300000",
      BRAIN_FEDERATION_EVICTION_INTERVAL_MS: "1000",
      BRAIN_FEDERATION_RESULT_STORE_PATH: path.join(tempDir, "federated_results.json"),
      BRAIN_FEDERATION_CONTRACTS_JSON: JSON.stringify([
        {
          externalAgentId: LIVE_SMOKE_AGENT_ID,
          sharedSecretHash: hashSha256(LIVE_SMOKE_SECRET),
          maxQuotedCostUsd: 3
        }
      ])
    });

    const runtime = await startFederationRuntime(config);
    try {
      const address = runtime.getAddress();
      if (!address) {
        throw new Error("Federation runtime did not expose a bound address.");
      }

      const client = new FederatedHttpClient({
        baseUrl: `http://${address.host}:${address.port}`,
        timeoutMs: 10_000,
        auth: {
          externalAgentId: LIVE_SMOKE_AGENT_ID,
          sharedSecret: LIVE_SMOKE_SECRET
        }
      });

      const delegateResult = await client.delegate({
        quoteId: "federation_live_smoke_quote_001",
        quotedCostUsd: 1,
        goal: "Produce one safe response summary.",
        userInput: "Say hello from federated live smoke."
      });

      const taskId = delegateResult.taskId;
      const pollResult =
        taskId
          ? await client.awaitResult(taskId, {
            pollIntervalMs: 50,
            timeoutMs: 10_000
          })
          : {
            ok: false,
            result: null,
            error: "delegate did not return taskId"
          };

      const status =
        pollResult.result?.status === "completed" || pollResult.result?.status === "failed"
          ? pollResult.result.status
          : pollResult.result?.status ?? "unknown";
      const accepted = delegateResult.ok && Boolean(delegateResult.taskId);
      const terminalResultObserved = status === "completed" || status === "failed";

      return {
        generatedAt: new Date().toISOString(),
        command: "npm run test:federation:live_smoke",
        runtimeAddress: `${address.host}:${address.port}`,
        delegation: {
          accepted,
          httpStatus: delegateResult.httpStatus,
          taskId
        },
        result: {
          ok: pollResult.ok,
          status,
          outputPreview: pollResult.result?.output?.slice(0, 240) ?? null,
          errorPreview:
            pollResult.result?.error?.slice(0, 240) ??
            (pollResult.error ? String(pollResult.error).slice(0, 240) : null)
        },
        passCriteria: {
          accepted,
          terminalResultObserved,
          overallPass: accepted && terminalResultObserved
        }
      };
    } finally {
      await runtime.stop();
      if (previousBackend === undefined) {
        delete process.env.BRAIN_MODEL_BACKEND;
      } else {
        process.env.BRAIN_MODEL_BACKEND = previousBackend;
      }
    }
  });
}

/**
 * Executes script entrypoint and writes live smoke artifact.
 */
async function main(): Promise<void> {
  const artifact = await runLiveSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Federation live smoke artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);

  if (!artifact.passCriteria.overallPass) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

