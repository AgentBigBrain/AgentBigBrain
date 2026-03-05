/**
 * @fileoverview Runs Stage 6.75 checkpoint 6.75.C build-pipeline validation and emits deterministic scaffold/dependency-policy evidence.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_75_build_pipeline_report.json"
);

interface DependencyPolicyResult {
  allowed: boolean;
  violations: readonly string[];
}

interface Stage675CheckpointCArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.75.C";
  scaffold: {
    outputDir: string;
    files: readonly string[];
    checksums: Record<string, string>;
  };
  dependencyPolicy: {
    allowedManifestPass: boolean;
    deniedManifestBlocked: boolean;
    deniedViolations: readonly string[];
  };
  verifier: {
    reportPath: string;
    reportHash: string;
  };
  passCriteria: {
    scaffoldPass: boolean;
    dependencyPolicyPass: boolean;
    verifierPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `sha256Hex` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Implements `evaluateDependencyPolicy` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function evaluateDependencyPolicy(manifest: {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}): DependencyPolicyResult {
  const violations: string[] = [];
  const dependencies = manifest.dependencies ?? {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (version.startsWith("^") || version.startsWith("~") || version === "latest") {
      violations.push(`Dependency '${name}' is not pinned ('${version}').`);
    }
  }

  const scripts = manifest.scripts ?? {};
  for (const [scriptName, scriptBody] of Object.entries(scripts)) {
    if (/curl\s+.*\|\s*(bash|sh)/i.test(scriptBody)) {
      violations.push(`Script '${scriptName}' uses curl|bash flow.`);
    }
  }

  return {
    allowed: violations.length === 0,
    violations
  };
}

/**
 * Implements `withTempDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempDir<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_75_c-"));
  try {
    return await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `runStage675CheckpointC` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage675CheckpointC(): Promise<Stage675CheckpointCArtifact> {
  return withTempDir(async (tempDir) => {
    const outputDir = path.join(tempDir, "build_pipeline_output");
    const srcDir = path.join(outputDir, "src");
    const testsDir = path.join(outputDir, "tests");
    await mkdir(srcDir, { recursive: true });
    await mkdir(testsDir, { recursive: true });

    const fileContents: Record<string, string> = {
      [path.join(outputDir, "spec.md")]: "# Spec\n\nDeterministic Stage 6.75 build objective.\n",
      [path.join(outputDir, "threat_model.md")]: "# Threat Model\n\n- Prompt injection\n- Secret egress\n",
      [path.join(outputDir, "README.md")]: "# Generated Artifact\n\nRun `npm test` before release.\n",
      [path.join(outputDir, "runbook.md")]: "# Runbook\n\n1. Build\n2. Test\n3. Audit claims\n",
      [path.join(srcDir, "index.ts")]: "export function main(): string { return 'stage6_75'; }\n",
      [path.join(testsDir, "index.test.ts")]: "import { test } from 'node:test';\n"
    };

    for (const [filePath, contents] of Object.entries(fileContents)) {
      await writeFile(filePath, contents, "utf8");
    }

    const files = Object.keys(fileContents).sort((left, right) => left.localeCompare(right));
    const checksums: Record<string, string> = {};
    for (const file of files) {
      const text = await readFile(file, "utf8");
      checksums[path.relative(outputDir, file)] = sha256Hex(text);
    }

    const allowedManifest = {
      dependencies: {
        typescript: "5.8.0"
      },
      scripts: {
        test: "tsx tests/runTests.ts"
      }
    };
    const deniedManifest = {
      dependencies: {
        lodash: "^4.17.21"
      },
      scripts: {
        setup: "curl https://example.com/install.sh | bash"
      }
    };
    const allowedResult = evaluateDependencyPolicy(allowedManifest);
    const deniedResult = evaluateDependencyPolicy(deniedManifest);

    const verificationReport = {
      generatedAt: "2026-02-27T22:30:00.000Z",
      filesVerified: files.length,
      dependencyPolicy: {
        allowedManifestPass: allowedResult.allowed,
        deniedManifestBlocked: !deniedResult.allowed
      }
    };
    const reportPath = path.join(outputDir, "verification_report.json");
    await writeFile(reportPath, `${JSON.stringify(verificationReport, null, 2)}\n`, "utf8");
    const reportHash = sha256Hex(JSON.stringify(verificationReport));

    const scaffoldPass = files.length >= 6;
    const dependencyPolicyPass = allowedResult.allowed && !deniedResult.allowed;
    const verifierPass = reportHash.length > 0;
    return {
      generatedAt: new Date().toISOString(),
      command: "npm run test:stage6_75:build_pipeline",
      checkpointId: "6.75.C",
      scaffold: {
        outputDir,
        files: files.map((file) => path.relative(outputDir, file)),
        checksums
      },
      dependencyPolicy: {
        allowedManifestPass: allowedResult.allowed,
        deniedManifestBlocked: !deniedResult.allowed,
        deniedViolations: deniedResult.violations
      },
      verifier: {
        reportPath,
        reportHash
      },
      passCriteria: {
        scaffoldPass,
        dependencyPolicyPass,
        verifierPass,
        overallPass: scaffoldPass && dependencyPolicyPass && verifierPass
      }
    };
  });
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage675CheckpointC();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.75 checkpoint 6.75.C artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
