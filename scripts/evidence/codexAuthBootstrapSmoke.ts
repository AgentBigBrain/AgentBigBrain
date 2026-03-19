/**
 * @fileoverview Emits a bounded Codex auth/bootstrap evidence artifact for local operator verification.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { normalizeModelBackend } from "../../src/models/backendConfig";
import { resolveCodexCliPath } from "../../src/models/codex/cli";
import { readCodexAuthStatus } from "../../src/models/codex/authStore";
import { resolveCodexModel } from "../../src/models/codex/modelResolution";

export interface CodexAuthBootstrapSmokeArtifact {
  status: "PASS" | "BLOCKED";
  checkedAt: string;
  backend: string;
  cliPath: string;
  authAvailable: boolean;
  profileId: string;
  roleMappings: Record<string, string>;
  summary: string;
}

/**
 * Runs the Codex auth/bootstrap smoke and returns the artifact payload.
 *
 * @param env - Environment source for backend, auth, and model resolution.
 * @returns Smoke artifact describing local Codex backend readiness.
 */
export async function runCodexAuthBootstrapSmoke(
  env: NodeJS.ProcessEnv = process.env
): Promise<CodexAuthBootstrapSmokeArtifact> {
  const backend = normalizeModelBackend(env.BRAIN_MODEL_BACKEND);
  const authStatus = await readCodexAuthStatus(env);
  const roleMappings = {
    "small-fast-model": resolveCodexModel("small-fast-model", env).providerModel,
    "small-policy-model": resolveCodexModel("small-policy-model", env).providerModel,
    "medium-general-model": resolveCodexModel("medium-general-model", env).providerModel,
    "medium-policy-model": resolveCodexModel("medium-policy-model", env).providerModel,
    "large-reasoning-model": resolveCodexModel("large-reasoning-model", env).providerModel
  };
  const cliPath = resolveCodexCliPath(env);

  if (backend !== "codex_oauth") {
    return {
      status: "BLOCKED",
      checkedAt: new Date().toISOString(),
      backend,
      cliPath,
      authAvailable: authStatus.available,
      profileId: authStatus.profileId,
      roleMappings,
      summary: "Codex auth bootstrap smoke requires BRAIN_MODEL_BACKEND=codex_oauth."
    };
  }

  if (!authStatus.available) {
    return {
      status: "BLOCKED",
      checkedAt: new Date().toISOString(),
      backend,
      cliPath,
      authAvailable: false,
      profileId: authStatus.profileId,
      roleMappings,
      summary: "Codex auth bootstrap smoke is blocked because no usable Codex auth state was found."
    };
  }

  return {
    status: "PASS",
    checkedAt: new Date().toISOString(),
    backend,
    cliPath,
    authAvailable: true,
    profileId: authStatus.profileId,
    roleMappings,
    summary:
      "Codex auth bootstrap smoke passed: backend is codex_oauth, auth metadata is available, and all role mappings resolved."
  };
}

/**
 * Writes the Codex auth/bootstrap smoke artifact to the runtime evidence directory.
 */
async function main(): Promise<void> {
  const artifact = await runCodexAuthBootstrapSmoke();
  const evidenceDir = path.resolve("runtime", "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const outputPath = path.join(evidenceDir, "codex_auth_bootstrap_smoke_output.json");
  await writeFile(outputPath, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`Codex auth bootstrap smoke artifact: ${outputPath}`);
  console.log(`Status: ${artifact.status}`);
}

if (require.main === module) {
  void main();
}
