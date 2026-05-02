/**
 * @fileoverview Shared fixture and evidence helpers for the Telegram completion matrix smoke.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type CompletionMatrixScenarioFamily =
  | "static_site"
  | "followup_edit"
  | "memory_recall"
  | "document_attachment"
  | "skill_lifecycle"
  | "blocked_or_clarify";

export type CompletionMatrixControl = "positive" | "negative";
export type CompletionMatrixStatus = "PASS" | "FAIL" | "BLOCKED";

export interface CompletionMatrixScenario {
  id: string;
  family: CompletionMatrixScenarioFamily;
  control: CompletionMatrixControl;
  prompt: string;
  expectedRoute: string;
  expectedStatus: CompletionMatrixStatus;
  expectedSideEffects: readonly string[];
  expectedProofs: readonly string[];
}

export interface CompletionMatrixScenarioResult {
  id: string;
  prompt: string;
  family: CompletionMatrixScenarioFamily;
  control: CompletionMatrixControl;
  expectedRoute: string;
  observedRoute: string | null;
  expectedSideEffects: readonly string[];
  observedSideEffects: Record<string, boolean>;
  artifactPaths: readonly string[];
  browserProof: Record<string, unknown> | null;
  memoryProof: Record<string, unknown> | null;
  skillProof: Record<string, unknown> | null;
  selectedGuidanceProof: Record<string, unknown> | null;
  mediaProof: Record<string, unknown> | null;
  blockerReason: string | null;
  status: CompletionMatrixStatus;
  redactionStatus: "review_safe" | "unsafe";
}

export interface CompletionMatrixEvidence {
  generatedAt: string;
  command: string;
  mode: "schema_only" | "live" | "blocked";
  status: CompletionMatrixStatus;
  redactionStatus: "review_safe" | "unsafe";
  blockerReason: string | null;
  summary: {
    scenarioCount: number;
    passedScenarios: number;
    failedScenarios: number;
    blockedScenarios: number;
  };
  results: readonly CompletionMatrixScenarioResult[];
}

export const TELEGRAM_COMPLETION_MATRIX_COMMAND =
  "npx tsx scripts/evidence/telegramCompletionMatrixLiveSmoke.ts";
export const TELEGRAM_COMPLETION_MATRIX_CONFIRM_ENV =
  "BRAIN_TELEGRAM_COMPLETION_MATRIX_LIVE_CONFIRM";
export const TELEGRAM_COMPLETION_MATRIX_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/telegram_completion_matrix_live_smoke_report.json"
);
export const TELEGRAM_COMPLETION_MATRIX_SCENARIO_FIXTURE_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/telegramCompletionMatrixScenarios.json"
);

const REQUIRED_FAMILIES: readonly CompletionMatrixScenarioFamily[] = [
  "static_site",
  "followup_edit",
  "memory_recall",
  "document_attachment",
  "skill_lifecycle",
  "blocked_or_clarify"
] as const;
const PRIVATE_PATH_PATTERN =
  /\b(?:[A-Za-z]:(?:\\{1,2})Users(?:\\{1,2})(?!testuser(?:\\{1,2})|redacted(?:\\{1,2}))[^\\\s"']+|\/home\/runner\/work\/[^\s"']+)/i;
const PRIVATE_IDENTIFIER_PATTERN = /\b(?:\d{9}|\d{2}-\d{7})\b/;

/**
 * Parses a boolean-like environment string.
 *
 * @param value - Raw environment value.
 * @returns `true` when the value explicitly opts in.
 */
export function parseMatrixBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Loads and validates the source-controlled matrix scenario fixture.
 *
 * @returns Parsed scenario list.
 */
export async function loadCompletionMatrixScenarios(): Promise<readonly CompletionMatrixScenario[]> {
  const raw = await readFile(TELEGRAM_COMPLETION_MATRIX_SCENARIO_FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const scenarios = parseCompletionMatrixScenarios(parsed);
  validateCompletionMatrixScenarios(scenarios);
  return scenarios;
}

/**
 * Parses raw fixture JSON into matrix scenario records.
 *
 * @param input - Raw JSON value.
 * @returns Parsed scenario list.
 */
export function parseCompletionMatrixScenarios(input: unknown): readonly CompletionMatrixScenario[] {
  if (!Array.isArray(input)) {
    throw new Error("Telegram completion matrix fixture must be an array.");
  }
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Scenario at index ${index} must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    const scenario: CompletionMatrixScenario = {
      id: readRequiredString(candidate.id, `scenario[${index}].id`),
      family: readFamily(candidate.family, `scenario[${index}].family`),
      control: readControl(candidate.control, `scenario[${index}].control`),
      prompt: readRequiredString(candidate.prompt, `scenario[${index}].prompt`),
      expectedRoute: readRequiredString(candidate.expectedRoute, `scenario[${index}].expectedRoute`),
      expectedStatus: readStatus(candidate.expectedStatus, `scenario[${index}].expectedStatus`),
      expectedSideEffects: readStringArray(
        candidate.expectedSideEffects,
        `scenario[${index}].expectedSideEffects`
      ),
      expectedProofs: readStringArray(candidate.expectedProofs, `scenario[${index}].expectedProofs`)
    };
    if (scenario.expectedProofs.length === 0) {
      throw new Error(`${scenario.id} must define at least one proof expectation.`);
    }
    return scenario;
  });
}

/**
 * Validates family/control coverage and sensitive-safe fixture text.
 *
 * @param scenarios - Parsed scenarios to validate.
 */
export function validateCompletionMatrixScenarios(
  scenarios: readonly CompletionMatrixScenario[]
): void {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate Telegram completion matrix scenario id: ${scenario.id}`);
    }
    ids.add(scenario.id);
    assertReviewSafeText(scenario.prompt, `scenario ${scenario.id} prompt`);
  }
  for (const family of REQUIRED_FAMILIES) {
    const controls = new Set(
      scenarios.filter((scenario) => scenario.family === family).map((scenario) => scenario.control)
    );
    if (!controls.has("positive") || !controls.has("negative")) {
      throw new Error(`Scenario family ${family} must include positive and negative controls.`);
    }
  }
}

/**
 * Creates a schema-only artifact proving the fixture and evidence shape without side effects.
 *
 * @param scenarios - Scenario list to render.
 * @returns Review-safe PASS artifact for contract validation only.
 */
export function buildSchemaOnlyCompletionMatrixEvidence(
  scenarios: readonly CompletionMatrixScenario[]
): CompletionMatrixEvidence {
  return buildCompletionMatrixEvidence(
    "schema_only",
    scenarios.map((scenario) => buildSchemaOnlyScenarioResult(scenario))
  );
}

/**
 * Creates a blocked artifact for unavailable live dependencies.
 *
 * @param scenarios - Scenario list to render.
 * @param blockerReason - Human-readable blocker reason.
 * @returns Review-safe BLOCKED artifact.
 */
export function buildBlockedCompletionMatrixEvidence(
  scenarios: readonly CompletionMatrixScenario[],
  blockerReason: string
): CompletionMatrixEvidence {
  return buildCompletionMatrixEvidence(
    "blocked",
    scenarios.map((scenario) => ({
      ...buildEmptyScenarioResult(scenario),
      blockerReason,
      status: "BLOCKED"
    }))
  );
}

/**
 * Writes one matrix artifact through the review-safe schema validator.
 *
 * @param artifact - Artifact to persist.
 */
export async function writeCompletionMatrixEvidence(
  artifact: CompletionMatrixEvidence
): Promise<void> {
  validateCompletionMatrixEvidence(artifact);
  await mkdir(path.dirname(TELEGRAM_COMPLETION_MATRIX_ARTIFACT_PATH), { recursive: true });
  await writeFile(
    TELEGRAM_COMPLETION_MATRIX_ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Validates the review-safe evidence contract.
 *
 * @param artifact - Candidate artifact.
 */
export function validateCompletionMatrixEvidence(artifact: CompletionMatrixEvidence): void {
  const serialized = JSON.stringify(artifact);
  assertReviewSafeText(serialized, "Telegram completion matrix evidence");
  if (artifact.redactionStatus !== "review_safe") {
    throw new Error("Telegram completion matrix evidence must be review_safe.");
  }
  if (artifact.summary.scenarioCount !== artifact.results.length) {
    throw new Error("Telegram completion matrix summary count does not match results.");
  }
  for (const result of artifact.results) {
    if (result.redactionStatus !== "review_safe") {
      throw new Error(`Scenario ${result.id} is not review_safe.`);
    }
    if (!result.blockerReason && result.status === "BLOCKED") {
      throw new Error(`Scenario ${result.id} is BLOCKED without a blockerReason.`);
    }
  }
}

/**
 * Redacts sensitive absolute local paths before writing review evidence.
 *
 * @param value - Text to redact.
 * @returns Redacted text.
 */
export function redactCompletionMatrixText(value: string): string {
  return value
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, "[redacted-local-user]")
    .replace(/\/home\/runner\/work\/[^\s"']+/g, "[redacted-ci-workspace]");
}

/**
 * Builds the final artifact and top-level summary from scenario results.
 *
 * @param mode - Execution mode.
 * @param results - Scenario results.
 * @returns Matrix evidence artifact.
 */
export function buildCompletionMatrixEvidence(
  mode: CompletionMatrixEvidence["mode"],
  results: readonly CompletionMatrixScenarioResult[]
): CompletionMatrixEvidence {
  const passedScenarios = results.filter((result) => result.status === "PASS").length;
  const failedScenarios = results.filter((result) => result.status === "FAIL").length;
  const blockedScenarios = results.filter((result) => result.status === "BLOCKED").length;
  const status: CompletionMatrixStatus =
    failedScenarios > 0 ? "FAIL" : blockedScenarios > 0 && passedScenarios === 0 ? "BLOCKED" : "PASS";
  return {
    generatedAt: new Date().toISOString(),
    command: TELEGRAM_COMPLETION_MATRIX_COMMAND,
    mode,
    status,
    redactionStatus: "review_safe",
    blockerReason:
      status === "BLOCKED" ? results.find((result) => result.blockerReason)?.blockerReason ?? null : null,
    summary: {
      scenarioCount: results.length,
      passedScenarios,
      failedScenarios,
      blockedScenarios
    },
    results
  };
}

/**
 * Builds a matrix result from an executed scenario.
 *
 * @param scenario - Scenario definition.
 * @param update - Observed result fields.
 * @returns Review-safe scenario result.
 */
export function buildCompletionMatrixScenarioResult(
  scenario: CompletionMatrixScenario,
  update: Partial<CompletionMatrixScenarioResult>
): CompletionMatrixScenarioResult {
  return {
    ...buildEmptyScenarioResult(scenario),
    ...update,
    artifactPaths: (update.artifactPaths ?? []).map(redactCompletionMatrixText),
    redactionStatus: "review_safe"
  };
}

function buildSchemaOnlyScenarioResult(
  scenario: CompletionMatrixScenario
): CompletionMatrixScenarioResult {
  return {
    ...buildEmptyScenarioResult(scenario),
    observedRoute: scenario.expectedRoute,
    observedSideEffects: Object.fromEntries(
      scenario.expectedSideEffects.map((sideEffect) => [sideEffect, true])
    ),
    blockerReason: "schema_only_no_live_execution",
    status: "PASS"
  };
}

function buildEmptyScenarioResult(
  scenario: CompletionMatrixScenario
): CompletionMatrixScenarioResult {
  return {
    id: scenario.id,
    prompt: scenario.prompt,
    family: scenario.family,
    control: scenario.control,
    expectedRoute: scenario.expectedRoute,
    observedRoute: null,
    expectedSideEffects: scenario.expectedSideEffects,
    observedSideEffects: {},
    artifactPaths: [],
    browserProof: null,
    memoryProof: null,
    skillProof: null,
    selectedGuidanceProof: null,
    mediaProof: null,
    blockerReason: null,
    status: "BLOCKED",
    redactionStatus: "review_safe"
  };
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function readStringArray(value: unknown, fieldName: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
  return value.map((entry, index) => readRequiredString(entry, `${fieldName}[${index}]`));
}

function readFamily(value: unknown, fieldName: string): CompletionMatrixScenarioFamily {
  const normalized = readRequiredString(value, fieldName);
  if (!REQUIRED_FAMILIES.includes(normalized as CompletionMatrixScenarioFamily)) {
    throw new Error(`${fieldName} has unsupported family: ${normalized}`);
  }
  return normalized as CompletionMatrixScenarioFamily;
}

function readControl(value: unknown, fieldName: string): CompletionMatrixControl {
  const normalized = readRequiredString(value, fieldName);
  if (normalized !== "positive" && normalized !== "negative") {
    throw new Error(`${fieldName} must be positive or negative.`);
  }
  return normalized;
}

function readStatus(value: unknown, fieldName: string): CompletionMatrixStatus {
  const normalized = readRequiredString(value, fieldName);
  if (normalized !== "PASS" && normalized !== "FAIL" && normalized !== "BLOCKED") {
    throw new Error(`${fieldName} must be PASS, FAIL, or BLOCKED.`);
  }
  return normalized;
}

function assertReviewSafeText(value: string, label: string): void {
  if (PRIVATE_PATH_PATTERN.test(value)) {
    throw new Error(`${label} contains an unredacted local path.`);
  }
  if (PRIVATE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} contains an unredacted identifier-shaped number.`);
  }
}
