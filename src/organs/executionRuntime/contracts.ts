import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { BrainConfig } from "../../core/config";
import { ShellCommandActionParams } from "../../core/types";
import { BrowserVerifier } from "../liveRun/browserVerifier";
import { ManagedProcessRegistry } from "../liveRun/managedProcessRegistry";

export interface CappedTextBuffer {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface ShellExecutionTelemetry {
  shellProfileFingerprint: string;
  shellSpawnSpecFingerprint: string;
  shellKind: string;
  shellExecutable: string;
  shellTimeoutMs: number;
  shellEnvMode: string;
  shellEnvKeyCount: number;
  shellEnvRedactedKeyCount: number;
  shellExitCode: number | null;
  shellSignal: string | null;
  shellTimedOut: boolean;
  shellStdoutDigest: string;
  shellStderrDigest: string;
  shellStdoutBytes: number;
  shellStderrBytes: number;
  shellStdoutTruncated: boolean;
  shellStderrTruncated: boolean;
}

export interface SkillArtifactPaths {
  skillsRoot: string;
  primaryPath: string;
  compatibilityPath: string;
  manifestPath: string;
}

export interface ResolvedSkillArtifact {
  path: string;
  extension: ".js" | ".ts";
}

export interface TypeScriptTranspiler {
  transpileModule: (
    sourceCode: string,
    options: {
      compilerOptions: {
        module: number;
        target: number;
      };
    }
  ) => { outputText: string };
  ModuleKind?: {
    ESNext: number;
  };
  ScriptTarget?: {
    ES2020: number;
  };
}

export interface ShellExecutionDependencies {
  config: BrainConfig;
  shellSpawn: typeof spawn;
}

export interface ShellExecutionResult {
  outcome: import("../../core/types").ExecutorExecutionOutcome;
  telemetry?: ShellExecutionTelemetry;
}

export interface ExecutorLiveRunRuntime {
  config: BrainConfig;
  shellSpawn: typeof spawn;
  managedProcessRegistry: ManagedProcessRegistry;
  browserVerifier: BrowserVerifier;
  resolveShellCommandCwd(params: ShellCommandActionParams): string | null;
  terminateProcessTree(
    child: ChildProcess | ChildProcessWithoutNullStreams
  ): Promise<boolean>;
}
