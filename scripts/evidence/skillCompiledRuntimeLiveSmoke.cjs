/**
 * @fileoverview Runs an isolated compiled-runtime smoke test for skill lifecycle (`create_skill` -> `run_skill`) and emits a deterministic artifact.
 */

const { access, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const WORKSPACE_ROOT = process.cwd();
const COMMAND = 'npm run test:skill:compiled_live_smoke';
const ARTIFACT_PATH = path.resolve(
  WORKSPACE_ROOT,
  'runtime/evidence/skill_compiled_runtime_live_smoke_report.json'
);

/**
 * Removes temp directory with bounded retry to tolerate transient Windows file-handle lag.
 *
 * @param {string} targetPath - Absolute temp directory path to remove.
 * @returns {Promise<void>} Promise resolving when cleanup completes or retries are exhausted.
 */
async function removeTempDirWithRetry(targetPath) {
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw error;
      }
      if (attempt === maxAttempts) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }
}

/**
 * Executes one compiled runtime skill lifecycle smoke and returns artifact payload.
 *
 * @returns {Promise<object>} Artifact payload.
 */
async function runSkillCompiledRuntimeSmoke() {
  const failures = [];
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agentbigbrain-skill-compiled-smoke-'));

  let distExecutorModulePresent = false;
  let distConfigModulePresent = false;
  let createSkillStatus = 'not_run';
  let runSkillStatus = 'not_run';
  let createSkillOutput = '';
  let runSkillOutput = '';
  let jsArtifactPresent = false;
  let tsCompatibilityArtifactPresent = false;

  try {
    const executorModulePath = path.resolve(WORKSPACE_ROOT, 'dist/organs/executor.js');
    const configModulePath = path.resolve(WORKSPACE_ROOT, 'dist/core/config.js');

    try {
      await access(executorModulePath);
      distExecutorModulePresent = true;
    } catch {
      failures.push('missing_dist_executor_module');
    }

    try {
      await access(configModulePath);
      distConfigModulePresent = true;
    } catch {
      failures.push('missing_dist_config_module');
    }

    if (!distExecutorModulePresent || !distConfigModulePresent) {
      throw new Error('Compiled runtime modules are missing. Run `npm run build` before this smoke.');
    }

    const { ToolExecutorOrgan } = require(executorModulePath);
    const { DEFAULT_BRAIN_CONFIG } = require(configModulePath);

    process.chdir(tempDir);

    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const skillName = 'compiled_live_smoke_skill';

    const createAction = {
      id: 'action_create_skill_compiled_live_smoke',
      type: 'create_skill',
      description: 'Create compiled runtime smoke skill',
      params: {
        name: skillName,
        code: 'export function compiledLiveSmokeSkill(input: string): string { return input.trim().toUpperCase(); }'
      },
      estimatedCostUsd: 0.1
    };

    const runAction = {
      id: 'action_run_skill_compiled_live_smoke',
      type: 'run_skill',
      description: 'Run compiled runtime smoke skill',
      params: {
        name: skillName,
        input: 'compiled runtime smoke'
      },
      estimatedCostUsd: 0.1
    };

    const createOutcome = await executor.executeWithOutcome(createAction);
    const runOutcome = await executor.executeWithOutcome(runAction);

    createSkillStatus = createOutcome.status;
    runSkillStatus = runOutcome.status;
    createSkillOutput = createOutcome.output;
    runSkillOutput = runOutcome.output;

    const jsPath = path.resolve(tempDir, `runtime/skills/${skillName}.js`);
    const tsPath = path.resolve(tempDir, `runtime/skills/${skillName}.ts`);

    jsArtifactPresent = await access(jsPath).then(() => true).catch(() => false);
    tsCompatibilityArtifactPresent = await access(tsPath).then(() => true).catch(() => false);

    if (createOutcome.status !== 'success') {
      failures.push(`create_skill_not_success:${createOutcome.status}`);
    }
    if (runOutcome.status !== 'success') {
      failures.push(`run_skill_not_success:${runOutcome.status}`);
    }
    if (!/Run skill success:/i.test(runOutcome.output)) {
      failures.push('run_skill_success_prefix_missing');
    }
    if (!/COMPILED RUNTIME SMOKE/i.test(runOutcome.output)) {
      failures.push('run_skill_transformation_missing');
    }
    if (!jsArtifactPresent) {
      failures.push('missing_js_skill_artifact');
    }
    if (!tsCompatibilityArtifactPresent) {
      failures.push('missing_ts_compat_skill_artifact');
    }
  } finally {
    process.chdir(originalCwd);
    await removeTempDirWithRetry(tempDir);
  }

  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks: {
      distExecutorModulePresent,
      distConfigModulePresent,
      createSkillStatus,
      runSkillStatus,
      jsArtifactPresent,
      tsCompatibilityArtifactPresent
    },
    outputs: {
      createSkillOutput,
      runSkillOutput
    },
    failures
  };
}

/**
 * Entrypoint wrapper that runs smoke, writes artifact, and exits non-zero on failure.
 *
 * @returns {Promise<void>} Promise resolving when script exits.
 */
async function main() {
  const artifact = await runSkillCompiledRuntimeSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`Skill compiled runtime live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status !== 'PASS') {
    process.exit(1);
  }
}

main().catch(async (error) => {
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  const fallbackArtifact = {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status: 'FAIL',
    checks: {
      distExecutorModulePresent: false,
      distConfigModulePresent: false,
      createSkillStatus: 'not_run',
      runSkillStatus: 'not_run',
      jsArtifactPresent: false,
      tsCompatibilityArtifactPresent: false
    },
    outputs: {
      createSkillOutput: '',
      runSkillOutput: ''
    },
    failures: [`unhandled_error:${error instanceof Error ? error.message : String(error)}`]
  };
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(fallbackArtifact, null, 2)}\n`, 'utf8');
  console.error(error);
  process.exit(1);
});
