/**
 * @fileoverview Synthetic principal-access helpers for tests.
 */

import {
  buildTaskExecutionPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

const TEST_PRINCIPAL_HMAC_KEY = "test-principal-hmac-key";
const TEST_OBSERVED_AT = "2026-05-10T12:00:00.000Z";

/**
 * Builds a synthetic owner task principal for tests that are not focused on access policy.
 *
 * **Why it exists:**
 * Profile-memory helpers fail closed without typed principal metadata, so legacy tests that focus
 * on unrelated filtering behavior need an explicit synthetic owner envelope instead of relying on
 * missing actor context as implicit authority.
 *
 * **What it talks to:**
 * - Uses `buildTaskExecutionPrincipalAccess` from `../../src/interfaces/principalRuntime/principalAccess`.
 * - Uses `derivePrincipalContextFromIngress` from `../../src/interfaces/principalRuntime/principalAccess`.
 * - Uses `createOwnerOperatorPrincipalConfigFromEnv` from `../../src/interfaces/principalRuntime/principalConfig`.
 *
 * @returns Test-only owner principal access metadata.
 */
export function buildTestOwnerTaskPrincipalAccess() {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: TEST_PRINCIPAL_HMAC_KEY,
    BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1"
  });
  return buildTaskExecutionPrincipalAccess(
    derivePrincipalContextFromIngress({
      provider: "telegram",
      conversationId: "test-private-chat",
      userId: "owner-user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: TEST_OBSERVED_AT,
      principalConfig
    })
  );
}
