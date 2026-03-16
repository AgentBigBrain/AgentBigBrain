import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ExecutorExecutionOutcome,
  PlannedAction,
  RespondActionParams,
  RuntimeTraceDetailValue
} from "../../core/types";
import { buildExecutionOutcome, normalizeOptionalString } from "../liveRun/contracts";
import { resolveWorkspacePath } from "./pathRuntime";

const READ_FILE_OUTPUT_MAX_CHARS = 4000;

/**
 * Resolves the final response text for a `respond` action from the supported param aliases.
 *
 * @param params - Respond action params.
 * @returns Normalized response message or `null` when absent.
 */
export function resolveRespondMessage(params: RespondActionParams): string | null {
  return normalizeOptionalString(params.message) ?? normalizeOptionalString(params.text);
}

/**
 * Builds the bounded read-file success output plus compatibility execution metadata.
 *
 * @param targetPath - Original planner-supplied path.
 * @param content - Full file contents.
 * @returns Human-readable output and metadata describing truncation and size.
 */
export function buildReadFileSuccessOutput(
  targetPath: string,
  content: string
): {
  output: string;
  executionMetadata: Record<string, RuntimeTraceDetailValue>;
} {
  const truncated = content.length > READ_FILE_OUTPUT_MAX_CHARS;
  const returnedChars = truncated ? READ_FILE_OUTPUT_MAX_CHARS : content.length;
  const boundedContent = truncated
    ? `${content.slice(0, READ_FILE_OUTPUT_MAX_CHARS)}\n[...truncated]`
    : content;
  const output = truncated
    ? `Read success: ${targetPath} (${content.length} chars, truncated to ${READ_FILE_OUTPUT_MAX_CHARS}).\nRead preview:\n${boundedContent}`
    : `Read success: ${targetPath} (${content.length} chars).\nRead preview:\n${boundedContent}`;
  return {
    output,
    executionMetadata: {
      readFilePath: targetPath,
      readFileTotalChars: content.length,
      readFileReturnedChars: returnedChars,
      readFileTruncated: truncated,
      filePath: targetPath,
      contentLength: content.length,
      contentTruncated: truncated
    }
  };
}

/**
 * Builds compatibility metadata for simulated executor outcomes.
 *
 * @param reason - Stable simulation reason code.
 * @returns Execution metadata using both current and compatibility keys.
 */
export function buildSimulatedExecutionMetadata(
  reason: string
): Record<string, RuntimeTraceDetailValue> {
  return {
    simulatedExecution: true,
    simulatedExecutionReason: reason,
    simulated: true,
    simulationReason: reason
  };
}

/**
 * Executes the file-mutation and lightweight response actions owned by the executor entrypoint.
 *
 * @param action - Planned action to execute.
 * @returns Execution outcome for supported action types, or `null` when another runtime owns the action.
 */
export async function executeFileMutationAction(
  action: PlannedAction
): Promise<ExecutorExecutionOutcome | null> {
  switch (action.type) {
    case "respond": {
      const message = resolveRespondMessage(action.params);
      if (message && message.trim()) {
        return buildExecutionOutcome("success", message.trim());
      }
      return buildExecutionOutcome("success", "Response action approved.");
    }

    case "read_file": {
      const targetPath = normalizeOptionalString(action.params.path);
      if (!targetPath) {
        return buildExecutionOutcome("blocked", "Read skipped: missing path.", "READ_MISSING_PATH");
      }
      try {
        const content = await readFile(resolveWorkspacePath(targetPath), "utf8");
        const { output, executionMetadata } = buildReadFileSuccessOutput(targetPath, content);
        return buildExecutionOutcome("success", output, undefined, executionMetadata);
      } catch (error) {
        return buildExecutionOutcome(
          "failed",
          `Read failed: ${(error as Error).message}`,
          "ACTION_EXECUTION_FAILED"
        );
      }
    }

    case "write_file": {
      const targetPath = normalizeOptionalString(action.params.path);
      if (!targetPath) {
        return buildExecutionOutcome("blocked", "Write skipped: missing path.", "WRITE_MISSING_PATH");
      }
      if (typeof action.params.content !== "string") {
        return buildExecutionOutcome(
          "blocked",
          "Write blocked: missing params.content - planner must supply the file content string.",
          "ACTION_EXECUTION_FAILED"
        );
      }
      if (action.params.content.length === 0) {
        return buildExecutionOutcome(
          "blocked",
          "Write blocked: params.content is empty - planner must supply non-empty file content.",
          "ACTION_EXECUTION_FAILED"
        );
      }
      try {
        const outputPath = resolveWorkspacePath(targetPath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, action.params.content, "utf8");
        return buildExecutionOutcome(
          "success",
          `Write success: ${targetPath} (${action.params.content.length} chars)`,
          undefined,
          {
            writeFilePath: targetPath,
            filePath: targetPath,
            contentLength: action.params.content.length
          }
        );
      } catch (error) {
        return buildExecutionOutcome(
          "failed",
          `Write failed: ${(error as Error).message}`,
          "ACTION_EXECUTION_FAILED"
        );
      }
    }

    case "delete_file": {
      const targetPath = normalizeOptionalString(action.params.path);
      if (!targetPath) {
        return buildExecutionOutcome("blocked", "Delete skipped: missing path.", "DELETE_MISSING_PATH");
      }
      try {
        await rm(resolveWorkspacePath(targetPath), { force: true });
        return buildExecutionOutcome(
          "success",
          `Delete success: ${targetPath}`,
          undefined,
          {
            deleteFilePath: targetPath,
            filePath: targetPath
          }
        );
      } catch (error) {
        return buildExecutionOutcome(
          "failed",
          `Delete failed: ${(error as Error).message}`,
          "ACTION_EXECUTION_FAILED"
        );
      }
    }

    case "list_directory": {
      const targetPath = normalizeOptionalString(action.params.path);
      if (!targetPath) {
        return buildExecutionOutcome(
          "blocked",
          "List directory skipped: missing path.",
          "LIST_MISSING_PATH"
        );
      }
      try {
        const files = await readdir(resolveWorkspacePath(targetPath));
        return buildExecutionOutcome(
          "success",
          `Directory contents:\n${files.join("\n")}`,
          undefined,
          {
            directoryPath: targetPath,
            listedPath: targetPath,
            directoryEntryCount: files.length
          }
        );
      } catch (error) {
        return buildExecutionOutcome(
          "failed",
          `List directory failed: ${(error as Error).message}`,
          "ACTION_EXECUTION_FAILED"
        );
      }
    }

    case "self_modify":
      return buildExecutionOutcome(
        "success",
        "Self-modification simulated (requires governance workflow).",
        undefined,
        buildSimulatedExecutionMetadata("SELF_MODIFY_GOVERNANCE_REQUIRED")
      );

    case "memory_mutation":
      return buildExecutionOutcome(
        "blocked",
        "Memory mutation blocked: Stage 6.86 actions must execute through TaskRunner runtime action engine.",
        "MEMORY_MUTATION_BLOCKED"
      );

    case "pulse_emit":
      return buildExecutionOutcome(
        "blocked",
        "Pulse emit blocked: Stage 6.86 actions must execute through TaskRunner runtime action engine.",
        "PULSE_BLOCKED"
      );

    default:
      return null;
  }
}
