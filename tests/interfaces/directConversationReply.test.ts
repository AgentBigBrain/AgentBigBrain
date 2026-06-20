import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import {
  runDirectConversationReplyWithRuntime
} from "../../src/interfaces/conversationRuntime/directConversationReply";
import {
  buildDirectReplyPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";
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

test("runDirectConversationReplyWithRuntime carries redacted direct-reply principal labels", async () => {
  let capturedRequest: StructuredCompletionRequest | null = null;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      capturedRequest = request;
      return { message: "You are the current speaker in this private chat." } as T;
    }
  };
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: "test-principal-hmac-key",
    BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-3"
  });
  const principalContext = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-3",
    userId: "owner-user-3",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-05-06T22:46:00.000Z",
    principalConfig
  });
  const principalAccess = buildDirectReplyPrincipalAccess(principalContext);

  await runDirectConversationReplyWithRuntime(
    "Tell me about myself.",
    "2026-05-06T22:46:00.000Z",
    DEFAULT_BRAIN_CONFIG,
    modelClient,
    principalAccess
  );

  const request = capturedRequest as StructuredCompletionRequest | null;
  assert.ok(request);
  const payload = JSON.parse(request.userPrompt) as {
    principalAccess?: {
      actorRole?: string;
      routeVisibility?: string;
      accessOperation?: string;
      accessClass?: string;
      accessAllowed?: boolean;
      accessReason?: string;
    };
  };
  assert.equal(payload.principalAccess?.actorRole, "owner");
  assert.equal(payload.principalAccess?.routeVisibility, "private");
  assert.equal(payload.principalAccess?.accessOperation, "direct_reply");
  assert.equal(payload.principalAccess?.accessClass, "owner_private");
  assert.equal(payload.principalAccess?.accessAllowed, true);
  assert.equal(payload.principalAccess?.accessReason, "owner_principal_matched");
  assert.equal(request.userPrompt.includes("owner-user-3"), false);
  assert.equal(request.userPrompt.includes(principalContext.actor.providerUserIdHash ?? ""), false);
});
