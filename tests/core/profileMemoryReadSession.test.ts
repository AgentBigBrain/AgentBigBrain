/**
 * @fileoverview Tests request-scoped profile-memory read-session reuse over one reconciled snapshot.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { buildProfileMemoryIngestPolicy } from "../../src/core/profileMemoryRuntime/profileMemoryIngestPolicy";
import { buildTestOwnerTaskPrincipalAccess } from "../helpers/principalAccess";

const TEST_OWNER_PRINCIPAL_ACCESS = buildTestOwnerTaskPrincipalAccess();

class CountingProfileMemoryStore extends ProfileMemoryStore {
  loadCount = 0;

  override async load() {
    this.loadCount += 1;
    return super.load();
  }

  override async ingestFromTaskInput(
    ...args: Parameters<ProfileMemoryStore["ingestFromTaskInput"]>
  ): ReturnType<ProfileMemoryStore["ingestFromTaskInput"]> {
    const [taskId, userInput, observedAt, options] = args;
    return super.ingestFromTaskInput(taskId, userInput, observedAt, {
      ...(options ?? {}),
      principalAccess: options?.principalAccess ?? TEST_OWNER_PRINCIPAL_ACCESS,
      requestedSubjectKind: options?.requestedSubjectKind ?? "owner_profile"
    });
  }
}

async function withCountingProfileStore(
  callback: (store: CountingProfileMemoryStore) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-profile-read-session-"));
  const filePath = path.join(tempDir, "profile_memory.secure.json");
  const store = new CountingProfileMemoryStore(filePath, Buffer.alloc(32, 17), 90);

  try {
    await callback(store);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("profile memory read session reuses one reconciled snapshot across planning reads", async () => {
  await withCountingProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_read_session_fact",
      "My work peer is Riley.",
      "2026-03-26T15:39:00.000Z",
      {
        ingestPolicy: buildProfileMemoryIngestPolicy({
          memoryIntent: "profile_update",
          sourceSurface: "conversation_profile_input"
        })
      }
    );
    await store.ingestFromTaskInput(
      "task_profile_read_session_episode",
      "Riley fell down and I never told you how it ended.",
      "2026-03-26T15:39:10.000Z",
      {
        ingestPolicy: buildProfileMemoryIngestPolicy({
          memoryIntent: "profile_update",
          sourceSurface: "conversation_profile_input"
        })
      }
    );

    store.loadCount = 0;
    const readSession = await store.openReadSession();

    const planningContext = readSession.getPlanningContext(4, "who is Riley?");
    const planningFacts = readSession.queryFactsForPlanningContext(3, "who is Riley?");
    const episodePlanningContext = readSession.getEpisodePlanningContext(
      2,
      "How is Riley doing after the fall?",
      "2026-03-26T15:39:20.000Z"
    );
    const planningEpisodes = readSession.queryEpisodesForPlanningContext(
      2,
      "How is Riley doing after the fall?",
      "2026-03-26T15:39:20.000Z"
    );

    assert.equal(store.loadCount, 1);
    assert.match(planningContext, /contact\.riley\.name: Riley/i);
    assert.equal(
      planningFacts.some((fact) => fact.key.startsWith("contact.riley.")),
      true
    );
    assert.match(episodePlanningContext, /Riley fell down/i);
    assert.equal(planningEpisodes.some((episode) => /Riley fell down/i.test(episode.title)), true);
  });
});
