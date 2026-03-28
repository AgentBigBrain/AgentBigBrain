/**
 * @fileoverview Covers structured Codex runtime prompt transport and long-prompt spawning safety.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { completeCodexJsonRequest } from "../../src/models/codex/clientRuntime";
import type { ResolvedCodexModel } from "../../src/models/codex/contracts";

function createFakeCodexChild(
  onPromptFinished: (stdinText: string) => void
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdinText = "";

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    stdinText += chunk;
  });
  stdin.on("finish", () => {
    onPromptFinished(stdinText);
    setImmediate(() => {
      stdout.write(
        `${JSON.stringify({
          item: { type: "agent_message", text: JSON.stringify({ message: "ok" }) }
        })}\n`
      );
      stdout.write(
        `${JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 11, cached_input_tokens: 0, output_tokens: 7 }
        })}\n`
      );
      stdout.end();
      child.emit("close", 0, null);
    });
  });

  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill: () => true
  });
  return child;
}

test("completeCodexJsonRequest streams structured Codex prompts over stdin instead of argv", async () => {
  const captured: {
    executable: string | null;
    args: string[];
    stdinText: string | null;
  } = {
    executable: null,
    args: [],
    stdinText: null
  };

  const fakeSpawn = ((executable: string, args: readonly string[]) => {
    captured.executable = executable;
    captured.args = [...args];
    return createFakeCodexChild((stdinText) => {
      captured.stdinText = stdinText;
    });
  }) as unknown as typeof import("node:child_process").spawn;

  const model: ResolvedCodexModel = {
    requestedModel: "gpt-5.4",
    aliasModel: null,
    providerModel: "gpt-5.4"
  };
  const veryLongUserPrompt = `Voice note transcript: ${"build a calm drone landing page. ".repeat(4000)}`;

  const result = await completeCodexJsonRequest<{ message: string }>(
    {
      requestTimeoutMs: 10_000,
      workingDirectory: process.cwd(),
      env: process.env,
      spawnProcess: fakeSpawn
    },
    model,
    {
      model: "gpt-5.4",
      schemaName: "response_v1",
      systemPrompt: "Return bounded JSON.",
      userPrompt: veryLongUserPrompt,
      temperature: 0
    }
  );

  assert.equal(result.output.message, "ok");
  assert.equal(captured.args.at(-1), "-");
  assert.ok(
    !captured.args.some((value) => value.includes("Voice note transcript:")),
    "long prompt text should not be passed as a CLI argument"
  );
  assert.match(captured.stdinText ?? "", /System instructions:/);
  assert.match(captured.stdinText ?? "", /User request:/);
  assert.match(captured.stdinText ?? "", /Voice note transcript:/);
});
