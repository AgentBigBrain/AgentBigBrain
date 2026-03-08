/**
 * @fileoverview Canonical Stage 6.85 seed-playbook helpers for deterministic registry and selection baselines.
 */

import {
  compileCandidatePlaybookFromTrace,
  type PlaybookSelectionSignal
} from "./playbookPolicy";
import { type PlaybookV1 } from "../types";

export interface Stage685SeedPlaybookSet {
  build: PlaybookV1;
  research: PlaybookV1;
  all: readonly PlaybookV1[];
}

/**
 * Compiles the deterministic Stage 6.85 seed playbook set used by registry and selection tests.
 *
 * @returns Stable build/research seed playbooks and their aggregate list.
 */
export function compileStage685SeedPlaybooks(): Stage685SeedPlaybookSet {
  const build = compileCandidatePlaybookFromTrace({
    traceId: "stage685_a_build",
    goal: "Build deterministic backup CLI",
    intentTags: ["build", "cli", "verify"],
    inputSchema: "build_cli_v1",
    steps: [
      {
        actionFamily: "build",
        operation: "compile",
        succeeded: true,
        durationMs: 2_200,
        denyCount: 0,
        verificationPassed: true
      },
      {
        actionFamily: "verification",
        operation: "test",
        succeeded: true,
        durationMs: 4_400,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });

  const research = compileCandidatePlaybookFromTrace({
    traceId: "stage685_a_research",
    goal: "Research deterministic sandboxing controls",
    intentTags: ["research", "security"],
    inputSchema: "research_v1",
    steps: [
      {
        actionFamily: "research",
        operation: "summarize",
        succeeded: true,
        durationMs: 6_200,
        denyCount: 1,
        verificationPassed: false
      }
    ]
  });

  return {
    build,
    research,
    all: [build, research]
  };
}

/**
 * Builds deterministic historical selection signals for the Stage 6.85 seed playbooks.
 *
 * @param seedPlaybooks - Canonical build/research seed set.
 * @returns Stable historical selection signals keyed by playbook id.
 */
export function buildStage685SeedSignals(
  seedPlaybooks: Stage685SeedPlaybookSet
): readonly PlaybookSelectionSignal[] {
  return [
    {
      playbookId: seedPlaybooks.build.id,
      passCount: 12,
      failCount: 1,
      lastSuccessAt: "2026-02-27T00:00:00.000Z",
      averageDenyRate: 0.02,
      averageTimeToCompleteMs: 15_000,
      verificationPassRate: 0.98
    },
    {
      playbookId: seedPlaybooks.research.id,
      passCount: 2,
      failCount: 5,
      lastSuccessAt: "2026-01-20T00:00:00.000Z",
      averageDenyRate: 0.35,
      averageTimeToCompleteMs: 80_000,
      verificationPassRate: 0.45
    }
  ];
}
