/**
 * @fileoverview Persists interface conversation session state for proposal-review workflows and continuous chat context.
 */

import path from "node:path";

import { LedgerBackend } from "../core/config";
import { withFileLock } from "../core/fileLock";
import type {
  InterfaceSessionFile,
  InterfaceSessionStoreOptions,
  SessionPersistenceContext
} from "./conversationRuntime/contracts";
import type { ConversationSession } from "./conversationRuntime/sessionStateContracts";
import { mergeConversationSession } from "./conversationRuntime/sessionMerging";
import { normalizeSession, normalizeState } from "./conversationRuntime/sessionNormalization";
export {
  appendPulseEmission,
  computeUserStyleFingerprint,
  detectTimezoneFromMessage,
  resolveUserLocalTime
} from "./conversationRuntime/sessionPulseMetadata";
export type {
  ConversationDomainContext,
  ConversationDomainContinuitySignals,
  ConversationDomainLane,
  ConversationDomainLaneSignal,
  ConversationDomainLaneSignalSource,
  ConversationDomainRoutingMode,
  ConversationDomainRoutingSignal,
  ConversationDomainSignalWindowUpdate
} from "../core/sessionContext";
export type { ResolvedUserLocalTime } from "./conversationRuntime/sessionPulseMetadata";
export type {
  ActiveClarificationOption,
  ActiveClarificationState,
  AgentPulseContextualLexicalEvidence,
  AgentPulseDecisionCode,
  AgentPulseMode,
  AgentPulseRouteStrategy,
  AgentPulseSessionState,
  ClarificationOptionId,
  ConversationAckLifecycleState,
  ConversationBrowserSessionRecord,
  ConversationBrowserSessionControllerKind,
  ConversationBrowserSessionStatus,
  ConversationActiveWorkspaceRecord,
  ConversationWorkspaceOwnershipState,
  ConversationWorkspacePreviewStackState,
  ConversationClassifierCategory,
  ConversationClassifierConfidenceTier,
  ConversationClassifierEvent,
  ConversationClassifierIntent,
  ConversationClassifierKind,
  ConversationFinalDeliveryOutcome,
  ConversationIntentMode,
  ConversationIntentModeSource,
  ConversationJob,
  ConversationJobStatus,
  ConversationModeContinuityState,
  ConversationPathDestinationRecord,
  ConversationProgressState,
  ConversationProgressStatus,
  ConversationRecoveryKind,
  ConversationRecoveryStatus,
  ConversationRecoveryTrace,
  ConversationReturnHandoffRecord,
  ConversationReturnHandoffStatus,
  ConversationRecentActionKind,
  ConversationRecentActionRecord,
  ConversationRecentActionStatus,
  ConversationSession,
  ConversationTurn,
  ConversationTransportIdentityRecord,
  ConversationTransportProvider,
  ConversationTurnRole,
  ConversationVisibility,
  PendingProposal,
  ProposalStatus
} from "./conversationRuntime/sessionStateContracts";
import {
  createEmptyInterfaceSessionFile,
  deleteSessionFromSqlite,
  initializeSqliteSessionBackend,
  listSessionsFromSqlite,
  readJsonSessionState,
  readSessionFromSqlite,
  writeJsonSessionState,
  writeSessionToSqlite
} from "./conversationRuntime/sessionPersistence";

export class InterfaceSessionStore {
  private loaded = false;
  private state: InterfaceSessionFile = createEmptyInterfaceSessionFile();
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;

  /**
   * Creates the stable interface session-store entrypoint for JSON or SQLite-backed persistence.
   */
  constructor(
    private readonly statePath: string = path.resolve(process.cwd(), "runtime/interface_sessions.json"),
    options: InterfaceSessionStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath = options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
  }

  /**
   * Reads one normalized conversation session from the configured backend.
   */
  async getSession(conversationId: string): Promise<ConversationSession | null> {
    if (this.backend === "sqlite") {
      return this.getSessionSqlite(conversationId);
    }

    await this.ensureLoaded();
    return this.state.conversations[conversationId] ?? null;
  }

  /**
   * Persists one normalized conversation session to the configured backend.
   */
  async setSession(session: ConversationSession): Promise<void> {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("Interface session payload is invalid.");
    }

    if (this.backend === "sqlite") {
      await this.setSessionSqlite(normalized);
      return;
    }

    await withFileLock(this.statePath, async () => {
      await this.ensureLoaded(true);
      const existing = this.state.conversations[normalized.conversationId] ?? null;
      this.state.conversations[normalized.conversationId] = existing
        ? mergeConversationSession(existing, normalized)
        : normalized;
      await this.persistJsonState();
    });
  }

  /**
   * Deletes one conversation session from the configured backend.
   */
  async deleteSession(conversationId: string): Promise<void> {
    if (this.backend === "sqlite") {
      await this.deleteSessionSqlite(conversationId);
      return;
    }

    await withFileLock(this.statePath, async () => {
      await this.ensureLoaded(true);
      delete this.state.conversations[conversationId];
      await this.persistJsonState();
    });
  }

  /**
   * Lists all normalized conversation sessions from the configured backend.
   */
  async listSessions(): Promise<ConversationSession[]> {
    if (this.backend === "sqlite") {
      return this.listSessionsSqlite();
    }

    await this.ensureLoaded();
    return Object.values(this.state.conversations);
  }

  /**
   * Loads JSON-backed session state on demand while preserving deterministic reload behavior.
   */
  private async ensureLoaded(forceReload = false): Promise<void> {
    if (this.backend === "sqlite") {
      return;
    }

    if (this.loaded && !forceReload) {
      return;
    }

    this.state = await this.readJsonStateFile();
    this.loaded = true;
  }

  /**
   * Reads the JSON-backed interface session snapshot through the canonical normalization callback.
   */
  private async readJsonStateFile(): Promise<InterfaceSessionFile> {
    return readJsonSessionState(this.statePath, normalizeState);
  }

  /**
   * Persists the in-memory JSON-backed interface session snapshot.
   */
  private async persistJsonState(): Promise<void> {
    await writeJsonSessionState(this.statePath, this.state);
  }

  /**
   * Reads one normalized session from the SQLite backend.
   */
  private async getSessionSqlite(conversationId: string): Promise<ConversationSession | null> {
    await this.ensureSqliteReady();
    return readSessionFromSqlite(this.sqlitePath, conversationId, normalizeSession);
  }

  /**
   * Persists one normalized session to the SQLite backend.
   */
  private async setSessionSqlite(session: ConversationSession): Promise<void> {
    await this.ensureSqliteReady();
    await writeSessionToSqlite(this.getPersistenceContext(), session);
  }

  /**
   * Deletes one session from the SQLite backend.
   */
  private async deleteSessionSqlite(conversationId: string): Promise<void> {
    await this.ensureSqliteReady();
    await deleteSessionFromSqlite(this.getPersistenceContext(), conversationId);
  }

  /**
   * Lists normalized sessions from the SQLite backend.
   */
  private async listSessionsSqlite(): Promise<ConversationSession[]> {
    await this.ensureSqliteReady();
    return listSessionsFromSqlite(this.sqlitePath, normalizeSession);
  }

  /**
   * Ensures the SQLite backend schema and bootstrap state are ready before reads or writes.
   */
  private async ensureSqliteReady(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }

    await initializeSqliteSessionBackend(this.getPersistenceContext());
    this.sqliteReady = true;
  }

  /**
   * Builds the canonical persistence context shared by JSON and SQLite session helpers.
   */
  private getPersistenceContext(): SessionPersistenceContext {
    return {
      statePath: this.statePath,
      sqlitePath: this.sqlitePath,
      exportJsonOnWrite: this.exportJsonOnWrite,
      normalizeSession,
      normalizeState
    };
  }
}
