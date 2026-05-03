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

class CountingProfileMemoryStore extends ProfileMemoryStore {
  loadCount = 0;

  override async load() {
    this.loadCount += 1;
    return super.load();
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
      "My work peer is Owen.",
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
      "Owen fell down and I never told you how it ended.",
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

    const planningContext = readSession.getPlanningContext(4, "who is Owen?");
    const planningFacts = readSession.queryFactsForPlanningContext(3, "who is Owen?");
    const episodePlanningContext = readSession.getEpisodePlanningContext(
      2,
      "How is Owen doing after the fall?",
      "2026-03-26T15:39:20.000Z"
    );
    const planningEpisodes = readSession.queryEpisodesForPlanningContext(
      2,
      "How is Owen doing after the fall?",
      "2026-03-26T15:39:20.000Z"
    );

    assert.equal(store.loadCount, 1);
    assert.match(planningContext, /contact\.owen\.name: Owen/i);
    assert.equal(
      planningFacts.some((fact) => fact.key.startsWith("contact.owen.")),
      true
    );
    assert.match(episodePlanningContext, /Owen fell down/i);
    assert.equal(planningEpisodes.some((episode) => /Owen fell down/i.test(episode.title)), true);
  });
});
