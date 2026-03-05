/**
 * @fileoverview Deterministically audits capability claims against executable evidence and ledger assertions.
 */

import { exec as execCallback } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);

export type ClaimStatus = "VERIFIED" | "PARTIALLY VERIFIED" | "UNVERIFIED";
export type ClaimVerificationLevel = "runtime_path" | "boundary_only" | "none";
export type RewardStageStatus = "pending" | "ready_for_review" | "awarded";
export type RewardReviewDecision = "pending" | "approved" | "rejected";
export type RewardCheckpointStatus = "pending" | "passed";

export interface CommandEvidence {
  type: "command";
  id: string;
  command: string;
  expectedExitCode?: number;
  timeoutMs?: number;
}

export interface ArtifactEvidence {
  type: "artifact";
  path: string;
  minBytes?: number;
  mustContain?: string;
}

export interface TestPathEvidence {
  type: "test_path";
  path: string;
}

export interface RewardStageEvidence {
  type: "reward_stage";
  path: string;
  stageId: string;
  expectedStatus: RewardStageStatus;
  expectedReviewDecision?: RewardReviewDecision;
}

export interface RewardCheckpointEvidence {
  type: "reward_checkpoint";
  path: string;
  stageId: string;
  checkpointId: string;
  expectedStatus: RewardCheckpointStatus;
}

export type ClaimEvidence =
  | CommandEvidence
  | ArtifactEvidence
  | TestPathEvidence
  | RewardStageEvidence
  | RewardCheckpointEvidence;

export interface CapabilityClaim {
  id: string;
  summary: string;
  status: ClaimStatus;
  verificationLevel: ClaimVerificationLevel;
  evidence: readonly ClaimEvidence[];
}

export interface CapabilityClaimManifest {
  schemaVersion: 1;
  generatedAt: string;
  claims: readonly CapabilityClaim[];
}

export interface CommandRunResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export type CommandRunner = (command: string, timeoutMs: number) => Promise<CommandRunResult>;

export interface EvidenceAuditResult {
  ok: boolean;
  evidenceType: ClaimEvidence["type"];
  detail: string;
  commandId?: string;
  commandExitCode?: number;
  artifactPath?: string;
}

export interface ClaimAuditResult {
  claimId: string;
  status: ClaimStatus;
  verificationLevel: ClaimVerificationLevel;
  ok: boolean;
  failures: readonly string[];
  evidenceResults: readonly EvidenceAuditResult[];
}

export interface ClaimAuditTotals {
  totalClaims: number;
  passedClaims: number;
  failedClaims: number;
}

export interface CapabilityClaimAuditReport {
  manifestPath: string;
  auditedAt: string;
  overallPass: boolean;
  totals: ClaimAuditTotals;
  claims: readonly ClaimAuditResult[];
}

export interface AuditClaimsOptions {
  cwd?: string;
  commandRunner?: CommandRunner;
  defaultCommandTimeoutMs?: number;
}

interface RewardCheckpointRecord {
  id: string;
  status: RewardCheckpointStatus;
}

interface RewardStageReviewRecord {
  decision: RewardReviewDecision;
}

interface RewardStageRecord {
  id: string;
  status: RewardStageStatus;
  checkpoints: readonly RewardCheckpointRecord[];
  review: RewardStageReviewRecord | null;
}

interface RewardLedgerRecord {
  stages: readonly RewardStageRecord[];
}

interface ExecErrorShape extends Error {
  code?: number | string;
  signal?: NodeJS.Signals;
  stdout?: string;
  stderr?: string;
}

/**
 * Implements `isRecord` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Implements `isNonEmptyString` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Implements `isNonNegativeInteger` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Implements `isClaimStatus` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isClaimStatus(value: unknown): value is ClaimStatus {
  return value === "VERIFIED" || value === "PARTIALLY VERIFIED" || value === "UNVERIFIED";
}

/**
 * Implements `isClaimVerificationLevel` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isClaimVerificationLevel(value: unknown): value is ClaimVerificationLevel {
  return value === "runtime_path" || value === "boundary_only" || value === "none";
}

/**
 * Implements `isRewardStageStatus` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardStageStatus(value: unknown): value is RewardStageStatus {
  return value === "pending" || value === "ready_for_review" || value === "awarded";
}

/**
 * Implements `isRewardReviewDecision` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardReviewDecision(value: unknown): value is RewardReviewDecision {
  return value === "pending" || value === "approved" || value === "rejected";
}

/**
 * Implements `isRewardCheckpointStatus` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardCheckpointStatus(value: unknown): value is RewardCheckpointStatus {
  return value === "pending" || value === "passed";
}

/**
 * Implements `isCommandEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isCommandEvidence(value: unknown): value is CommandEvidence {
  if (!isRecord(value) || value.type !== "command") {
    return false;
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.command)) {
    return false;
  }
  if (value.expectedExitCode !== undefined && !isNonNegativeInteger(value.expectedExitCode)) {
    return false;
  }
  if (value.timeoutMs !== undefined && !isNonNegativeInteger(value.timeoutMs)) {
    return false;
  }
  return true;
}

/**
 * Implements `isArtifactEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isArtifactEvidence(value: unknown): value is ArtifactEvidence {
  if (!isRecord(value) || value.type !== "artifact") {
    return false;
  }
  if (!isNonEmptyString(value.path)) {
    return false;
  }
  if (value.minBytes !== undefined && !isNonNegativeInteger(value.minBytes)) {
    return false;
  }
  if (value.mustContain !== undefined && typeof value.mustContain !== "string") {
    return false;
  }
  return true;
}

/**
 * Implements `isTestPathEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isTestPathEvidence(value: unknown): value is TestPathEvidence {
  return isRecord(value) && value.type === "test_path" && isNonEmptyString(value.path);
}

/**
 * Implements `isRewardStageEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardStageEvidence(value: unknown): value is RewardStageEvidence {
  if (!isRecord(value) || value.type !== "reward_stage") {
    return false;
  }
  return (
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.stageId) &&
    isRewardStageStatus(value.expectedStatus) &&
    (value.expectedReviewDecision === undefined ||
      isRewardReviewDecision(value.expectedReviewDecision))
  );
}

/**
 * Implements `isRewardCheckpointEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardCheckpointEvidence(value: unknown): value is RewardCheckpointEvidence {
  if (!isRecord(value) || value.type !== "reward_checkpoint") {
    return false;
  }
  return (
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.stageId) &&
    isNonEmptyString(value.checkpointId) &&
    isRewardCheckpointStatus(value.expectedStatus)
  );
}

/**
 * Implements `isClaimEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isClaimEvidence(value: unknown): value is ClaimEvidence {
  return (
    isCommandEvidence(value) ||
    isArtifactEvidence(value) ||
    isTestPathEvidence(value) ||
    isRewardStageEvidence(value) ||
    isRewardCheckpointEvidence(value)
  );
}

/**
 * Implements `isCapabilityClaim` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isCapabilityClaim(value: unknown): value is CapabilityClaim {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.summary) ||
    !isClaimStatus(value.status) ||
    !isClaimVerificationLevel(value.verificationLevel)
  ) {
    return false;
  }
  if (!Array.isArray(value.evidence)) {
    return false;
  }
  return value.evidence.every((evidence) => isClaimEvidence(evidence));
}

/**
 * Implements `stripUtf8Bom` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Implements `isCapabilityClaimManifest` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export function isCapabilityClaimManifest(value: unknown): value is CapabilityClaimManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isNonEmptyString(value.generatedAt)) {
    return false;
  }
  if (!Array.isArray(value.claims)) {
    return false;
  }
  return value.claims.every((claim) => isCapabilityClaim(claim));
}

/**
 * Implements `parseCapabilityClaimManifest` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export function parseCapabilityClaimManifest(raw: string): CapabilityClaimManifest {
  const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;
  if (!isCapabilityClaimManifest(parsed)) {
    throw new Error("Capability claim manifest is invalid.");
  }
  return parsed;
}

/**
 * Implements `resolveCommandExitCode` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function resolveCommandExitCode(error: ExecErrorShape): number {
  if (typeof error.code === "number" && Number.isFinite(error.code)) {
    return error.code;
  }
  if (typeof error.code === "string" && error.code.toUpperCase() === "ETIMEDOUT") {
    return 124;
  }
  if (error.signal) {
    return 128;
  }
  return 1;
}

/**
 * Implements `runCommandWithShell` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runCommandWithShell(command: string, timeoutMs: number): Promise<CommandRunResult> {
  const startedAtMs = Date.now();
  try {
    const { stdout, stderr } = await exec(command, {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 16
    });
    return {
      command,
      exitCode: 0,
      stdout,
      stderr,
      timedOut: false,
      durationMs: Date.now() - startedAtMs
    };
  } catch (error) {
    const err = error as ExecErrorShape;
    return {
      command,
      exitCode: resolveCommandExitCode(err),
      stdout: err.stdout ?? "",
      stderr: [err.stderr ?? "", err.message ?? ""].filter(Boolean).join("\n"),
      timedOut:
        err.code === "ETIMEDOUT" ||
        (typeof err.message === "string" &&
          err.message.toLowerCase().includes("timed out")),
      durationMs: Date.now() - startedAtMs
    };
  }
}

/**
 * Implements `toRelativePath` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toRelativePath(cwd: string, targetPath: string): string {
  const relativePath = path.relative(cwd, targetPath);
  return relativePath.length > 0 ? relativePath : ".";
}

/**
 * Implements `validateClaimContract` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function validateClaimContract(claim: CapabilityClaim): string[] {
  const issues: string[] = [];
  const hasCommandEvidence = claim.evidence.some((evidence) => evidence.type === "command");
  const commandIds = claim.evidence
    .filter((evidence): evidence is CommandEvidence => evidence.type === "command")
    .map((evidence) => evidence.id);
  const duplicateCommandIds = commandIds.filter(
    (id, index) => commandIds.indexOf(id) !== index
  );

  if (duplicateCommandIds.length > 0) {
    issues.push(`Duplicate command evidence id(s): ${Array.from(new Set(duplicateCommandIds)).join(", ")}`);
  }
  if (claim.status === "VERIFIED" && claim.verificationLevel !== "runtime_path") {
    issues.push("VERIFIED claim must use verificationLevel `runtime_path`.");
  }
  if (claim.status === "PARTIALLY VERIFIED" && claim.verificationLevel !== "boundary_only") {
    issues.push("PARTIALLY VERIFIED claim must use verificationLevel `boundary_only`.");
  }
  if (claim.status === "UNVERIFIED" && claim.verificationLevel !== "none") {
    issues.push("UNVERIFIED claim must use verificationLevel `none`.");
  }
  if (claim.status === "UNVERIFIED" && claim.evidence.length > 0) {
    issues.push("UNVERIFIED claim cannot include evidence entries.");
  }
  if (claim.status !== "UNVERIFIED" && claim.evidence.length === 0) {
    issues.push("Verified claims require at least one evidence entry.");
  }
  if (claim.status === "VERIFIED" && !hasCommandEvidence) {
    issues.push("VERIFIED claim requires at least one command evidence entry.");
  }

  return issues;
}

/**
 * Implements `isRewardCheckpointRecord` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardCheckpointRecord(value: unknown): value is RewardCheckpointRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isRewardCheckpointStatus(value.status)
  );
}

/**
 * Implements `isRewardStageReviewRecord` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardStageReviewRecord(value: unknown): value is RewardStageReviewRecord {
  return isRecord(value) && isRewardReviewDecision(value.decision);
}

/**
 * Implements `isRewardStageRecord` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardStageRecord(value: unknown): value is RewardStageRecord {
  if (!isRecord(value)) {
    return false;
  }
  if (!isNonEmptyString(value.id) || !isRewardStageStatus(value.status)) {
    return false;
  }
  if (!Array.isArray(value.checkpoints) || !value.checkpoints.every((cp) => isRewardCheckpointRecord(cp))) {
    return false;
  }
  if (value.review !== null && value.review !== undefined && !isRewardStageReviewRecord(value.review)) {
    return false;
  }
  return true;
}

/**
 * Implements `isRewardLedgerRecord` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isRewardLedgerRecord(value: unknown): value is RewardLedgerRecord {
  return (
    isRecord(value) &&
    Array.isArray(value.stages) &&
    value.stages.every((stage) => isRewardStageRecord(stage))
  );
}

/**
 * Implements `readRewardLedger` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function readRewardLedger(
  rewardLedgerPath: string,
  cache: Map<string, RewardLedgerRecord | null>
): Promise<RewardLedgerRecord | null> {
  const cached = cache.get(rewardLedgerPath);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const raw = await readFile(rewardLedgerPath, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;
    if (!isRewardLedgerRecord(parsed)) {
      cache.set(rewardLedgerPath, null);
      return null;
    }
    cache.set(rewardLedgerPath, parsed);
    return parsed;
  } catch {
    cache.set(rewardLedgerPath, null);
    return null;
  }
}

/**
 * Implements `auditCommandEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function auditCommandEvidence(
  evidence: CommandEvidence,
  defaultCommandTimeoutMs: number,
  commandRunner: CommandRunner,
  commandCache: Map<string, CommandRunResult>
): Promise<EvidenceAuditResult> {
  const timeoutMs = evidence.timeoutMs ?? defaultCommandTimeoutMs;
  const expectedExitCode = evidence.expectedExitCode ?? 0;
  const commandCacheKey = `${timeoutMs}:${evidence.command}`;
  const runResult =
    commandCache.get(commandCacheKey) ??
    (await commandRunner(evidence.command, timeoutMs));
  if (!commandCache.has(commandCacheKey)) {
    commandCache.set(commandCacheKey, runResult);
  }

  if (runResult.exitCode !== expectedExitCode) {
    return {
      ok: false,
      evidenceType: evidence.type,
      commandId: evidence.id,
      commandExitCode: runResult.exitCode,
      detail: `Command \`${evidence.command}\` exited with ${runResult.exitCode}; expected ${expectedExitCode}.`
    };
  }
  return {
    ok: true,
    evidenceType: evidence.type,
    commandId: evidence.id,
    commandExitCode: runResult.exitCode,
    detail: `Command \`${evidence.command}\` matched expected exit code ${expectedExitCode}.`
  };
}

/**
 * Implements `auditArtifactEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function auditArtifactEvidence(
  evidence: ArtifactEvidence,
  cwd: string
): Promise<EvidenceAuditResult> {
  const artifactPath = path.resolve(cwd, evidence.path);
  try {
    const artifactStats = await stat(artifactPath);
    if (!artifactStats.isFile()) {
      return {
        ok: false,
        evidenceType: evidence.type,
        artifactPath: toRelativePath(cwd, artifactPath),
        detail: "Artifact path exists but is not a file."
      };
    }
    if (evidence.minBytes !== undefined && artifactStats.size < evidence.minBytes) {
      return {
        ok: false,
        evidenceType: evidence.type,
        artifactPath: toRelativePath(cwd, artifactPath),
        detail: `Artifact size ${artifactStats.size} is smaller than required minimum ${evidence.minBytes}.`
      };
    }
    if (evidence.mustContain !== undefined) {
      const raw = await readFile(artifactPath, "utf8");
      if (!raw.includes(evidence.mustContain)) {
        return {
          ok: false,
          evidenceType: evidence.type,
          artifactPath: toRelativePath(cwd, artifactPath),
          detail: "Artifact content check failed: required pattern not found."
        };
      }
    }
    return {
      ok: true,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, artifactPath),
      detail: "Artifact exists and passed configured checks."
    };
  } catch {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, artifactPath),
      detail: "Artifact path does not exist."
    };
  }
}

/**
 * Implements `auditTestPathEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function auditTestPathEvidence(
  evidence: TestPathEvidence,
  cwd: string
): Promise<EvidenceAuditResult> {
  const testPath = path.resolve(cwd, evidence.path);
  try {
    await access(testPath);
    if (!testPath.endsWith(".test.ts")) {
      return {
        ok: false,
        evidenceType: evidence.type,
        artifactPath: toRelativePath(cwd, testPath),
        detail: "Test path must reference a .test.ts file."
      };
    }
    return {
      ok: true,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, testPath),
      detail: "Test path exists."
    };
  } catch {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, testPath),
      detail: "Test path does not exist."
    };
  }
}

/**
 * Implements `auditRewardStageEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function auditRewardStageEvidence(
  evidence: RewardStageEvidence,
  cwd: string,
  rewardLedgerCache: Map<string, RewardLedgerRecord | null>
): Promise<EvidenceAuditResult> {
  const rewardLedgerPath = path.resolve(cwd, evidence.path);
  const ledger = await readRewardLedger(rewardLedgerPath, rewardLedgerCache);
  if (!ledger) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: "Reward ledger file missing or invalid."
    };
  }
  const stage = ledger.stages.find((candidate) => candidate.id === evidence.stageId);
  if (!stage) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: `Stage \`${evidence.stageId}\` not found in reward ledger.`
    };
  }
  if (stage.status !== evidence.expectedStatus) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: `Stage status mismatch: expected \`${evidence.expectedStatus}\`, found \`${stage.status}\`.`
    };
  }
  if (
    evidence.expectedReviewDecision !== undefined &&
    stage.review?.decision !== evidence.expectedReviewDecision
  ) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: `Stage review decision mismatch: expected \`${evidence.expectedReviewDecision}\`, found \`${stage.review?.decision ?? "none"}\`.`
    };
  }
  return {
    ok: true,
    evidenceType: evidence.type,
    artifactPath: toRelativePath(cwd, rewardLedgerPath),
    detail: "Reward stage assertion passed."
  };
}

/**
 * Implements `auditRewardCheckpointEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function auditRewardCheckpointEvidence(
  evidence: RewardCheckpointEvidence,
  cwd: string,
  rewardLedgerCache: Map<string, RewardLedgerRecord | null>
): Promise<EvidenceAuditResult> {
  const rewardLedgerPath = path.resolve(cwd, evidence.path);
  const ledger = await readRewardLedger(rewardLedgerPath, rewardLedgerCache);
  if (!ledger) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: "Reward ledger file missing or invalid."
    };
  }
  const stage = ledger.stages.find((candidate) => candidate.id === evidence.stageId);
  if (!stage) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: `Stage \`${evidence.stageId}\` not found in reward ledger.`
    };
  }
  const checkpoint = stage.checkpoints.find((candidate) => candidate.id === evidence.checkpointId);
  if (!checkpoint) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: `Checkpoint \`${evidence.checkpointId}\` not found in stage \`${evidence.stageId}\`.`
    };
  }
  if (checkpoint.status !== evidence.expectedStatus) {
    return {
      ok: false,
      evidenceType: evidence.type,
      artifactPath: toRelativePath(cwd, rewardLedgerPath),
      detail: `Checkpoint status mismatch: expected \`${evidence.expectedStatus}\`, found \`${checkpoint.status}\`.`
    };
  }
  return {
    ok: true,
    evidenceType: evidence.type,
    artifactPath: toRelativePath(cwd, rewardLedgerPath),
    detail: "Reward checkpoint assertion passed."
  };
}

/**
 * Implements `auditEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function auditEvidence(
  evidence: ClaimEvidence,
  options: {
    cwd: string;
    defaultCommandTimeoutMs: number;
    commandRunner: CommandRunner;
    commandCache: Map<string, CommandRunResult>;
    rewardLedgerCache: Map<string, RewardLedgerRecord | null>;
  }
): Promise<EvidenceAuditResult> {
  if (evidence.type === "command") {
    return auditCommandEvidence(
      evidence,
      options.defaultCommandTimeoutMs,
      options.commandRunner,
      options.commandCache
    );
  }
  if (evidence.type === "artifact") {
    return auditArtifactEvidence(evidence, options.cwd);
  }
  if (evidence.type === "test_path") {
    return auditTestPathEvidence(evidence, options.cwd);
  }
  if (evidence.type === "reward_stage") {
    return auditRewardStageEvidence(evidence, options.cwd, options.rewardLedgerCache);
  }
  return auditRewardCheckpointEvidence(evidence, options.cwd, options.rewardLedgerCache);
}

/**
 * Implements `auditCapabilityClaimManifest` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function auditCapabilityClaimManifest(
  manifest: CapabilityClaimManifest,
  manifestPath: string,
  options: AuditClaimsOptions = {}
): Promise<CapabilityClaimAuditReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const commandRunner = options.commandRunner ?? runCommandWithShell;
  const defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? 180_000;
  const commandCache = new Map<string, CommandRunResult>();
  const rewardLedgerCache = new Map<string, RewardLedgerRecord | null>();
  const seenClaimIds = new Set<string>();
  const claimResults: ClaimAuditResult[] = [];

  for (const claim of manifest.claims) {
    const failures: string[] = [];
    const evidenceResults: EvidenceAuditResult[] = [];

    if (seenClaimIds.has(claim.id)) {
      failures.push(`Duplicate claim id: ${claim.id}`);
    }
    seenClaimIds.add(claim.id);

    for (const issue of validateClaimContract(claim)) {
      failures.push(issue);
    }

    for (const evidence of claim.evidence) {
      const evidenceResult = await auditEvidence(evidence, {
        cwd,
        defaultCommandTimeoutMs,
        commandRunner,
        commandCache,
        rewardLedgerCache
      });
      evidenceResults.push(evidenceResult);
      if (!evidenceResult.ok) {
        failures.push(evidenceResult.detail);
      }
    }

    claimResults.push({
      claimId: claim.id,
      status: claim.status,
      verificationLevel: claim.verificationLevel,
      ok: failures.length === 0,
      failures,
      evidenceResults
    });
  }

  const failedClaims = claimResults.filter((result) => !result.ok).length;
  const passedClaims = claimResults.length - failedClaims;
  return {
    manifestPath: toRelativePath(cwd, path.resolve(cwd, manifestPath)),
    auditedAt: new Date().toISOString(),
    overallPass: failedClaims === 0,
    totals: {
      totalClaims: claimResults.length,
      passedClaims,
      failedClaims
    },
    claims: claimResults
  };
}
