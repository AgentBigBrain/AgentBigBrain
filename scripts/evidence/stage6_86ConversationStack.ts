/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.C conversation-stack checks and emits deterministic evidence.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import {
  applyUserTurnToConversationStackV1,
  buildConversationStackFromTurnsV1,
  createEmptyConversationStackV1,
  deriveTopicKeyCandidatesV1,
  migrateSessionConversationStackToV2
} from "../../src/core/stage6_86ConversationStack";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_conversation_stack_report.json"
);

interface Stage686CheckpointCArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.C";
  topicKeying: {
    deterministicCandidatesPass: boolean;
    primaryTopicKey: string | null;
  };
  threading: {
    switchPass: boolean;
    resumePass: boolean;
    ambiguitySuppressPass: boolean;
    missionPriorityPass: boolean;
    threadCount: number;
  };
  migration: {
    helperMigrationPass: boolean;
    sessionStoreMigrationPass: boolean;
  };
  passCriteria: {
    topicKeyingPass: boolean;
    threadingPass: boolean;
    migrationPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage686CheckpointC` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointC(): Promise<Stage686CheckpointCArtifact> {
  const observedAt = "2026-03-01T15:00:00.000Z";
  const candidateInput = "Please schedule sprint backlog planning next week.";
  const candidatesA = deriveTopicKeyCandidatesV1(candidateInput, observedAt);
  const candidatesB = deriveTopicKeyCandidatesV1(candidateInput, observedAt);
  const deterministicCandidatesPass = JSON.stringify(candidatesA) === JSON.stringify(candidatesB);
  const primaryTopicKey = candidatesA[0]?.topicKey ?? null;

  let stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's discuss sprint backlog priorities.",
        at: "2026-03-01T15:00:00.000Z"
      },
      {
        role: "user",
        text: "Switch to budget runway forecast assumptions.",
        at: "2026-03-01T15:01:00.000Z"
      }
    ],
    "2026-03-01T15:01:00.000Z"
  );
  const switchPass =
    Boolean(stack.activeThreadKey) &&
    (stack.threads.find((thread) => thread.threadKey === stack.activeThreadKey)?.topicKey.includes("budget") ??
      false);

  stack = applyUserTurnToConversationStackV1(stack, {
    role: "user",
    text: "Go back to sprint backlog and continue there.",
    at: "2026-03-01T15:02:00.000Z"
  });
  const resumePass =
    stack.threads.find((thread) => thread.threadKey === stack.activeThreadKey)?.topicKey.includes("sprint") ??
    false;

  const activeBeforeAmbiguity = stack.activeThreadKey;
  stack = applyUserTurnToConversationStackV1(stack, {
    role: "user",
    text: "Let's go back.",
    at: "2026-03-01T15:03:00.000Z"
  });
  const ambiguitySuppressPass = stack.activeThreadKey === activeBeforeAmbiguity;

  const missionSeed = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Investigate incident rollback timeline.",
        at: "2026-03-01T16:00:00.000Z"
      }
    ],
    "2026-03-01T16:00:00.000Z"
  );
  const missionThreadKey = missionSeed.activeThreadKey;
  const missionUpdated = applyUserTurnToConversationStackV1(
    missionSeed,
    {
      role: "user",
      text: "Also help me plan vacation logistics.",
      at: "2026-03-01T16:01:00.000Z"
    },
    {
      activeMissionThreadKey: missionThreadKey
    }
  );
  const missionPriorityPass =
    Boolean(missionThreadKey) && missionUpdated.activeThreadKey === missionThreadKey;

  const helperMigration = migrateSessionConversationStackToV2({
    sessionSchemaVersion: null,
    updatedAt: "2026-03-01T17:00:00.000Z",
    conversationTurns: [
      {
        role: "user",
        text: "Let's review launch checklist and timeline.",
        at: "2026-03-01T17:00:00.000Z"
      }
    ],
    conversationStack: createEmptyConversationStackV1("2026-03-01T16:59:00.000Z")
  });
  const helperMigrationPass =
    helperMigration.sessionSchemaVersion === "v2" &&
    helperMigration.conversationStack.threads.length >= 1;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage686-c-"));
  let sessionStoreMigrationPass = false;
  try {
    const sessionsPath = path.join(tempDir, "interface_sessions.json");
    await writeFile(
      sessionsPath,
      JSON.stringify({
        conversations: {
          "telegram:chat-1:user-1": {
            conversationId: "telegram:chat-1:user-1",
            userId: "user-1",
            username: "agentowner",
            conversationVisibility: "private",
            updatedAt: "2026-03-01T18:00:00.000Z",
            activeProposal: null,
            runningJobId: null,
            queuedJobs: [],
            recentJobs: [],
            conversationTurns: [
              {
                role: "user",
                text: "Let's continue release checklist prep.",
                at: "2026-03-01T18:00:00.000Z"
              }
            ],
            agentPulse: {
              optIn: false,
              mode: "private",
              routeStrategy: "last_private_used",
              lastPulseSentAt: null,
              lastPulseReason: null,
              lastPulseTargetConversationId: null,
              lastDecisionCode: "NOT_EVALUATED",
              lastEvaluatedAt: null
            }
          }
        }
      }),
      "utf8"
    );

    const store = new InterfaceSessionStore(sessionsPath);
    const migrated = await store.getSession("telegram:chat-1:user-1");
    sessionStoreMigrationPass =
      migrated?.sessionSchemaVersion === "v2" &&
      migrated?.conversationStack?.schemaVersion === "v1" &&
      (migrated?.conversationStack?.threads.length ?? 0) >= 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const topicKeyingPass = deterministicCandidatesPass && primaryTopicKey !== null;
  const threadingPass = switchPass && resumePass && ambiguitySuppressPass && missionPriorityPass;
  const migrationPass = helperMigrationPass && sessionStoreMigrationPass;
  const overallPass = topicKeyingPass && threadingPass && migrationPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:conversation_stack",
    checkpointId: "6.86.C",
    topicKeying: {
      deterministicCandidatesPass,
      primaryTopicKey
    },
    threading: {
      switchPass,
      resumePass,
      ambiguitySuppressPass,
      missionPriorityPass,
      threadCount: stack.threads.length
    },
    migration: {
      helperMigrationPass,
      sessionStoreMigrationPass
    },
    passCriteria: {
      topicKeyingPass,
      threadingPass,
      migrationPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointC();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.C artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
