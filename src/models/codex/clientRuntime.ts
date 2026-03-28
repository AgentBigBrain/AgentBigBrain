/**
 * @fileoverview Executes structured Codex CLI turns through JSONL event streaming.
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import { buildJsonSchemaForKnownModelSchema } from "../schema/jsonSchemas";
import { isKnownModelSchemaName, normalizeStructuredModelOutput, validateStructuredModelOutput } from "../schemaValidation";
import type { StructuredCompletionRequest } from "../types";
import type { CodexStructuredTurnResult, CodexTurnUsage, ResolvedCodexModel } from "./contracts";
import { resolveCodexCliPath } from "./cli";

export interface CodexClientRuntimeSettings {
  requestTimeoutMs: number;
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

interface CodexThreadEvent {
  type?: unknown;
  usage?: {
    input_tokens?: unknown;
    cached_input_tokens?: unknown;
    output_tokens?: unknown;
  };
  item?: unknown;
}

/**
 * Normalizes provider token counters to non-negative integers.
 *
 * @param value - Raw token metric from a Codex turn event.
 * @returns Floor-rounded non-negative token count.
 */
function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * Extracts bounded usage data from a Codex turn-completed event.
 *
 * @param event - Parsed Codex JSONL event payload.
 * @returns Normalized usage payload when present.
 */
function toUsage(event: CodexThreadEvent): CodexTurnUsage | null {
  if (!event.usage) {
    return null;
  }
  return {
    inputTokens: safeTokenCount(event.usage.input_tokens),
    cachedInputTokens: safeTokenCount(event.usage.cached_input_tokens),
    outputTokens: safeTokenCount(event.usage.output_tokens)
  };
}

/**
 * Builds the single Codex exec prompt that combines system and user instructions.
 *
 * @param request - Structured completion request being sent to Codex.
 * @returns Prompt text for the Codex CLI.
 */
function buildCodexPrompt(request: StructuredCompletionRequest): string {
  return [
    "System instructions:",
    request.systemPrompt,
    "",
    "User request:",
    request.userPrompt,
    "",
    "Return only the final JSON object that satisfies the provided schema."
  ].join("\n");
}

/**
 * Builds the bounded `codex exec` argument list for one structured turn.
 *
 * @param model - Resolved Codex model metadata.
 * @param schemaPath - JSON Schema file path passed to `codex exec --output-schema`.
 * @returns CLI arguments that keep the prompt off the command line.
 */
function buildStructuredCodexExecArgs(
  model: ResolvedCodexModel,
  schemaPath: string
): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model.providerModel,
    "--output-schema",
    schemaPath,
    "-"
  ];
}

/**
 * Executes one structured Codex CLI turn and validates the final JSON payload.
 *
 * @param settings - Codex runtime settings including timeout and isolated working directory.
 * @param model - Resolved Codex model metadata.
 * @param request - Structured completion request.
 * @returns Parsed and validated structured response plus token-usage metadata.
 */
export async function completeCodexJsonRequest<T>(
  settings: CodexClientRuntimeSettings,
  model: ResolvedCodexModel,
  request: StructuredCompletionRequest
): Promise<{ output: T; turn: CodexStructuredTurnResult }> {
  if (!isKnownModelSchemaName(request.schemaName)) {
    throw new Error(`Codex backend does not recognize schema "${request.schemaName}".`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-"));
  const schemaPath = path.join(tempDir, `${request.schemaName}.schema.json`);
  const schema = buildJsonSchemaForKnownModelSchema(request.schemaName);
  await writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");

  try {
    const turn = await executeStructuredCodexTurn(settings, model, request, schemaPath);
    const parsed = JSON.parse(turn.finalResponse) as unknown;
    const normalized = normalizeStructuredModelOutput(request.schemaName, parsed);
    validateStructuredModelOutput(request.schemaName, normalized);
    return {
      output: normalized as T,
      turn
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Executes one structured Codex CLI turn and captures JSONL events until completion.
 *
 * @param settings - Codex runtime settings including timeout and isolated working directory.
 * @param model - Resolved Codex model metadata.
 * @param request - Structured completion request.
 * @param schemaPath - JSON Schema file path passed to `codex exec --output-schema`.
 * @returns Final agent response text plus usage and streamed items.
 */
async function executeStructuredCodexTurn(
  settings: CodexClientRuntimeSettings,
  model: ResolvedCodexModel,
  request: StructuredCompletionRequest,
  schemaPath: string
): Promise<CodexStructuredTurnResult> {
  const cliPath = resolveCodexCliPath(settings.env);
  const prompt = buildCodexPrompt(request);
  const env = settings.env ?? process.env;
  const spawnProcess = settings.spawnProcess ?? spawn;

  return await new Promise<CodexStructuredTurnResult>((resolve, reject) => {
    const args = buildStructuredCodexExecArgs(model, schemaPath);
    const child = spawnProcess(cliPath, args, {
      cwd: settings.workingDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const items: unknown[] = [];
    let stderr = "";
    let finalResponse = "";
    let latestUsage: CodexTurnUsage | null = null;
    let settled = false;
    let bufferedStdout = "";
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      timeoutHandle = null;
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`Codex request timed out after ${settings.requestTimeoutMs}ms.`));
      }
    }, settings.requestTimeoutMs);

    const cleanup = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const rejectOnce = (error: Error): void => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bufferedStdout += chunk;
      const lines = bufferedStdout.split(/\r?\n/);
      bufferedStdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let event: CodexThreadEvent;
        try {
          event = JSON.parse(trimmed) as CodexThreadEvent;
        } catch (error) {
          rejectOnce(new Error(`Codex returned malformed JSONL event: ${String(error)}`));
          return;
        }
        if (event.item !== undefined) {
          items.push(event.item);
          const maybeMessage = event.item as { type?: unknown; text?: unknown };
          if (maybeMessage.type === "agent_message" && typeof maybeMessage.text === "string") {
            finalResponse = maybeMessage.text;
          }
        }
        if (event.type === "turn.completed") {
          latestUsage = toUsage(event);
        } else if (event.type === "turn.failed") {
          const message =
            typeof (event as { error?: { message?: unknown } }).error?.message === "string"
              ? (event as { error?: { message?: string } }).error!.message
              : "Codex turn failed.";
          rejectOnce(new Error(message));
          return;
        } else if (event.type === "error" && typeof (event as { message?: unknown }).message === "string") {
          rejectOnce(new Error((event as { message: string }).message));
          return;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      rejectOnce(new Error(`Failed to launch Codex CLI: ${error.message}`));
    });

    child.stdin.setDefaultEncoding("utf8");
    child.stdin.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (settled || code === "EPIPE") {
        return;
      }
      rejectOnce(new Error(`Failed to stream Codex prompt: ${(error as Error).message}`));
    });
    child.stdin.end(prompt);

    child.on("close", (code) => {
      cleanup();
      if (settled) {
        return;
      }
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `Codex CLI exited with code ${code ?? 1}. ${stderr.trim() || "No stderr output."}`
          )
        );
        return;
      }
      if (!finalResponse.trim()) {
        reject(new Error("Codex CLI returned no final agent message."));
        return;
      }
      resolve({
        finalResponse: finalResponse.trim(),
        usage: latestUsage,
        items
      });
    });
  });
}
