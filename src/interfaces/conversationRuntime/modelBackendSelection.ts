/**
 * @fileoverview Canonical per-session backend/profile selection helpers for interface runtime.
 */

import type { ModelBackend } from "../../models/types";
import { normalizeModelBackend } from "../../models/backendConfig";
import { buildCodexProfileEnvironment } from "../../models/codex/profileState";
import type { ConversationSession } from "../sessionStore";
import type { PrincipalContext } from "../principalRuntime/principalAccess";
import {
  canUseProtectedModelSelection,
  isProtectedModelBackendOverride
} from "./backendProfileOverridePolicy";

export interface ConversationModelSelection {
  backend: ModelBackend;
  codexProfileId: string | null;
}

type ModelSelectionSession = Pick<
  ConversationSession,
  "modelBackendOverride" | "codexAuthProfileId"
> & { principalContext?: PrincipalContext | null };

/**
 * Resolves the active backend/profile selection for one conversation session.
 *
 * @param session - Conversation session carrying optional override metadata.
 * @param env - Base environment used for fallback backend/profile selection.
 * @returns Canonical backend/profile selection.
 */
export function resolveConversationModelSelection(
  session: ModelSelectionSession | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): ConversationModelSelection {
  const sessionBackend = resolveAuthorizedSessionBackend(session);
  const backend = sessionBackend
    ? normalizeModelBackend(sessionBackend)
    : normalizeModelBackend(env.BRAIN_MODEL_BACKEND);
  const authorizedSessionProfile =
    canUseProtectedModelSelection(session?.principalContext) ? session?.codexAuthProfileId?.trim() : "";
  const codexProfileId = backend === "codex_oauth"
    ? (authorizedSessionProfile || env.CODEX_AUTH_PROFILE?.trim() || "default")
    : null;
  return {
    backend,
    codexProfileId
  };
}

/**
 * Builds an environment map for one conversation session's selected model backend/profile.
 *
 * @param session - Conversation session carrying optional override metadata.
 * @param env - Base process environment.
 * @returns Environment map used by backend-aware runtime helpers.
 */
export function buildConversationModelEnvironment(
  session: ModelSelectionSession | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const selection = resolveConversationModelSelection(session, env);
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    BRAIN_MODEL_BACKEND: selection.backend
  };
  if (selection.backend === "codex_oauth") {
    return buildCodexProfileEnvironment(nextEnv, selection.codexProfileId);
  }
  delete nextEnv.CODEX_AUTH_PROFILE;
  delete nextEnv.CODEX_HOME;
  return nextEnv;
}

/**
 * Implements `resolveAuthorizedSessionBackend` behavior within this module.
 */
function resolveAuthorizedSessionBackend(
  session: (Pick<ConversationSession, "modelBackendOverride"> & {
    principalContext?: PrincipalContext | null;
  }) | null | undefined
): ModelBackend | null {
  if (!session?.modelBackendOverride) {
    return null;
  }
  const backend = normalizeModelBackend(session.modelBackendOverride);
  if (!isProtectedModelBackendOverride(backend)) {
    return backend;
  }
  return canUseProtectedModelSelection(session.principalContext) ? backend : null;
}
