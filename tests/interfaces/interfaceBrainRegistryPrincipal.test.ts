/**
 * @fileoverview Tests principal envelope propagation on interface task envelopes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInterfaceTaskRequest } from "../../src/interfaces/interfaceBrainRegistry";
import {
  buildTaskExecutionPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

test("interface task request carries operation-specific principal access envelope", () => {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: "test-principal-hmac-key",
    BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1"
  });
  const principalContext = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "owner-user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig
  });
  const principalAccess = buildTaskExecutionPrincipalAccess(principalContext);
  const task = buildInterfaceTaskRequest(
    "  continue the work  ",
    "2026-05-10T12:00:05.000Z",
    principalAccess
  );

  assert.equal(task.userInput, "continue the work");
  assert.equal(task.principalAccess?.accessDecision.operation, "task_execution");
  assert.equal(task.principalAccess?.accessDecision.accessClass, "owner_private");
  const actor = task.principalAccess?.principalContext.actor as
    | { principalRole?: string }
    | undefined;
  assert.equal(actor?.principalRole, "owner");
});
