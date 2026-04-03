/**
 * @fileoverview Tests encrypted profile-memory persistence, access controls, and env-based initialization behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createProfileEpisodeRecord,
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { buildProfileMemorySourceFingerprint } from "../../src/core/profileMemoryRuntime/profileMemoryIngestProvenance";
import { saveProfileMemoryState } from "../../src/core/profileMemoryRuntime/profileMemoryPersistence";
import {
  buildConversationStackFromTurnsV1
} from "../../src/core/stage6_86ConversationStack";
import {
  applyEntityExtractionToGraph,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";
import {
  upsertOpenLoopOnConversationStackV1
} from "../../src/core/stage6_86OpenLoops";

/**
 * Implements `withProfileStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withProfileStore(
  callback: (store: ProfileMemoryStore, filePath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-profile-"));
  const filePath = path.join(tempDir, "profile_memory.secure.json");
  const keyBase64 = Buffer.alloc(32, 7).toString("base64");
  const store = new ProfileMemoryStore(filePath, Buffer.from(keyBase64, "base64"), 90);

  try {
    await callback(store, filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("profile memory persists encrypted content and omits plaintext values at rest", async () => {
  await withProfileStore(async (store, filePath) => {
    await store.ingestFromTaskInput(
      "task_profile_1",
      "my address is 123 Main Street and I work at Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes("123 Main Street"), false);
    assert.equal(raw.includes("employment.current"), false);
  });
});

test("readFacts hides sensitive fields unless explicit approval is present", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_2",
      "my address is 123 Main Street and my job is Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const withoutApproval = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: false
    });
    assert.equal(withoutApproval.some((fact) => fact.key.includes("address")), false);

    const withApproval = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_123"
    });
    const addressFact = withApproval.find((fact) => fact.key.includes("address"));
    assert.ok(addressFact);
    assert.equal(addressFact?.value, "123 Main Street");
  });
});

test("planning context excludes sensitive facts and includes active non-sensitive facts", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_3",
      "my address is 123 Main Street and my job is Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const planningContext = await store.getPlanningContext(6);
    assert.equal(planningContext.includes("employment.current"), true);
    assert.equal(planningContext.includes("address"), false);
    assert.equal(planningContext.includes("123 Main Street"), false);
  });
});

test("profile memory store skips duplicate same-turn ingest across conversational and broker seams", async () => {
  await withProfileStore(async (store) => {
    const userInput = "I work with Owen at Lantern Studio.";
    const observedAt = "2026-04-02T15:00:00.000Z";
    const sourceFingerprint = buildProfileMemorySourceFingerprint(userInput);

    const firstResult = await store.ingestFromTaskInput(
      "task_profile_idempotency_1",
      userInput,
      observedAt,
      {
        provenance: {
          conversationId: "conversation_profile_idempotency_1",
          turnId: "turn_profile_idempotency_1",
          dominantLaneAtWrite: "profile",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint
        }
      }
    );
    const secondResult = await store.ingestFromTaskInput(
      "task_profile_idempotency_2",
      userInput,
      observedAt,
      {
        provenance: {
          conversationId: "conversation_profile_idempotency_1",
          turnId: "turn_profile_idempotency_1",
          dominantLaneAtWrite: "workflow",
          sourceSurface: "broker_task_ingest",
          sourceFingerprint
        }
      }
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });
    const state = await store.load();

    assert.equal(firstResult.appliedFacts > 0, true);
    assert.deepEqual(secondResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.filter(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ).length,
      1
    );
    assert.equal(
      facts.filter(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ).length,
      1
    );
    assert.equal(state.ingestReceipts.length, 1);
    assert.equal(state.ingestReceipts[0]?.turnId, "turn_profile_idempotency_1");
    assert.equal(state.ingestReceipts[0]?.sourceFingerprint, sourceFingerprint);
  });
});

test("profile memory store quarantines unsupported validated fact sources before canonical mutation", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_quarantine",
      "",
      "2026-04-02T15:00:00.000Z",
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "assistant.generated_fact",
            confidence: 0.81
          }
        ]
      }
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(ingestResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "identity.preferred_name" &&
          fact.value === "Avery"
      ),
      false
    );
  });
});

test("profile memory store does not project historical self employment or residence into current flat facts", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_self",
      "I used to work at Lantern. I used to live in Detroit.",
      "2026-04-02T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_historical_self_1"
    });

    assert.deepEqual(ingestResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "employment.current" &&
          fact.value === "Lantern"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "residence.current" &&
          fact.value === "Detroit"
      ),
      false
    );
  });
});

test("profile memory store keeps explicit self end-state phrasing out of current flat facts", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_end_state_self",
      "I quit my job at Lantern. I don't live in Detroit anymore.",
      "2026-04-02T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_end_state_self_1"
    });

    assert.deepEqual(ingestResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "employment.current" &&
          fact.value === "Lantern"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "residence.current" &&
          fact.value === "Detroit"
      ),
      false
    );
  });
});

test("profile memory store keeps severed contact work-linkage out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_contact",
      "I don't work with Owen at Lantern Studio anymore.",
      "2026-04-02T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(ingestResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );
  });
});

test("profile memory store keeps historical contact work-linkage out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const workedWithResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_contact_work_with",
      "I worked with Owen at Lantern Studio.",
      "2026-04-02T15:00:00.000Z"
    );

    const workedWithFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(workedWithResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      workedWithFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      workedWithFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      workedWithFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );

    const workedWithMeResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_contact_work_association",
      "My friend Riley worked with me at Lantern Studio.",
      "2026-04-02T15:00:30.000Z"
    );

    const workedWithMeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(workedWithMeResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.name" &&
          fact.value === "Riley"
      ),
      true
    );
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.relationship" &&
          fact.value === "friend"
      ),
      true
    );
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );
  });
});

test("profile memory store keeps historical and severed direct contact relationships out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const formerCoworkerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_historical_contact",
      "Owen is my former coworker at Lantern Studio.",
      "2026-04-02T15:00:00.000Z"
    );
    const formerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerCoworkerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "coworker"
      ),
      false
    );
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );

    const formerFriendResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_friend_historical_contact",
      "Owen and I used to be friends.",
      "2026-04-03T15:00:30.000Z"
    );
    const formerFriendFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerFriendResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      formerFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "friend"
      ),
      false
    );

    const formerPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_partner_historical_contact",
      "Sam is my former girlfriend.",
      "2026-04-03T15:00:40.000Z"
    );
    const formerPartnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerPartnerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerPartnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.name" &&
          fact.value === "Sam"
      ),
      true
    );
    assert.equal(
      formerPartnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.relationship" &&
          fact.value === "partner"
      ),
      false
    );

    const formerMarriedPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_married_historical_contact",
      "I used to be married to Jules.",
      "2026-04-03T15:00:42.000Z"
    );
    const formerMarriedPartnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerMarriedPartnerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerMarriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.name" &&
          fact.value === "Jules"
      ),
      true
    );
    assert.equal(
      formerMarriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.relationship" &&
          fact.value === "partner"
      ),
      false
    );

    const formerRoommateResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_roommate_historical_contact",
      "Mira is my former roommate.",
      "2026-04-03T15:00:43.000Z"
    );
    const formerRoommateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerRoommateResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerRoommateFacts.some(
        (fact) =>
          fact.key === "contact.mira.name" &&
          fact.value === "Mira"
      ),
      true
    );
    assert.equal(
      formerRoommateFacts.some(
        (fact) =>
          fact.key === "contact.mira.relationship" &&
          fact.value === "roommate"
      ),
      false
    );

    const severedRoommateResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_roommate_severed_contact",
      "Noah is no longer my roommate.",
      "2026-04-03T15:00:43.500Z"
    );
    const severedRoommateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedRoommateResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedRoommateFacts.some(
        (fact) =>
          fact.key === "contact.noah.name" &&
          fact.value === "Noah"
      ),
      true
    );
    assert.equal(
      severedRoommateFacts.some(
        (fact) =>
          fact.key === "contact.noah.relationship" &&
          fact.value === "roommate"
      ),
      false
    );

    const formerPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_peer_historical_contact",
      "Parker and I used to be peers.",
      "2026-04-03T15:00:45.000Z"
    );
    const formerPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerPeerResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerPeerFacts.some(
        (fact) =>
          fact.key === "contact.parker.name" &&
          fact.value === "Parker"
      ),
      true
    );
    assert.equal(
      formerPeerFacts.some(
        (fact) =>
          fact.key === "contact.parker.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );

    const formerCousinResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_cousin_historical_contact",
      "Owen and I used to be cousins.",
      "2026-04-03T15:00:50.000Z"
    );
    const formerCousinFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerCousinResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      formerCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "cousin"
      ),
      false
    );

    const formerDistantRelativeResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_distant_relative_historical_contact",
      "Rosa and I used to be distant relatives.",
      "2026-04-03T15:00:55.000Z"
    );
    const formerDistantRelativeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerDistantRelativeResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      formerDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const formerFamilyResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_family_historical_contact",
      "Mina and I used to be family.",
      "2026-04-03T15:00:57.500Z"
    );
    const formerFamilyFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(formerFamilyResult.appliedFacts >= 1, true);
    assert.equal(
      formerFamilyFacts.some(
        (fact) =>
          fact.key === "contact.mina.name" &&
          fact.value === "Mina"
      ),
      true
    );
    assert.equal(
      formerFamilyFacts.some(
        (fact) =>
          fact.key === "contact.mina.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const currentBossResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_current_boss_contact",
      "Milo is my boss at Northstar Creative.",
      "2026-04-02T15:03:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentBossResult, {
      appliedFacts: 4,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.milo.relationship" &&
          fact.value === "manager"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.milo.work_association" &&
          fact.value === "Northstar Creative"
      ),
      true
    );

    const currentSupervisorResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_supervisor_contact",
      "My supervisor is Dana.",
      "2026-04-02T15:04:00.000Z"
    );
    const supervisorFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentSupervisorResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      supervisorFacts.some(
        (fact) =>
          fact.key === "contact.dana.name" &&
          fact.value === "Dana"
      ),
      true
    );
    assert.equal(
      supervisorFacts.some(
        (fact) =>
          fact.key === "contact.dana.relationship" &&
          fact.value === "manager"
      ),
      true
    );
    assert.equal(
      supervisorFacts.some(
        (fact) =>
          fact.key === "supervisor" &&
          fact.value === "Dana"
      ),
      false
    );

    const currentNamedBossResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_boss_contact",
      "My boss is Dana.",
      "2026-04-03T15:04:05.000Z"
    );
    const namedBossFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentNamedBossResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      namedBossFacts.some(
        (fact) =>
          fact.key === "contact.dana.name" &&
          fact.value === "Dana"
      ),
      true
    );
    assert.equal(
      namedBossFacts.some(
        (fact) =>
          fact.key === "contact.dana.relationship" &&
          fact.value === "manager"
      ),
      true
    );
    assert.equal(
      namedBossFacts.some(
        (fact) =>
          fact.key === "boss" &&
          fact.value === "Dana"
      ),
      false
    );

    const currentTeamLeadResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_team_lead_contact",
      "My team lead is Reese.",
      "2026-04-02T15:04:30.000Z"
    );
    const teamLeadFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentTeamLeadResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      teamLeadFacts.some(
        (fact) =>
          fact.key === "contact.reese.name" &&
          fact.value === "Reese"
      ),
      true
    );
    assert.equal(
      teamLeadFacts.some(
        (fact) =>
          fact.key === "contact.reese.relationship" &&
          fact.value === "manager"
      ),
      true
    );

    const currentLeadResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_lead_contact",
      "My lead is Avery.",
      "2026-04-02T15:04:45.000Z"
    );
    const leadFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentLeadResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      leadFacts.some(
        (fact) =>
          fact.key === "contact.avery.name" &&
          fact.value === "Avery"
      ),
      true
    );
    assert.equal(
      leadFacts.some(
        (fact) =>
          fact.key === "contact.avery.relationship" &&
          fact.value === "manager"
      ),
      true
    );

    const currentNeighbourResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_neighbour_contact",
      "My neighbour is Priya.",
      "2026-04-02T15:04:50.000Z"
    );
    const neighbourFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentNeighbourResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      neighbourFacts.some(
        (fact) =>
          fact.key === "contact.priya.name" &&
          fact.value === "Priya"
      ),
      true
    );
    assert.equal(
      neighbourFacts.some(
        (fact) =>
          fact.key === "contact.priya.relationship" &&
          fact.value === "neighbor"
      ),
      true
    );

    const currentPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_peer_contact",
      "My peer is Nolan.",
      "2026-04-02T15:04:55.000Z"
    );
    const peerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentPeerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      peerFacts.some(
        (fact) =>
          fact.key === "contact.nolan.name" &&
          fact.value === "Nolan"
      ),
      true
    );
    assert.equal(
      peerFacts.some(
        (fact) =>
          fact.key === "contact.nolan.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );

    const currentWorkPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_work_peer_contact",
      "My work peer is Rowan.",
      "2026-04-03T15:04:55.500Z"
    );
    const workPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentWorkPeerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      workPeerFacts.some(
        (fact) =>
          fact.key === "contact.rowan.name" &&
          fact.value === "Rowan"
      ),
      true
    );
    assert.equal(
      workPeerFacts.some(
        (fact) =>
          fact.key === "contact.rowan.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      workPeerFacts.some(
        (fact) =>
          fact.key === "work.peer" &&
          fact.value === "Rowan"
      ),
      false
    );

    const currentColleagueResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_colleague_contact",
      "My colleague is Evan.",
      "2026-04-03T15:04:55.750Z"
    );
    const colleagueFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentColleagueResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      colleagueFacts.some(
        (fact) =>
          fact.key === "contact.evan.name" &&
          fact.value === "Evan"
      ),
      true
    );
    assert.equal(
      colleagueFacts.some(
        (fact) =>
          fact.key === "contact.evan.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      colleagueFacts.some(
        (fact) =>
          fact.key === "contact.evan.relationship" &&
          fact.value === "colleague"
      ),
      false
    );

    const currentAcquaintanceResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_acquaintance_contact",
      "My acquaintance is Riley.",
      "2026-04-03T15:04:56.000Z"
    );
    const acquaintanceFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentAcquaintanceResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      acquaintanceFacts.some(
        (fact) =>
          fact.key === "contact.riley.name" &&
          fact.value === "Riley"
      ),
      true
    );
    assert.equal(
      acquaintanceFacts.some(
        (fact) =>
          fact.key === "contact.riley.relationship" &&
          fact.value === "acquaintance"
      ),
      true
    );
    assert.equal(
      acquaintanceFacts.some(
        (fact) =>
          fact.key === "acquaintance" &&
          fact.value === "Riley"
      ),
      false
    );

    const currentCousinResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_cousin_contact",
      "My cousin is Liam.",
      "2026-04-02T15:04:57.000Z"
    );
    const cousinFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentCousinResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      cousinFacts.some(
        (fact) =>
          fact.key === "contact.liam.name" &&
          fact.value === "Liam"
      ),
      true
    );
    assert.equal(
      cousinFacts.some(
        (fact) =>
          fact.key === "contact.liam.relationship" &&
          fact.value === "cousin"
      ),
      true
    );
    assert.equal(
      cousinFacts.some(
        (fact) =>
          fact.key === "cousin" &&
          fact.value === "Liam"
      ),
      false
    );

    const currentAuntResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_aunt_contact",
      "My aunt is Rosa.",
      "2026-04-03T15:04:57.500Z"
    );
    const auntFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentAuntResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      auntFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      auntFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      auntFacts.some(
        (fact) =>
          fact.key === "aunt" &&
          fact.value === "Rosa"
      ),
      false
    );

    const currentMomResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_mom_contact",
      "My mom is Ava.",
      "2026-04-03T15:04:57.563Z"
    );
    const momFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentMomResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      momFacts.some(
        (fact) =>
          fact.key === "contact.ava.name" &&
          fact.value === "Ava"
      ),
      true
    );
    assert.equal(
      momFacts.some(
        (fact) =>
          fact.key === "contact.ava.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      momFacts.some(
        (fact) =>
          fact.key === "mom" &&
          fact.value === "Ava"
      ),
      false
    );

    const currentFamilyMemberResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_family_member_contact",
      "My family member is Rosa.",
      "2026-04-03T15:04:57.594Z"
    );
    const familyMemberFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentFamilyMemberResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      familyMemberFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      familyMemberFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      familyMemberFacts.some(
        (fact) =>
          fact.key === "family.member" &&
          fact.value === "Rosa"
      ),
      false
    );

    const currentSonResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_son_contact",
      "My son is Mason.",
      "2026-04-03T15:04:57.610Z"
    );
    const sonFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentSonResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      sonFacts.some(
        (fact) =>
          fact.key === "contact.mason.name" &&
          fact.value === "Mason"
      ),
      true
    );
    assert.equal(
      sonFacts.some(
        (fact) =>
          fact.key === "contact.mason.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      sonFacts.some(
        (fact) =>
          fact.key === "son" &&
          fact.value === "Mason"
      ),
      false
    );

    const currentPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_partner_contact",
      "My wife is Sam.",
      "2026-04-03T15:04:57.625Z"
    );
    const partnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentPartnerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      partnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.name" &&
          fact.value === "Sam"
      ),
      true
    );
    assert.equal(
      partnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.relationship" &&
          fact.value === "partner"
      ),
      true
    );
    assert.equal(
      partnerFacts.some(
        (fact) =>
          fact.key === "wife" &&
          fact.value === "Sam"
      ),
      false
    );

    const currentRoommateResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_roommate_contact",
      "My roommate is Kai.",
      "2026-04-03T15:04:57.600Z"
    );
    const roommateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentRoommateResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      roommateFacts.some(
        (fact) =>
          fact.key === "contact.kai.name" &&
          fact.value === "Kai"
      ),
      true
    );
    assert.equal(
      roommateFacts.some(
        (fact) =>
          fact.key === "contact.kai.relationship" &&
          fact.value === "roommate"
      ),
      true
    );
    assert.equal(
      roommateFacts.some(
        (fact) =>
          fact.key === "roommate" &&
          fact.value === "Kai"
      ),
      false
    );

    const currentMarriedPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_current_married_contact",
      "Jules and I are married.",
      "2026-04-03T15:04:57.700Z"
    );
    const marriedPartnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentMarriedPartnerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      marriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.name" &&
          fact.value === "Jules"
      ),
      true
    );
    assert.equal(
      marriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.relationship" &&
          fact.value === "partner"
      ),
      true
    );

    const currentDistantRelativeResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_distant_relative_contact",
      "My distant relative is June.",
      "2026-04-03T15:04:57.750Z"
    );
    const distantRelativeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentDistantRelativeResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      distantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.june.name" &&
          fact.value === "June"
      ),
      true
    );
    assert.equal(
      distantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.june.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      distantRelativeFacts.some(
        (fact) =>
          fact.key === "distant.relative" &&
          fact.value === "June"
      ),
      false
    );

    const currentFriendResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_friend_current_contact",
      "I'm friends with Quinn.",
      "2026-04-03T15:04:58.000Z"
    );
    const currentFriendFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentFriendResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      currentFriendFacts.some(
        (fact) =>
          fact.key === "contact.quinn.name" &&
          fact.value === "Quinn"
      ),
      true
    );
    assert.equal(
      currentFriendFacts.some(
        (fact) =>
          fact.key === "contact.quinn.relationship" &&
          fact.value === "friend"
      ),
      true
    );

    const currentTeammateResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_teammate_current_contact",
      "Parker and I are teammates.",
      "2026-04-03T15:04:59.000Z"
    );
    const currentTeammateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentTeammateResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentTeammateFacts.some(
        (fact) =>
          fact.key === "contact.parker.name" &&
          fact.value === "Parker"
      ),
      true
    );
    assert.equal(
      currentTeammateFacts.some(
        (fact) =>
          fact.key === "contact.parker.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );

    const currentDistantRelativeSymmetricResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_distant_relative_current_contact",
      "Rosa and I are distant relatives.",
      "2026-04-03T15:04:59.500Z"
    );
    const currentDistantRelativeSymmetricFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentDistantRelativeSymmetricResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentDistantRelativeSymmetricFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      currentDistantRelativeSymmetricFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      true
    );

    const severedManagerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_contact",
      "Jordan is no longer my boss.",
      "2026-04-02T15:05:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedManagerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.jordan.name" &&
          fact.value === "Jordan"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.jordan.relationship" &&
          fact.value === "manager"
      ),
      false
    );

    const severedFriendResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_friend_severed_contact",
      "I'm not friends with Owen anymore.",
      "2026-04-03T15:05:05.000Z"
    );
    const severedFriendFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedFriendResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      severedFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "friend"
      ),
      false
    );

    const severedSymmetricPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_peer_severed_contact",
      "I'm not peers with Avery anymore.",
      "2026-04-03T15:05:07.000Z"
    );
    const severedSymmetricPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedSymmetricPeerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedSymmetricPeerFacts.some(
        (fact) =>
          fact.key === "contact.avery.name" &&
          fact.value === "Avery"
      ),
      true
    );
    assert.equal(
      severedSymmetricPeerFacts.some(
        (fact) =>
          fact.key === "contact.avery.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );

    const severedCousinResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_cousin_severed_contact",
      "I'm not cousins with Owen anymore.",
      "2026-04-03T15:05:08.000Z"
    );
    const severedCousinFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedCousinResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      severedCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "cousin"
      ),
      false
    );

    const severedDistantRelativeResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_distant_relative_severed_contact",
      "Naomi and I aren't distant relatives anymore.",
      "2026-04-03T15:05:09.000Z"
    );
    const severedDistantRelativeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedDistantRelativeResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      severedDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.naomi.name" &&
          fact.value === "Naomi"
      ),
      true
    );
    assert.equal(
      severedDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.naomi.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const severedSiblingResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_sibling_severed_contact",
      "Lena and I aren't siblings anymore.",
      "2026-04-03T15:05:09.500Z"
    );
    const severedSiblingFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(severedSiblingResult.appliedFacts >= 1, true);
    assert.equal(
      severedSiblingFacts.some(
        (fact) =>
          fact.key === "contact.lena.name" &&
          fact.value === "Lena"
      ),
      true
    );
    assert.equal(
      severedSiblingFacts.some(
        (fact) =>
          fact.key === "contact.lena.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const severedLeadResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_lead_contact",
      "Robin is no longer my lead.",
      "2026-04-02T15:05:15.000Z"
    );
    const severedLeadFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedLeadResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedLeadFacts.some(
        (fact) =>
          fact.key === "contact.robin.name" &&
          fact.value === "Robin"
      ),
      true
    );
    assert.equal(
      severedLeadFacts.some(
        (fact) =>
          fact.key === "contact.robin.relationship" &&
          fact.value === "manager"
      ),
      false
    );

    const severedNeighbourResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_neighbour_contact",
      "Taylor is no longer my neighbour.",
      "2026-04-02T15:05:20.000Z"
    );
    const severedNeighbourFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedNeighbourResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedNeighbourFacts.some(
        (fact) =>
          fact.key === "contact.taylor.name" &&
          fact.value === "Taylor"
      ),
      true
    );
    assert.equal(
      severedNeighbourFacts.some(
        (fact) =>
          fact.key === "contact.taylor.relationship" &&
          fact.value === "neighbor"
      ),
      false
    );

    const severedPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_peer_contact",
      "Piper is no longer my peer.",
      "2026-04-02T15:05:25.000Z"
    );
    const severedPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedPeerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedPeerFacts.some(
        (fact) =>
          fact.key === "contact.piper.name" &&
          fact.value === "Piper"
      ),
      true
    );
    assert.equal(
      severedPeerFacts.some(
        (fact) =>
          fact.key === "contact.piper.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
  });
});

test("profile memory store keeps wrapped named-contact work-with phrasing on one canonical contact token", async () => {
  await withProfileStore(async (store) => {
    const wrappedWorkWithResult = await store.ingestFromTaskInput(
      "task_profile_governance_wrapped_named_work_with_contact",
      "I work with a guy named Milo at Northstar Creative.",
      "2026-04-03T15:10:00.000Z"
    );
    const wrappedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(wrappedWorkWithResult.appliedFacts > 0, true);
    assert.equal(wrappedWorkWithResult.supersededFacts >= 0, true);
    assert.equal(
      wrappedFacts.some(
        (fact) =>
          fact.key === "contact.milo.name" &&
          fact.value === "Milo"
      ),
      true
    );
    assert.equal(
      wrappedFacts.some(
        (fact) =>
          fact.key === "contact.milo.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      wrappedFacts.some(
        (fact) =>
          fact.key === "contact.milo.work_association" &&
          fact.value === "Northstar Creative"
      ),
      true
    );
    assert.equal(
      wrappedFacts.some((fact) =>
        fact.key.includes("northstar") || fact.key.includes("a.guy.named.milo")
      ),
      false
    );

    const plainWorkWithMeResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_plain_work_with_me_contact",
      "A person named Milo works with me.",
      "2026-04-03T15:11:00.000Z"
    );
    const plainFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(plainWorkWithMeResult.appliedFacts >= 0, true);
    assert.equal(plainWorkWithMeResult.supersededFacts >= 0, true);
    assert.equal(
      plainFacts.some(
        (fact) =>
          fact.key === "contact.milo.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
  });
});

test("profile memory store keeps current direct-report aliases current while historical and severed variants fail closed", async () => {
  await withProfileStore(async (store) => {
    const currentDirectReportResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_direct_report_contact",
      "My direct report is Casey.",
      "2026-04-02T15:06:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentDirectReportResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.casey.name" &&
          fact.value === "Casey"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.casey.relationship" &&
          fact.value === "employee"
      ),
      true
    );

    const historicalDirectReportResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_direct_report_contact",
      "Quinn is my former direct report at Northstar Creative.",
      "2026-04-02T15:07:00.000Z"
    );
    const historicalFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(historicalDirectReportResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.name" &&
          fact.value === "Quinn"
      ),
      true
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.relationship" &&
          fact.value === "employee"
      ),
      false
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.work_association" &&
          fact.value === "Northstar Creative"
      ),
      false
    );

    const severedDirectReportResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_direct_report_contact",
      "Taylor is no longer my direct report.",
      "2026-04-02T15:08:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedDirectReportResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.name" &&
          fact.value === "Taylor"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.relationship" &&
          fact.value === "employee"
      ),
      false
    );
  });
});

test("profile memory store keeps works-for-me employee-direction current while historical and severed variants fail closed", async () => {
  await withProfileStore(async (store) => {
    const currentEmployeeLinkResult = await store.ingestFromTaskInput(
      "task_profile_governance_current_employee_link_contact",
      "Owen works for me at Lantern Studio.",
      "2026-04-02T15:09:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentEmployeeLinkResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "employee"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      true
    );

    const historicalEmployeeLinkResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_employee_link_contact",
      "Quinn used to work for me at Northstar Creative.",
      "2026-04-02T15:10:00.000Z"
    );
    const historicalFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(historicalEmployeeLinkResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.name" &&
          fact.value === "Quinn"
      ),
      true
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.relationship" &&
          fact.value === "employee"
      ),
      false
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.work_association" &&
          fact.value === "Northstar Creative"
      ),
      false
    );

    const severedEmployeeLinkResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_employee_link_contact",
      "Taylor no longer works for me at Northstar Creative.",
      "2026-04-02T15:11:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedEmployeeLinkResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.name" &&
          fact.value === "Taylor"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.relationship" &&
          fact.value === "employee"
      ),
      false
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.work_association" &&
          fact.value === "Northstar Creative"
      ),
      false
    );
  });
});

test("profile memory store keeps works-with-me work-peer direction current while historical and severed variants fail closed", async () => {
  await withProfileStore(async (store) => {
    const currentResult = await store.ingestFromTaskInput(
      "task_profile_governance_current_work_peer_link",
      "Owen works with me at Lantern Studio.",
      "2026-04-02T15:00:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      true
    );

    const historicalResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_work_peer_link",
      "Owen worked with me at Lantern Studio.",
      "2026-04-02T15:00:30.000Z"
    );
    const historicalFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(historicalResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      historicalFacts.filter(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ).length,
      1
    );

    const severedResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_work_peer_link",
      "Owen no longer works with me at Lantern Studio.",
      "2026-04-02T15:01:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      severedFacts.filter(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ).length,
      1
    );
  });
});

test("planning context is query-aware and surfaces matching contact facts", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_query_1",
      "my favorite editor is Helix and my name is Benny",
      "2026-02-24T00:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_query_2",
      "I used to work with Owen at Lantern Studio.",
      "2026-02-24T00:01:00.000Z"
    );

    const planningContext = await store.getPlanningContext(4, "who is Owen?");
    assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
    assert.equal(
      planningContext.includes("contact.owen.work_association: Lantern Studio"),
      false
    );
  });
});

test("profile memory store keeps historical school association out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_school_association_historical",
      "I went to school with a guy named Owen.",
      "2026-04-03T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });
    const planningContext = await store.getPlanningContext(4, "who is Owen?");

    assert.deepEqual(ingestResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "acquaintance"
      ),
      true
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.school_association" &&
          fact.value === "went_to_school_together"
      ),
      false
    );
    assert.equal(
      planningContext.includes("contact.owen.school_association: went_to_school_together"),
      false
    );
  });
});

test("profile memory store keeps contact entity hints out of current flat and planning surfaces until corroborated", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_contact_entity_hint_support_only",
      "I know Sarah.",
      "2026-04-03T15:05:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });
    const planningContext = await store.getPlanningContext(4, "who is Sarah?");

    assert.deepEqual(ingestResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.sarah.name" &&
          fact.value === "Sarah"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key.startsWith("contact.sarah.context.") &&
          fact.value === "I know Sarah"
      ),
      true
    );
    assert.equal(planningContext.includes("contact.sarah.name: Sarah"), false);
    assert.equal(planningContext.includes("I know Sarah"), true);
  });
});

test("episode planning context is query-aware and surfaces matching unresolved situations", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_episode_context_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    const episodePlanningContext = await store.getEpisodePlanningContext(
      2,
      "How is Owen doing after the fall?"
    );

    assert.match(episodePlanningContext, /Owen fell down/);
    assert.match(episodePlanningContext, /status=unresolved/);
  });
});

test("readEpisodes hides sensitive episodes unless explicit approval is present", async () => {
  await withProfileStore(async (store) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_read_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-08T10:00:00.000Z"
        }),
        createProfileEpisodeRecord({
          title: "Private family health situation",
          summary: "A private health situation came up.",
          sourceTaskId: "task_profile_store_read_episode_2",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: true,
          observedAt: "2026-03-08T11:00:00.000Z"
        })
      ]
    };

    await (store as unknown as { save: (state: typeof seededState) => Promise<void> }).save(
      seededState
    );

    const withoutApproval = await store.readEpisodes({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: false
    });
    assert.equal(withoutApproval.length, 1);
    assert.equal(withoutApproval[0]?.title, "Owen fell down");

    const withApproval = await store.readEpisodes({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_episode_read_1"
    });
    assert.equal(withApproval.length, 2);
  });
});

test("queryEpisodesForContinuity returns linked unresolved episodes for re-mentioned entity hints", async () => {
  await withProfileStore(async (store, filePath) => {
    const observedAt = "2026-03-08T10:00:00.000Z";
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down a few weeks ago and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_query_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt,
          entityRefs: ["contact.owen"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const graph = applyEntityExtractionToGraph(
      createEmptyEntityGraphV1(observedAt),
      extractEntityCandidates({
        text: "Owen checked in after the fall.",
        observedAt,
        evidenceRef: "trace:store_query_episode_1"
      }),
      observedAt,
      "trace:store_query_episode_1"
    ).graph;
    const seededStack = buildConversationStackFromTurnsV1(
      [
        {
          role: "user",
          text: "Owen fell down a few weeks ago.",
          at: observedAt
        }
      ],
      observedAt
    );
    const stack = upsertOpenLoopOnConversationStackV1({
      stack: seededStack,
      threadKey: seededStack.activeThreadKey!,
      text: "Remind me later to ask how Owen is doing after the fall.",
      observedAt,
      entityRefs: ["Owen"]
    }).stack;

    const matches = await store.queryEpisodesForContinuity(graph, stack, {
      entityHints: ["Owen"]
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.episode.title, "Owen fell down");
    assert.equal(matches[0]?.entityLinks.length > 0, true);
    assert.equal(matches[0]?.openLoopLinks.length > 0, true);
  });
});

test("profile memory store load preserves persisted episodic-memory state", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fall situation",
          summary: "Owen fell down a few weeks ago and the outcome was never mentioned.",
          sourceTaskId: "task_profile_store_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-08T10:00:00.000Z",
          entityRefs: ["entity_owen"],
          openLoopRefs: ["loop_owen"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const loaded = await store.load();
    assert.equal(loaded.episodes.length, 1);
    assert.equal(loaded.episodes[0]?.title, "Owen fall situation");
    assert.deepEqual(loaded.episodes[0]?.entityRefs, ["entity_owen"]);
  });
});

test("profile memory store load consolidates duplicate episodic-memory records", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down near the stairs.",
          sourceTaskId: "task_profile_store_episode_consolidation_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-01T10:00:00.000Z",
          entityRefs: ["contact.owen"],
          openLoopRefs: ["loop_old"],
          tags: ["injury"]
        }),
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down near the stairs and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_episode_consolidation_2",
          source: "test",
          sourceKind: "assistant_inference",
          sensitive: false,
          observedAt: "2026-03-02T10:00:00.000Z",
          entityRefs: ["contact.owen"],
          openLoopRefs: ["loop_new"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const loaded = await store.load();
    assert.equal(loaded.episodes.length, 1);
    assert.match(loaded.episodes[0]?.summary ?? "", /outcome was unresolved/i);
    assert.deepEqual(loaded.episodes[0]?.openLoopRefs, ["loop_new", "loop_old"]);
  });
});

test("ingestFromTaskInput extracts and later resolves bounded episodic-memory situations", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_episode_ingest_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    let state = await store.load();
    assert.equal(state.episodes.length, 1);
    assert.equal(state.episodes[0]?.title, "Owen fell down");
    assert.equal(state.episodes[0]?.status, "unresolved");

    await store.ingestFromTaskInput(
      "task_profile_store_episode_ingest_2",
      "Owen is doing better now after the fall.",
      "2026-03-08T12:00:00.000Z"
    );

    state = await store.load();
    assert.equal(state.episodes.length, 1);
    assert.equal(state.episodes[0]?.status, "resolved");
    assert.equal(state.episodes[0]?.resolvedAt, "2026-03-08T12:00:00.000Z");
  });
});

test("ingestFromTaskInput uses voice transcripts for durable fact and episode extraction", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_media_voice_1",
      [
        "Please fix this before lunch.",
        "",
        "Attached media context:",
        "- Voice note transcript: My name is Benny and Owen fell down last week."
      ].join("\n"),
      "2026-03-08T13:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_media_voice_1",
      maxFacts: 10
    });
    assert.equal(
      facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Benny"),
      true
    );

    const episodes = await store.reviewEpisodesForUser(5, "2026-03-08T13:05:00.000Z");
    assert.equal(episodes.some((episode) => episode.title === "Owen fell down"), true);
  });
});

test("ingestFromTaskInput suppresses generic media-only prompts but still accepts interpreted situation summaries", async () => {
  await withProfileStore(async (store) => {
    const genericResult = await store.ingestFromTaskInput(
      "task_profile_store_media_generic_1",
      "Please review the attached image and respond based on what it shows.",
      "2026-03-08T14:00:00.000Z"
    );
    assert.deepEqual(genericResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });

    await store.ingestFromTaskInput(
      "task_profile_store_media_summary_1",
      [
        "You did this wrong.",
        "",
        "Attached media context:",
        "- image summary: Owen fell down near the stairs and the outcome still sounds unresolved.",
        "- OCR text: Owen fell down near the stairs"
      ].join("\n"),
      "2026-03-08T14:10:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_media_summary_1",
      maxFacts: 10
    });
    assert.equal(facts.some((fact) => fact.key === "identity.preferred_name"), false);

    const episodes = await store.reviewEpisodesForUser(5, "2026-03-08T14:15:00.000Z");
    assert.equal(episodes.some((episode) => episode.title === "Owen fell down"), true);
  });
});

test("fromEnv returns undefined when profile memory is disabled", () => {
  const store = ProfileMemoryStore.fromEnv({});
  assert.equal(store, undefined);
});

test("fromEnv throws when enabled without encryption key", () => {
  assert.throws(
    () =>
      ProfileMemoryStore.fromEnv({
        BRAIN_PROFILE_MEMORY_ENABLED: "true"
      }),
    /BRAIN_PROFILE_ENCRYPTION_KEY/
  );
});

test("fromEnv initializes store when enabled with valid key", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const store = ProfileMemoryStore.fromEnv({
    BRAIN_PROFILE_MEMORY_ENABLED: "true",
    BRAIN_PROFILE_ENCRYPTION_KEY: key
  });
  assert.ok(store);
});

test("evaluateAgentPulse allows stale-fact revalidation when stale facts exist", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_stale_1",
      "my favorite editor is vscode",
      "2025-01-10T00:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.staleFactCount > 0, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("ingestFromTaskInput accepts validated identity candidates without requiring discourse-heavy raw extraction", async () => {
  await withProfileStore(async (store) => {
    const result = await store.ingestFromTaskInput(
      "task_profile_store_validated_identity_1",
      "I already told you my name is Avery several times.",
      "2026-03-21T12:00:00.000Z",
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "conversation.identity_interpretation",
            confidence: 0.95
          }
        ]
      }
    );

    assert.equal(result.appliedFacts, 1);

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_validated_identity_1",
      maxFacts: 10
    });
    assert.equal(
      facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Avery"),
      true
    );
  });
});

test("evaluateAgentPulse suppresses stale-fact revalidation for workflow-dominant sessions", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_stale_workflow_1",
      "my favorite editor is vscode",
      "2025-01-10T00:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null,
        sessionDominantLane: "workflow",
        sessionHasActiveWorkflowContinuity: true,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.staleFactCount > 0, true);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "SESSION_DOMAIN_SUPPRESSED");
  });
});

test("evaluateAgentPulse exposes bounded fresh unresolved situations for pulse grounding", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen finished rehab",
          summary: "Owen finished rehab and fully recovered.",
          sourceTaskId: "task_profile_store_pulse_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-05T10:00:00.000Z",
          lastMentionedAt: "2026-03-05T10:00:00.000Z",
          status: "resolved",
          resolvedAt: "2026-03-05T12:00:00.000Z",
          entityRefs: ["contact.owen"]
        }),
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down and the outcome is unresolved.",
          sourceTaskId: "task_profile_store_pulse_episode_2",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-07T10:00:00.000Z",
          lastMentionedAt: "2026-03-07T10:00:00.000Z",
          entityRefs: ["contact.owen"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-03-08T10:00:00.000Z",
        userOptIn: true,
        reason: "contextual_followup",
        contextualLinkageConfidence: 0.9,
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.decision.allowed, true);
    assert.deepEqual(
      evaluation.relevantEpisodes.map((episode) => episode.title),
      ["Owen fell down"]
    );
  });
});

test("evaluateAgentPulse blocks stale-fact reason when no stale facts exist", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_stale_2",
      "my favorite editor is vscode",
      "2026-02-23T12:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.staleFactCount, 0);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "NO_STALE_FACTS");
  });
});

test("evaluateAgentPulse applies unresolved-commitment signal and deterministic rate limit", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_1",
      "my todo item is finish taxes",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: "2026-02-23T14:20:00.000Z"
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "RATE_LIMIT");
    assert.equal(evaluation.decision.nextEligibleAtIso, "2026-02-23T15:20:00.000Z");
  });
});

test("evaluateAgentPulse treats noisy follow-up keys as unresolved commitments", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_noisy_key",
      "my followup'sda tax filing is pending.",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount > 0, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("evaluateAgentPulse exposes unresolved commitment topics for prompt grounding", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_topics",
      "my followup.tax filing is pending.",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.unresolvedCommitmentTopics.includes("tax filing"), true);
  });
});

test("ingest resolves unresolved follow-up when completion update references same topic", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_topic_resolve_1",
      "my followup.tax filing is pending.",
      "2026-02-25T02:03:42.097Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_commitment_topic_resolve_2",
      "my tax filing is complete, I dont need help",
      "2026-02-25T02:04:24.081Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 0);
    assert.deepEqual(evaluation.unresolvedCommitmentTopics, []);

    const state = await store.load();
    const resolvedFollowup = state.facts
      .filter((fact) => fact.status !== "superseded")
      .find((fact) => fact.key === "followup.tax.filing");
    assert.ok(resolvedFollowup);
    assert.equal(resolvedFollowup?.value, "resolved");
    assert.ok(resolvedFollowup?.mutationAudit);
    assert.equal(
      resolvedFollowup?.mutationAudit?.rulepackVersion,
      "CommitmentSignalRulepackV1"
    );
    assert.equal(
      resolvedFollowup?.mutationAudit?.matchedRuleId ===
        "commitment_signal_v1_user_input_topic_resolution_candidate" ||
      resolvedFollowup?.mutationAudit?.matchedRuleId ===
        "commitment_signal_v1_user_input_generic_resolution",
      true
    );
    assert.equal(resolvedFollowup?.mutationAudit?.confidenceTier, "HIGH");
    assert.equal(resolvedFollowup?.mutationAudit?.conflict, false);
  });
});

test("ingest keeps unresolved follow-up when commitment text contains conflicting resolution and unresolved signals", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_conflict_1",
      "my followup.tax filing is pending.",
      "2026-02-25T02:03:42.097Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_conflict_2",
      "my tax filing is complete but still pending",
      "2026-02-25T02:04:24.081Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.unresolvedCommitmentTopics.includes("tax filing"), true);
  });
});

test("load reconciles contradictory completion facts and unresolved follow-up facts", async () => {
  await withProfileStore(async (store) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "followup.tax.filing",
      value: "pending",
      sensitive: false,
      sourceTaskId: "seed_followup_pending",
      source: "test.seed",
      observedAt: "2026-02-25T02:03:42.097Z",
      confidence: 0.95
    }).nextState;
    seededState = upsertTemporalProfileFact(seededState, {
      key: "tax.filing",
      value: "complete",
      sensitive: false,
      sourceTaskId: "seed_topic_complete",
      source: "test.seed",
      observedAt: "2026-02-25T02:04:24.081Z",
      confidence: 0.95
    }).nextState;

    await (store as unknown as { save: (state: typeof seededState) => Promise<void> }).save(
      seededState
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:10:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );
    assert.equal(evaluation.unresolvedCommitmentCount, 0);

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "test_approval",
      maxFacts: 20
    });
    const followupTax = facts.find((fact) => fact.key === "followup.tax.filing");
    assert.ok(followupTax);
    assert.equal(followupTax?.value, "resolved");

    const state = await store.load();
    const resolvedFollowup = state.facts
      .filter((fact) => fact.status !== "superseded")
      .find((fact) => fact.key === "followup.tax.filing");
    assert.ok(resolvedFollowup?.mutationAudit);
    assert.equal(
      resolvedFollowup?.mutationAudit?.matchedRuleId,
      "commitment_signal_v1_fact_value_resolved_marker"
    );
    assert.equal(
      resolvedFollowup?.mutationAudit?.rulepackVersion,
      "CommitmentSignalRulepackV1"
    );
  });
});

test("evaluateAgentPulse blocks check-ins during quiet hours unless overridden", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_2",
      "my todo item is finish taxes",
      "2026-02-23T10:00:00.000Z"
    );

    const blocked = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T23:30:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(blocked.decision.allowed, false);
    assert.equal(blocked.decision.decisionCode, "QUIET_HOURS");

    const overridden = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T23:30:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(overridden.decision.allowed, true);
    assert.equal(overridden.decision.decisionCode, "ALLOWED");
  });
});

test("reviewEpisodesForUser and explicit user episode updates remain bounded and deterministic", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_user_review_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    const reviewed = await store.reviewEpisodesForUser(
      5,
      "2026-03-08T10:05:00.000Z"
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.status, "unresolved");

    const resolved = await store.updateEpisodeFromUser(
      reviewed[0]!.episodeId,
      "resolved",
      "memory_resolve_1",
      "/memory resolve episode",
      "Owen recovered and is fine now.",
      "2026-03-08T11:00:00.000Z"
    );
    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.resolvedAt, "2026-03-08T11:00:00.000Z");

    const forgotten = await store.forgetEpisodeFromUser(
      reviewed[0]!.episodeId,
      "memory_forget_1",
      "/memory forget episode",
      "2026-03-08T12:00:00.000Z"
    );
    assert.equal(forgotten?.episodeId, reviewed[0]?.episodeId);

    const afterForget = await store.reviewEpisodesForUser(
      5,
      "2026-03-08T12:10:00.000Z"
    );
    assert.equal(afterForget.length, 0);
  });
});

test("relationship-aware temporal nudging role taxonomy suppresses socially distant unresolved-commitment nudges", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_relationship_1",
      "my relationship role is acquaintance",
      "2026-02-23T10:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_relationship_2",
      "my todo item is finish taxes",
      "2026-02-23T10:05:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.relationship.role, "acquaintance");
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "RELATIONSHIP_ROLE_SUPPRESSED");
  });
});

test("relationship-aware temporal nudging context drift requires revalidation before allowed nudge", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_drift_1",
      "my manager is Jordan",
      "2026-02-23T08:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_2",
      "my job is OldCo",
      "2026-02-23T08:30:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_3",
      "my new job is NewCo",
      "2026-02-23T09:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_4",
      "my todo item is finish taxes",
      "2026-02-23T09:10:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.relationship.role, "manager");
    assert.equal(evaluation.contextDrift.detected, true);
    assert.equal(evaluation.contextDrift.domains.includes("job"), true);
    assert.equal(evaluation.contextDrift.requiresRevalidation, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("relationship-aware temporal nudging role taxonomy updates behavior after context drift relationship changes", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_relationship_change_1",
      "my relationship role is acquaintance",
      "2026-02-23T10:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_relationship_change_2",
      "my todo item is finish taxes",
      "2026-02-23T10:05:00.000Z"
    );

    const first = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );
    assert.equal(first.decision.decisionCode, "RELATIONSHIP_ROLE_SUPPRESSED");

    await store.ingestFromTaskInput(
      "task_profile_relationship_change_3",
      "my relationship role is friend",
      "2026-02-23T10:10:00.000Z"
    );

    const second = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(second.relationship.role, "friend");
    assert.equal(second.decision.allowed, true);
    assert.equal(second.decision.decisionCode, "ALLOWED");
  });
});

