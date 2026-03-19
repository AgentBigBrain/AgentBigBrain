/**
 * @fileoverview Canonical Codex backend contracts for auth status, CLI execution, and model routing.
 */

export interface CodexAuthRecord {
  authMode: string;
  accessTokenPresent: boolean;
  refreshTokenPresent: boolean;
  idTokenPresent: boolean;
  accountId: string | null;
  lastRefreshAt: string | null;
}

export interface CodexAuthStatus {
  stateDir: string;
  authFilePath: string;
  profileId: string;
  usingLegacyFallback?: boolean;
  available: boolean;
  auth: CodexAuthRecord | null;
}

export interface ResolvedCodexModel {
  requestedModel: string;
  aliasModel: string | null;
  providerModel: string;
}

export interface CodexCliInvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexTurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CodexStructuredTurnResult {
  finalResponse: string;
  usage: CodexTurnUsage | null;
  items: unknown[];
}
