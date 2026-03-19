/**
 * @fileoverview Canonical per-session backend/profile selection helpers for interface runtime.
 */

import type { ModelBackend } from "../../models/types";
import { normalizeModelBackend } from "../../models/backendConfig";
import { buildCodexProfileEnvironment } from "../../models/codex/profileState";
import type { ConversationSession } from "../sessionStore";

export interface ConversationModelSelection {
  backend: ModelBackend;
  codexProfileId: string | null;
}

/**
 * Resolves the active backend/profile selection for one conversation session.
 *
 * @param session - Conversation session carrying optional override metadata.
 * @param env - Base environment used for fallback backend/profile selection.
 * @returns Canonical backend/profile selection.
 */
export function resolveConversationModelSelection(
  session: Pick<ConversationSession, "modelBackendOverride" | "codexAuthProfileId"> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): ConversationModelSelection {
  const backend = session?.modelBackendOverride
    ? normalizeModelBackend(session.modelBackendOverride)
    : normalizeModelBackend(env.BRAIN_MODEL_BACKEND);
  const codexProfileId = backend === "codex_oauth"
    ? (session?.codexAuthProfileId?.trim() || env.CODEX_AUTH_PROFILE?.trim() || "default")
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
  session: Pick<ConversationSession, "modelBackendOverride" | "codexAuthProfileId"> | null | undefined,
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
