/**
 * @fileoverview Stage 6 autonomy-foundation utilities for proposal policy packs, sandbox validation, promotion gating, rollback drills, and memory-correlation traces.
 */

import { exec as execCallback } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { makeId } from "./ids";
import { SemanticLesson } from "./semanticMemory";
import { TaskRunResult } from "./types";

const exec = promisify(execCallback);
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PRIMARY_SKILL_EXTENSION = ".js";
const COMPATIBILITY_SKILL_EXTENSION = ".ts";
const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000;
const TRACE_MIN_CONCEPT_LENGTH = 4;
const TRACE_CONCEPT_STOP_WORDS = new Set([
  "this",
  "that",
  "from",
  "with",
  "were",
  "when",
  "what",
  "where",
  "which",
  "should",
  "would",
  "could",
  "have",
  "has",
  "will",
  "been",
  "always",
  "never",
  "into",
  "about"
]);

export type AutonomyProposalRiskLevel = "low" | "medium" | "high";

export interface AutonomyProposalPolicyPack {
  id: string;
  createdAt: string;
  proposedByAgentId: string;
  title: string;
  boundedScope: string;
  hypothesis: string;
  expectedMetric: string;
  riskLevel: AutonomyProposalRiskLevel;
  rollbackPlan: string;
}

export interface AutonomyProposalValidationResult {
  valid: boolean;
  violationCodes: string[];
}

export interface SandboxValidationResult {
  ok: boolean;
  command: string;
  output: string;
  enforcedRuntimeMode: "isolated";
  executedAt: string;
}

export interface GovernedPromotionDecision {
  approved: boolean;
  approvedActionIds: string[];
  blockedActionIds: string[];
  blockedBy: string[];
}

export interface ObjectiveRewardEvidence {
  approvedSafeActionCount: number;
  blockedActionCount: number;
  objectivePass: boolean;
  recommendedRewardPoints: number;
}

export interface MemoryCorrelationTrace {
  retrievedLessonIds: string[];
  linkedEdgeCount: number;
  influentialConcepts: string[];
}

interface AutonomyPromotionSnapshot {
  proposalId: string;
  skillName: string;
  skillPath: string;
  previousContent: string | null;
  promotedContent: string;
  status: "prepared" | "promoted" | "rolled_back";
  preparedAt: string;
  promotedAt: string | null;
  rolledBackAt: string | null;
}

interface SandboxValidationOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Normalizes text field into a stable shape for `autonomyFoundation` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for text field so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeTextField(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

/**
 * Normalizes risk level into a stable shape for `autonomyFoundation` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for risk level so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `AutonomyProposalRiskLevel | null` result.
 */
function normalizeRiskLevel(value: unknown): AutonomyProposalRiskLevel | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return null;
}

/**
 * Converts values into sorted unique form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for sorted unique deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Ordered collection produced by this step.
 */
function toSortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Evaluates safe skill name and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the safe skill name policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param skillName - Value for skill name.
 * @returns `true` when this check passes.
 */
function isSafeSkillName(skillName: string): boolean {
  return SKILL_NAME_PATTERN.test(skillName);
}

/**
 * Reads optional file needed for this execution step.
 *
 * **Why it exists:**
 * Separates optional file read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
 *
 * @param filePath - Filesystem location used by this operation.
 * @returns Promise resolving to string | null.
 */
async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Evaluates file exists and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps compatibility fallback logic explicit for promotion drills during skill artifact migration.
 *
 * **What it talks to:**
 * - Uses `access` (import `access`) from `node:fs/promises`.
 *
 * @param filePath - Filesystem location used by this operation.
 * @returns Promise resolving to `true` when this check passes.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives trace concepts from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for trace concepts in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function extractTraceConcepts(value: string): string[] {
  const tokens = value
    .split(/[^a-zA-Z0-9_]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= TRACE_MIN_CONCEPT_LENGTH)
    .filter((token) => !TRACE_CONCEPT_STOP_WORDS.has(token));

  return [...new Set(tokens)];
}

/**
 * Normalizes ordering and duplication for concept weight entries.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for concept weight entries in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Value for left.
 * @param right - Value for right.
 * @returns Computed numeric value.
 */
function sortConceptWeightEntries(left: [string, number], right: [string, number]): number {
  if (left[1] === right[1]) {
    return left[0].localeCompare(right[0]);
  }
  return right[1] - left[1];
}

/**
 * Builds autonomy proposal policy pack for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of autonomy proposal policy pack consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `makeId` (import `makeId`) from `./ids`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `AutonomyProposalPolicyPack` result.
 */
export function createAutonomyProposalPolicyPack(input: {
  proposedByAgentId: string;
  title: string;
  boundedScope: string;
  hypothesis: string;
  expectedMetric: string;
  riskLevel: AutonomyProposalRiskLevel;
  rollbackPlan: string;
  id?: string;
  createdAt?: string;
}): AutonomyProposalPolicyPack {
  return {
    id: normalizeTextField(input.id) || makeId("autonomy_proposal"),
    createdAt: normalizeTextField(input.createdAt) || new Date().toISOString(),
    proposedByAgentId: normalizeTextField(input.proposedByAgentId) || "stella",
    title: normalizeTextField(input.title),
    boundedScope: normalizeTextField(input.boundedScope),
    hypothesis: normalizeTextField(input.hypothesis),
    expectedMetric: normalizeTextField(input.expectedMetric),
    riskLevel: input.riskLevel,
    rollbackPlan: normalizeTextField(input.rollbackPlan)
  };
}

/**
 * Applies deterministic validity checks for autonomy proposal policy pack.
 *
 * **Why it exists:**
 * Fails fast when autonomy proposal policy pack is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param proposal - Value for proposal.
 * @returns Computed `AutonomyProposalValidationResult` result.
 */
export function validateAutonomyProposalPolicyPack(
  proposal: AutonomyProposalPolicyPack
): AutonomyProposalValidationResult {
  const violationCodes: string[] = [];

  if (proposal.title.length < 4 || proposal.title.length > 120) {
    violationCodes.push("PROPOSAL_TITLE_BOUNDS_INVALID");
  }
  if (proposal.boundedScope.length < 8 || proposal.boundedScope.length > 280) {
    violationCodes.push("PROPOSAL_SCOPE_BOUNDS_INVALID");
  }
  if (proposal.hypothesis.length < 12 || proposal.hypothesis.length > 600) {
    violationCodes.push("PROPOSAL_HYPOTHESIS_BOUNDS_INVALID");
  }
  if (proposal.expectedMetric.length < 8 || proposal.expectedMetric.length > 280) {
    violationCodes.push("PROPOSAL_METRIC_BOUNDS_INVALID");
  }
  if (proposal.rollbackPlan.length < 8 || proposal.rollbackPlan.length > 600) {
    violationCodes.push("PROPOSAL_ROLLBACK_BOUNDS_INVALID");
  }
  if (!normalizeRiskLevel(proposal.riskLevel)) {
    violationCodes.push("PROPOSAL_RISK_LEVEL_INVALID");
  }
  if (!proposal.proposedByAgentId) {
    violationCodes.push("PROPOSAL_AGENT_ID_REQUIRED");
  }

  return {
    valid: violationCodes.length === 0,
    violationCodes: toSortedUnique(violationCodes)
  };
}

/**
 * Executes sandbox validation cycle as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the sandbox validation cycle runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param command - Value for command.
 * @param options - Optional tuning knobs for this operation.
 * @returns Promise resolving to SandboxValidationResult.
 */
export async function runSandboxValidationCycle(
  command: string,
  options: SandboxValidationOptions = {}
): Promise<SandboxValidationResult> {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
    BRAIN_RUNTIME_MODE: "isolated",
    BRAIN_ALLOW_FULL_ACCESS: "false",
    BRAIN_ENABLE_REAL_SHELL: "false",
    BRAIN_ENABLE_REAL_NETWORK_WRITE: "false"
  };

  const executedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await exec(command, {
      cwd: options.cwd ?? process.cwd(),
      timeout: options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      env: mergedEnv
    });
    return {
      ok: true,
      command,
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
      enforcedRuntimeMode: "isolated",
      executedAt
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      command,
      output: [err.stdout ?? "", err.stderr ?? "", err.message].filter(Boolean).join("\n").trim(),
      enforcedRuntimeMode: "isolated",
      executedAt
    };
  }
}

/**
 * Evaluates governed promotion candidate and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the governed promotion candidate policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @returns Computed `GovernedPromotionDecision` result.
 */
export function evaluateGovernedPromotionCandidate(
  runResult: TaskRunResult
): GovernedPromotionDecision {
  const createSkillResults = runResult.actionResults.filter(
    (result) => result.action.type === "create_skill"
  );
  const approvedActionIds = createSkillResults
    .filter(
      (result) =>
        result.approved &&
        result.violations.length === 0 &&
        result.votes.length > 0
    )
    .map((result) => result.action.id);
  const blockedResults = createSkillResults.filter((result) => !result.approved);
  const blockedActionIds = blockedResults.map((result) => result.action.id);
  const blockedBy = toSortedUnique(blockedResults.flatMap((result) => [...result.blockedBy]));

  return {
    approved: approvedActionIds.length > 0 && blockedActionIds.length === 0,
    approvedActionIds,
    blockedActionIds,
    blockedBy
  };
}

/**
 * Derives objective reward evidence from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for objective reward evidence in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @returns Computed `ObjectiveRewardEvidence` result.
 */
export function deriveObjectiveRewardEvidence(runResult: TaskRunResult): ObjectiveRewardEvidence {
  const approvedSafeActionCount = runResult.actionResults.filter(
    (result) => result.approved && result.violations.length === 0
  ).length;
  const blockedActionCount = runResult.actionResults.filter((result) => !result.approved).length;
  const recommendedRewardPoints = Math.max(0, approvedSafeActionCount - blockedActionCount);

  return {
    approvedSafeActionCount,
    blockedActionCount,
    objectivePass: approvedSafeActionCount > 0 && blockedActionCount === 0,
    recommendedRewardPoints
  };
}

/**
 * Builds memory correlation trace for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of memory correlation trace consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `SemanticLesson` (import `SemanticLesson`) from `./semanticMemory`.
 *
 * @param relevantLessons - Value for relevant lessons.
 * @param query - Value for query.
 * @returns Computed `MemoryCorrelationTrace` result.
 */
export function buildMemoryCorrelationTrace(
  relevantLessons: SemanticLesson[],
  query?: string
): MemoryCorrelationTrace {
  const retrievedLessonIds = relevantLessons.map((lesson) => lesson.id);
  const retrievedSet = new Set(retrievedLessonIds);

  let linkedEdgeCount = 0;
  const conceptWeights = new Map<string, number>();
  for (const lesson of relevantLessons) {
    for (const relatedLessonId of lesson.relatedLessonIds) {
      if (retrievedSet.has(relatedLessonId)) {
        linkedEdgeCount += 1;
      }
    }
    for (const concept of lesson.concepts) {
      conceptWeights.set(concept, (conceptWeights.get(concept) ?? 0) + 1);
    }
  }

  const sortedConcepts = [...conceptWeights.entries()].sort(sortConceptWeightEntries);
  let prioritizedConcepts = sortedConcepts;
  if (query && query.trim().length > 0) {
    const queryConcepts = new Set(extractTraceConcepts(query));
    const overlapConcepts = sortedConcepts.filter(([concept]) => queryConcepts.has(concept));
    const nonOverlapConcepts = sortedConcepts.filter(([concept]) => !queryConcepts.has(concept));
    prioritizedConcepts = [...overlapConcepts, ...nonOverlapConcepts];
  }

  const influentialConcepts = prioritizedConcepts
    .slice(0, 8)
    .map((entry) => entry[0]);

  return {
    retrievedLessonIds,
    linkedEdgeCount,
    influentialConcepts
  };
}

export class AutonomyPromotionDrill {
  /**
   * Initializes `AutonomyPromotionDrill` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param snapshotPath - Filesystem location used by this operation.
   * @param skillsRootPath - Filesystem location used by this operation.
   */
  constructor(
    private readonly snapshotPath = path.resolve(
      process.cwd(),
      "runtime/evidence/stage6_promotion_drill.json"
    ),
    private readonly skillsRootPath = path.resolve(process.cwd(), "runtime/skills")
  ) {}

  /**
   * Resolves skill path from available runtime context.
   *
   * **Why it exists:**
   * Prevents divergent selection of skill path by keeping rules in one function.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param skillName - Value for skill name.
   * @returns Resulting string value.
   */
  private resolveSkillPath(skillName: string): string {
    if (!isSafeSkillName(skillName)) {
      throw new Error("Skill name is invalid for promotion drill.");
    }

    const primaryPath = path.resolve(
      path.join(this.skillsRootPath, `${skillName}${PRIMARY_SKILL_EXTENSION}`)
    );
    const compatibilityPath = path.resolve(
      path.join(this.skillsRootPath, `${skillName}${COMPATIBILITY_SKILL_EXTENSION}`)
    );
    if (
      !primaryPath.startsWith(this.skillsRootPath) ||
      !compatibilityPath.startsWith(this.skillsRootPath)
    ) {
      throw new Error("Skill path escaped promotion skills root.");
    }
    return primaryPath;
  }

  /**
   * Resolves skill path from available runtime context.
   *
   * **Why it exists:**
   * Applies deterministic `.js` primary with `.ts` compatibility fallback for promotion snapshots.
   *
   * **What it talks to:**
   * - Uses `fileExists` in this module.
   *
   * @param skillName - Value for skill name.
   * @returns Promise resolving to string.
   */
  private async resolveSkillPathForSnapshot(skillName: string): Promise<string> {
    const primaryPath = this.resolveSkillPath(skillName);
    if (await fileExists(primaryPath)) {
      return primaryPath;
    }
    const compatibilityPath = path.resolve(
      path.join(this.skillsRootPath, `${skillName}${COMPATIBILITY_SKILL_EXTENSION}`)
    );
    if (await fileExists(compatibilityPath)) {
      return compatibilityPath;
    }
    return primaryPath;
  }

  /**
   * Persists snapshot with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes snapshot mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param snapshot - Value for snapshot.
   * @returns Promise resolving to void.
   */
  private async saveSnapshot(snapshot: AutonomyPromotionSnapshot): Promise<void> {
    await mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await writeFile(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  /**
   * Reads snapshot needed for this execution step.
   *
   * **Why it exists:**
   * Separates snapshot read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to AutonomyPromotionSnapshot | null.
   */
  private async loadSnapshot(): Promise<AutonomyPromotionSnapshot | null> {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      return JSON.parse(raw) as AutonomyPromotionSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Builds skill promotion for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of skill promotion consistent across call sites.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param proposalId - Stable identifier used to reference an entity or record.
   * @param skillName - Value for skill name.
   * @param promotedContent - Value for promoted content.
   * @returns Promise resolving to void.
   */
  async prepareSkillPromotion(
    proposalId: string,
    skillName: string,
    promotedContent: string
  ): Promise<void> {
    const normalizedProposalId = normalizeTextField(proposalId);
    if (!normalizedProposalId) {
      throw new Error("Proposal ID is required for promotion drill.");
    }
    const skillPath = await this.resolveSkillPathForSnapshot(skillName);
    const previousContent = await readOptionalFile(skillPath);

    const snapshot: AutonomyPromotionSnapshot = {
      proposalId: normalizedProposalId,
      skillName,
      skillPath,
      previousContent,
      promotedContent,
      status: "prepared",
      preparedAt: new Date().toISOString(),
      promotedAt: null,
      rolledBackAt: null
    };
    await this.saveSnapshot(snapshot);
  }

  /**
   * Executes promotion as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the promotion runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   * @returns Promise resolving to void.
   */
  async applyPromotion(): Promise<void> {
    const snapshot = await this.loadSnapshot();
    if (!snapshot) {
      throw new Error("No promotion snapshot found.");
    }
    if (snapshot.status !== "prepared") {
      throw new Error("Promotion snapshot is not in prepared state.");
    }

    await mkdir(path.dirname(snapshot.skillPath), { recursive: true });
    await writeFile(snapshot.skillPath, snapshot.promotedContent, "utf8");
    snapshot.status = "promoted";
    snapshot.promotedAt = new Date().toISOString();
    await this.saveSnapshot(snapshot);
  }

  /**
   * Implements rollback promotion behavior used by `autonomyFoundation`.
   *
   * **Why it exists:**
   * Keeps `rollback promotion` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `rm` (import `rm`) from `node:fs/promises`.
   * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   * @returns Promise resolving to void.
   */
  async rollbackPromotion(): Promise<void> {
    const snapshot = await this.loadSnapshot();
    if (!snapshot) {
      throw new Error("No promotion snapshot found.");
    }
    if (snapshot.status !== "promoted") {
      throw new Error("Rollback requires a promoted snapshot.");
    }

    if (snapshot.previousContent === null) {
      await rm(snapshot.skillPath, { force: true });
    } else {
      await mkdir(path.dirname(snapshot.skillPath), { recursive: true });
      await writeFile(snapshot.skillPath, snapshot.previousContent, "utf8");
    }

    snapshot.status = "rolled_back";
    snapshot.rolledBackAt = new Date().toISOString();
    await this.saveSnapshot(snapshot);
  }

  /**
   * Reads snapshot needed for this execution step.
   *
   * **Why it exists:**
   * Separates snapshot read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to {
    proposalId: string;
    skillName: string;
    status: "prepared" | "promoted" | "rolled_back";
  } | null.
   */
  async readSnapshot(): Promise<{
    proposalId: string;
    skillName: string;
    status: "prepared" | "promoted" | "rolled_back";
  } | null> {
    const snapshot = await this.loadSnapshot();
    if (!snapshot) {
      return null;
    }

    return {
      proposalId: snapshot.proposalId,
      skillName: snapshot.skillName,
      status: snapshot.status
    };
  }
}
