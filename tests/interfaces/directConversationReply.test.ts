import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import {
  runDirectConversationReplyWithRuntime
} from "../../src/interfaces/conversationRuntime/directConversationReply";
import type {
  ModelClient,
  StructuredCompletionRequest
} from "../../src/models/types";

test("runDirectConversationReplyWithRuntime instructs the model to obey current-speaker name resolution blocks", async () => {
  let capturedRequest: StructuredCompletionRequest | null = null;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      capturedRequest = request;
      return { message: "Fixture is you in this chat." } as T;
    }
  };

  const reply = await runDirectConversationReplyWithRuntime(
    [
      "Current-speaker name resolution context:",
      "- The current request mentions 'Fixture', which matches the current speaker's transport given name.",
      "Current user request:",
      "Okay, so tell me about Fixture."
    ].join("\n"),
    "2026-05-06T22:46:00.000Z",
    DEFAULT_BRAIN_CONFIG,
    modelClient
  );

  assert.equal(reply, "Fixture is you in this chat.");
  const request = capturedRequest as StructuredCompletionRequest | null;
  assert.ok(request);
  assert.match(
    request.systemPrompt,
    /If the prompt includes Current-speaker name resolution context/
  );
  assert.match(
    request.systemPrompt,
    /according to the provided resolved scope/
  );
});
