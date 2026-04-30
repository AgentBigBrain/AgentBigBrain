/**
 * @fileoverview Tests Obsidian vault projection output, collection rewrites, and review-note preservation.
 */

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEmptyProfileMemoryState, createProfileEpisodeRecord } from "../../src/core/profileMemory";
import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import { ObsidianVaultSink } from "../../src/core/projections/targets/obsidianVaultSink";
import { buildProjectionChangeSet } from "../../src/core/projections/service";
import { buildProjectionSnapshotFixture } from "./projectionTestSupport";

test("ObsidianVaultSink rebuild mirrors notes and assets without deleting operator review notes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-"));
  try {
    const vaultPath = path.join(tempDir, "vault");
    const runtimeAssetPath = path.join(tempDir, "runtime_asset.pdf");
    await writeFile(runtimeAssetPath, "detroit plan pdf", "utf8");
    await mkdir(path.join(vaultPath, "AgentBigBrain", "40 Review Actions"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "AgentBigBrain", "40 Review Actions", "operator-note.md"),
      "# Operator note\n",
      "utf8"
    );

    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: true
    });
    const snapshot = buildProjectionSnapshotFixture({
      mode: "operator_full",
      mediaArtifacts: [
        {
          artifactId: "media_artifact_detroit",
          provider: "telegram",
          sourceSurface: "telegram_interface",
          kind: "document",
          recordedAt: "2026-04-12T12:00:00.000Z",
          sourceConversationKey: "telegram:detroit:user",
          sourceUserId: "user_detroit",
          fileId: "file_detroit_pdf",
          fileUniqueId: "unique_detroit_pdf",
          mimeType: "application/pdf",
          fileName: "detroit-plan.pdf",
          sizeBytes: 16,
          caption: "Detroit plan",
          durationSeconds: null,
          width: null,
          height: null,
          checksumSha256: "abc123",
          ownedAssetPath: runtimeAssetPath,
          assetFileName: "media_artifact_detroit.pdf",
          derivedMeaning: {
            summary: "Detroit plan PDF",
            transcript: null,
            ocrText: "Detroit plan contents",
            entityHints: ["entity_detroit"]
          }
        }
      ]
    });

    await sink.rebuild(snapshot);

    await access(path.join(vaultPath, "AgentBigBrain", "00 Dashboard.md"));
    await access(path.join(vaultPath, "AgentBigBrain", "10 Entities", "Detroit.md"));
    await access(path.join(vaultPath, "AgentBigBrain", "50 Assets", "media_artifact_detroit.pdf"));
    await access(path.join(vaultPath, "AgentBigBrain", "40 Review Actions", "operator-note.md"));
    const mediaNote = await readFile(
      path.join(vaultPath, "AgentBigBrain", "22 Media Artifacts", "2026-04-12 detroit-plan.pdf.md"),
      "utf8"
    );
    assert.match(mediaNote, /Detroit plan PDF/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObsidianVaultSink review-safe projection redacts local path tokens from notes and filenames", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-redaction-"));
  const previousUsername = process.env.USERNAME;
  process.env.USERNAME = "projectionuser";
  try {
    const vaultPath = path.join(tempDir, "vault");
    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });
    const state = createEmptyProfileMemoryState();
    const localPathText =
      "Review C:\\Users\\projectionuser\\OneDrive\\Desktop\\AgentBigBrain-public\\private.txt";

    await sink.rebuild(buildProjectionSnapshotFixture({
      mode: "review_safe",
      profileMemory: {
        ...state,
        episodes: [
          createProfileEpisodeRecord({
            title: localPathText,
            summary: localPathText,
            sourceTaskId: "task_projection_local_path",
            source: "test.seed",
            sourceKind: "explicit_user_statement",
            sensitive: false,
            confidence: 0.85,
            observedAt: "2026-04-12T12:00:00.000Z",
            entityRefs: [],
            openLoopRefs: [],
            tags: ["redaction"]
          })
        ]
      },
      workflowPatterns: [
        {
          id: "workflow_local_path",
          workflowKey: `${localPathText} open_users_projectionuser_desktop_solar`,
          status: "active",
          confidence: 0.8,
          firstSeenAt: "2026-04-12T12:00:00.000Z",
          lastSeenAt: "2026-04-12T12:00:00.000Z",
          supersededAt: null,
          domainLane: "workflow",
          successCount: 1,
          failureCount: 0,
          suppressedCount: 0,
          contextTags: []
        }
      ]
    }));

    const rootPath = path.join(vaultPath, "AgentBigBrain");
    const relativePaths = await collectRelativeFilePaths(rootPath);
    const contents = await Promise.all(
      relativePaths.map((relativePath) => readFile(path.join(rootPath, relativePath), "utf8"))
    );
    const combined = [...relativePaths, ...contents].join("\n");

    assert.doesNotMatch(combined, /C:\\/);
    assert.doesNotMatch(combined, /\bprojectionuser\b/i);
    assert.doesNotMatch(combined, /\bOneDrive\b/i);
    assert.doesNotMatch(combined, /\bAgentBigBrain-public\b/);
    assert.match(combined, /\[redacted local path\]/);
  } finally {
    if (previousUsername === undefined) {
      delete process.env.USERNAME;
    } else {
      process.env.USERNAME = previousUsername;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObsidianVaultSink sync rewrites affected collections and preserves untouched review-action notes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-sync-"));
  try {
    const vaultPath = path.join(tempDir, "vault");
    await mkdir(path.join(vaultPath, "AgentBigBrain", "40 Review Actions"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "AgentBigBrain", "40 Review Actions", "operator-note.md"),
      "# Operator note\n",
      "utf8"
    );

    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });
    await sink.rebuild(buildProjectionSnapshotFixture());

    await sink.sync(
      buildProjectionChangeSet(["entity_graph_changed"], ["entity_graph:test"]),
      buildProjectionSnapshotFixture({
        entityGraph: {
          schemaVersion: "v1",
          updatedAt: "2026-04-12T13:00:00.000Z",
          entities: [
            {
              entityKey: "entity_bob",
              canonicalName: "Bob",
              entityType: "person",
              disambiguator: null,
              domainHint: "relationship",
              aliases: ["Bob"],
              firstSeenAt: "2026-04-12T13:00:00.000Z",
              lastSeenAt: "2026-04-12T13:00:00.000Z",
              salience: 0.81,
              evidenceRefs: ["trace:entity_bob"]
            },
            {
              entityKey: "entity_okay",
              canonicalName: "Okay",
              entityType: "thing",
              disambiguator: null,
              domainHint: "workflow",
              aliases: ["Okay"],
              firstSeenAt: "2026-04-12T13:00:00.000Z",
              lastSeenAt: "2026-04-12T13:00:00.000Z",
              salience: 0.88,
              evidenceRefs: ["trace:entity_okay", "trace:entity_okay_2"]
            }
          ],
          edges: []
        }
      })
    );

    await access(path.join(vaultPath, "AgentBigBrain", "10 Entities", "Bob.md"));
    await assert.rejects(() =>
      access(path.join(vaultPath, "AgentBigBrain", "10 Entities", "Okay.md"))
    );
    await access(path.join(vaultPath, "AgentBigBrain", "40 Review Actions", "operator-note.md"));
    await assert.rejects(() =>
      access(path.join(vaultPath, "AgentBigBrain", "10 Entities", "Detroit.md"))
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObsidianVaultSink serializes overlapping writes to the same vault root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-serialized-"));
  try {
    const vaultPath = path.join(tempDir, "vault");
    const firstSink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });
    const secondSink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });
    const entityChangeSet = buildProjectionChangeSet(
      ["entity_graph_changed"],
      ["entity_graph:test"]
    );

    await Promise.all([
      firstSink.rebuild(buildProjectionSnapshotFixture()),
      secondSink.sync(entityChangeSet, buildProjectionSnapshotFixture()),
      firstSink.sync(entityChangeSet, buildProjectionSnapshotFixture()),
      secondSink.rebuild(buildProjectionSnapshotFixture())
    ]);

    const rootPath = path.join(vaultPath, "AgentBigBrain");
    const relativePaths = await collectRelativeFilePaths(rootPath);

    await access(path.join(rootPath, "00 Dashboard.md"));
    assert.equal(relativePaths.some((relativePath) => relativePath.includes(".tmp-")), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObsidianVaultSink does not swallow active vault filesystem failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-write-failure-"));
  try {
    const vaultPath = path.join(tempDir, "vault-file");
    await writeFile(vaultPath, "not a directory", "utf8");
    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });

    await assert.rejects(() => sink.rebuild(buildProjectionSnapshotFixture()));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObsidianVaultSink mirrors skill notes as review-only projection artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-skills-"));
  try {
    const vaultPath = path.join(tempDir, "vault");
    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });

    await sink.rebuild(buildProjectionSnapshotFixture({
      skillProjectionEntries: [
        {
          name: "document-reading",
          kind: "markdown_instruction",
          origin: "builtin",
          description: "Read documents generically.",
          userSummary: "Document reading guidance.",
          tags: ["document"],
          invocationHints: ["Use document reading guidance."],
          verificationStatus: "unverified",
          lifecycleStatus: "active",
          memoryPolicy: "candidate_only",
          projectionPolicy: "review_safe_excerpt",
          contentMode: "review_safe_excerpt",
          projectedContent: "Use source labels and avoid assuming one document shape."
        }
      ]
    }));

    const note = await readFile(
      path.join(vaultPath, "AgentBigBrain", "32 Skills", "document-reading.md"),
      "utf8"
    );
    assert.match(note, /Projection lane: governed skill review mirror/);
    assert.match(note, /review_safe_excerpt/);
    assert.match(note, /Use source labels/);
    assert.match(note, /never runtime authority/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObsidianVaultSink keeps duplicate canonical entities distinct and explains continuity-only notes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-entities-"));
  try {
    const vaultPath = path.join(tempDir, "vault");
    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });

    await sink.rebuild(buildProjectionSnapshotFixture({
      entityGraph: {
        schemaVersion: "v1",
        updatedAt: "2026-04-12T14:00:00.000Z",
        entities: [
          {
            entityKey: "entity_billy_person_123456",
            canonicalName: "Billy",
            entityType: "person",
            disambiguator: null,
            domainHint: "relationship",
            aliases: ["Billy"],
            firstSeenAt: "2026-04-12T14:00:00.000Z",
            lastSeenAt: "2026-04-12T14:00:00.000Z",
            salience: 0.91,
            evidenceRefs: ["trace:billy_person"]
          },
          {
            entityKey: "entity_billy_thing_654321",
            canonicalName: "Billy",
            entityType: "thing",
            disambiguator: null,
            domainHint: "relationship",
            aliases: ["Billy"],
            firstSeenAt: "2026-04-12T14:00:00.000Z",
            lastSeenAt: "2026-04-12T14:00:00.000Z",
            salience: 3.2,
            evidenceRefs: ["trace:billy_thing_1", "trace:billy_thing_2", "trace:billy_thing_3"]
          }
        ],
        edges: [
          {
            edgeKey: "edge_billy_pair",
            sourceEntityKey: "entity_billy_person_123456",
            targetEntityKey: "entity_billy_thing_654321",
            relationType: "co_mentioned",
            status: "uncertain",
            coMentionCount: 1,
            strength: 0.21,
            firstObservedAt: "2026-04-12T14:00:00.000Z",
            lastObservedAt: "2026-04-12T14:00:00.000Z",
            evidenceRefs: ["trace:edge_billy_pair"]
          }
        ]
      }
    }));

    const personPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "10 Entities",
      "Billy (person, relationship, 123456).md"
    );
    const thingPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "10 Entities",
      "Billy (thing, relationship, 654321).md"
    );

    await access(thingPath);

    const personNote = await readFile(personPath, "utf8");
    assert.match(personNote, /Projection lane: Stage 6\.86 continuity entity graph/);
    assert.match(personNote, /No current profile-memory claims are directly aligned to this continuity entity right now\./);
    assert.match(personNote, /Current Temporal Claims/);
    assert.match(personNote, /Continuity Evidence Refs/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function collectRelativeFilePaths(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const childPaths = await collectRelativeFilePaths(absolutePath);
      results.push(...childPaths.map((childPath) => path.join(entry.name, childPath)));
      continue;
    }
    if (entry.isFile()) {
      results.push(entry.name);
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

test("ObsidianVaultSink aligns current-surface contact claims onto continuity person and org notes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-current-surface-"));
  try {
    const vaultPath = path.join(tempDir, "vault");
    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });

    await sink.rebuild(buildProjectionSnapshotFixture({
      entityGraph: {
        schemaVersion: "v1",
        updatedAt: "2026-04-12T18:00:00.000Z",
        entities: [
          {
            entityKey: "entity_billy",
            canonicalName: "Billy",
            entityType: "person",
            disambiguator: null,
            domainHint: "relationship",
            aliases: ["Billy"],
            firstSeenAt: "2026-04-12T18:00:00.000Z",
            lastSeenAt: "2026-04-12T18:00:00.000Z",
            salience: 1.2,
            evidenceRefs: ["trace:billy"]
          },
          {
            entityKey: "entity_crimson",
            canonicalName: "Crimson Analytics",
            entityType: "org",
            disambiguator: null,
            domainHint: "relationship",
            aliases: ["Crimson Analytics"],
            firstSeenAt: "2026-04-12T18:00:00.000Z",
            lastSeenAt: "2026-04-12T18:00:00.000Z",
            salience: 1.0,
            evidenceRefs: ["trace:crimson"]
          }
        ],
        edges: []
      },
      currentSurfaceClaims: [
        createSchemaEnvelopeV1(
          "ProfileMemoryGraphClaimV1",
          {
            claimId: "claim_billy_work",
            stableRefId: "stable_contact_billy",
            family: "contact.organization_association",
            normalizedKey: "contact.billy.work_association",
            normalizedValue: "Crimson Analytics",
            sensitive: false,
            sourceTaskId: "task_billy",
            sourceFingerprint: "fingerprint_billy_work",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-12T18:00:00.000Z",
            validFrom: "2026-04-12T18:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "day",
            timeSource: "user_stated",
            derivedFromObservationIds: ["obs_billy_work"],
            projectionSourceIds: ["projection_billy_work"],
            entityRefIds: [],
            active: true
          },
          "2026-04-12T18:00:00.000Z"
        )
      ],
      resolvedCurrentClaims: []
    }));

    const billyNote = await readFile(
      path.join(vaultPath, "AgentBigBrain", "10 Entities", "Billy.md"),
      "utf8"
    );
    const crimsonNote = await readFile(
      path.join(vaultPath, "AgentBigBrain", "10 Entities", "Crimson Analytics.md"),
      "utf8"
    );

    assert.match(billyNote, /Current temporal claims: 1/);
    assert.match(billyNote, /contact\.organization_association: Crimson Analytics/);
    assert.match(crimsonNote, /Current temporal claims: 1/);
    assert.match(crimsonNote, /contact\.organization_association: Crimson Analytics/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObsidianVaultSink projects retained profile-memory subjects even when the continuity graph is empty", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-obsidian-sink-profile-subjects-"));
  try {
    const vaultPath = path.join(tempDir, "vault");
    const runtimeAssetPath = path.join(tempDir, "filing.pdf");
    await writeFile(runtimeAssetPath, "synthetic filing", "utf8");
    const sink = new ObsidianVaultSink({
      vaultPath,
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    });

    const profileMemory = createEmptyProfileMemoryState();
    profileMemory.updatedAt = "2026-04-12T17:50:51.000Z";
    profileMemory.facts = [
      {
        id: "fact_billy_name",
        key: "contact.billy.name",
        value: "Billy",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_billy",
        source: "test.seed",
        observedAt: "2026-04-12T17:35:42.000Z",
        confirmedAt: "2026-04-12T17:35:42.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_billy_work",
        key: "contact.billy.work_association",
        value: "Crimson Analytics",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_billy",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_billy_context",
        key: "contact.billy.context.old_work",
        value: "Billy is no longer at Sample Web Studio",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_billy",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_billy_context_corktown",
        key: "contact.billy.context.corktown",
        value: "I met Billy at the Corktown office on March 2",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_billy",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_garrett_name",
        key: "contact.garrett.name",
        value: "Garrett",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_garrett",
        source: "test.seed",
        observedAt: "2026-04-12T17:35:42.000Z",
        confirmedAt: "2026-04-12T17:35:42.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_billy_location",
        key: "contact.billy.location_association",
        value: "Ferndale",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_billy",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_garrett_org",
        key: "contact.garrett.organization_association",
        value: "Harbor Signal Studio",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_garrett",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_garrett_primary_location",
        key: "contact.garrett.primary_location_association",
        value: "Detroit",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_garrett",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_garrett_secondary_location",
        key: "contact.garrett.secondary_location_association",
        value: "Ann Arbor",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_garrett",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_garrett_harbor",
        key: "contact.garrett.context.harbor",
        value: "Garrett still owns Harbor Signal Studio",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_garrett",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      },
      {
        id: "fact_garrett_places",
        key: "contact.garrett.context.places",
        value: "Garrett is still splitting time between Detroit and Ann Arbor",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_garrett",
        source: "test.seed",
        observedAt: "2026-04-12T17:38:58.000Z",
        confirmedAt: "2026-04-12T17:38:58.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-12T17:38:58.000Z"
      }
    ];

    await sink.rebuild(buildProjectionSnapshotFixture({
      profileMemory,
      mediaArtifacts: [
        {
          artifactId: "media_artifact_filing",
          provider: "telegram",
          sourceSurface: "telegram_interface",
          kind: "document",
          recordedAt: "2026-04-12T18:05:00.000Z",
          sourceConversationKey: "telegram:test:user",
          sourceUserId: "user_test",
          fileId: "file_filing",
          fileUniqueId: "file_filing_unique",
          mimeType: "application/pdf",
          fileName: "filing.pdf",
          sizeBytes: 18,
          caption: null,
          durationSeconds: null,
          width: null,
          height: null,
          checksumSha256: "filing_sha",
          ownedAssetPath: runtimeAssetPath,
          assetFileName: "media_artifact_filing.pdf",
          derivedMeaning: {
            summary: "Filing naming ACME SAMPLE DESIGN, LLC",
            transcript: null,
            ocrText: "ACME SAMPLE DESIGN, LLC 123456789",
            entityHints: ["ACME SAMPLE DESIGN, LLC", "123456789"]
          }
        }
      ],
      entityGraph: {
        schemaVersion: "v1",
        updatedAt: "2026-04-12T17:50:51.000Z",
        entities: [],
        edges: []
      }
    }));

    const dashboard = await readFile(
      path.join(vaultPath, "AgentBigBrain", "00 Dashboard.md"),
      "utf8"
    );
    const billyNotePath = path.join(
      vaultPath,
      "AgentBigBrain",
      "11 Profile Subjects",
      "Billy.md"
    );
    const garrettNotePath = path.join(
      vaultPath,
      "AgentBigBrain",
      "11 Profile Subjects",
      "Garrett.md"
    );
    const sampleStudioConceptPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "15 Concepts",
      "Sample Web Studio.md"
    );
    const crimsonConceptPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "15 Concepts",
      "Crimson Analytics.md"
    );
    const corktownConceptPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "15 Concepts",
      "Corktown.md"
    );
    const harborConceptPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "15 Concepts",
      "Harbor Signal Studio.md"
    );
    const ferndaleConceptPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "15 Concepts",
      "Ferndale.md"
    );
    const detroitConceptPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "15 Concepts",
      "Detroit.md"
    );
    const annArborConceptPath = path.join(
      vaultPath,
      "AgentBigBrain",
      "15 Concepts",
      "Ann Arbor.md"
    );
    const billyNote = await readFile(billyNotePath, "utf8");
    const garrettNote = await readFile(garrettNotePath, "utf8");
    const sampleStudioConceptNote = await readFile(sampleStudioConceptPath, "utf8");
    const mediaArtifactNote = await readFile(
      path.join(
        vaultPath,
        "AgentBigBrain",
        "22 Media Artifacts",
        "2026-04-12 filing.pdf.md"
      ),
      "utf8"
    );

    assert.match(dashboard, /Profile subjects: 2/);
    assert.match(dashboard, /Derived concepts: 8/);
    assert.match(dashboard, /Compatibility profile facts: 11/);
    assert.match(dashboard, /\[\[11 Profile Subjects\/Billy\|Billy\]\]/);
    assert.match(dashboard, /\[\[15 Concepts\/Crimson Analytics\|Crimson Analytics\]\]/);
    assert.match(dashboard, /\[\[15 Concepts\/Harbor Signal Studio\|Harbor Signal Studio\]\]/);
    assert.match(dashboard, /\[\[15 Concepts\/Ann Arbor\|Ann Arbor\]\]/);
    assert.match(dashboard, /\[\[15 Concepts\/Ferndale\|Ferndale\]\]/);
    assert.match(billyNote, /Projection lane: retained profile-memory compatibility facts/);
    assert.match(billyNote, /Work Association: Crimson Analytics/);
    assert.match(billyNote, /Location Association: Ferndale/);
    assert.match(billyNote, /Billy is no longer at Sample Web Studio/);
    assert.match(billyNote, /\[\[15 Concepts\/Sample Web Studio\|Sample Web Studio\]\]/);
    assert.match(billyNote, /\[\[15 Concepts\/Crimson Analytics\|Crimson Analytics\]\]/);
    assert.match(billyNote, /\[\[15 Concepts\/Ferndale\|Ferndale\]\]/);
    assert.match(billyNote, /\[\[15 Concepts\/Corktown\|Corktown\]\]/);
    assert.match(garrettNote, /Organization Association: Harbor Signal Studio/);
    assert.match(garrettNote, /Primary Location Association: Detroit/);
    assert.match(garrettNote, /Secondary Location Association: Ann Arbor/);
    assert.match(garrettNote, /\[\[15 Concepts\/Harbor Signal Studio\|Harbor Signal Studio\]\]/);
    assert.match(garrettNote, /\[\[15 Concepts\/Detroit\|Detroit\]\]/);
    assert.match(garrettNote, /\[\[15 Concepts\/Ann Arbor\|Ann Arbor\]\]/);
    assert.match(billyNote, /All Stored Facts/);
    assert.match(sampleStudioConceptNote, /Projection lane: derived concepts from retained facts, context observations, and media hints/);
    assert.doesNotMatch(mediaArtifactNote, /- 123456789/);
    assert.match(mediaArtifactNote, /\[\[15 Concepts\/Acme Sample Design, LLC\|Acme Sample Design, LLC\]\]/);
    await access(crimsonConceptPath);
    await access(corktownConceptPath);
    await access(harborConceptPath);
    await access(ferndaleConceptPath);
    await access(detroitConceptPath);
    await access(annArborConceptPath);
    await assert.rejects(() =>
      access(path.join(vaultPath, "AgentBigBrain", "15 Concepts", "123456789.md"))
    );
    await assert.rejects(() =>
      access(path.join(vaultPath, "AgentBigBrain", "15 Concepts", "Sample Web Studio, LLC.md"))
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
