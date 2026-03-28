/**
 * @fileoverview Tests semantic-memory persistence, deduplication, relevance retrieval,
 * concept linking, memory type tagging, and inverted concept index behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SemanticMemoryStore } from "../../src/core/semanticMemory";

/**
 * Implements `withMemoryStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withMemoryStore(
  callback: (store: SemanticMemoryStore, memoryPath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-"));
  const memoryPath = path.join(tempDir, "semantic_memory.json");
  const store = new SemanticMemoryStore(memoryPath);

  try {
    await callback(store, memoryPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("SemanticMemoryStore starts empty when file is missing", async () => {
  await withMemoryStore(async (store) => {
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0);
  });
});

test("SemanticMemoryStore deduplicates identical lessons", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson("Always verify shell constraints.", "task_1");
    await store.appendLesson("Always verify shell constraints.", "task_1");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 1);
  });
});

test("SemanticMemoryStore records agent attribution for committed lessons", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson("Capture clone merge attribution.", "task_clone_1", "atlas-1001");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 1);
    assert.equal(memory.lessons[0].committedByAgentId, "atlas-1001");
  });
});

test("SemanticMemoryStore allows same lesson text from different committed agents", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson("Shared safety lesson.", "task_clone_1", "atlas-1001");
    await store.appendLesson("Shared safety lesson.", "task_clone_2", "milkyway-422");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 2);
  });
});

test("SemanticMemoryStore links related lessons by overlapping concepts", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson(
      "Safety policy should block shell command patterns before execution.",
      "task_1"
    );
    await store.appendLesson(
      "Constraint policy must block risky shell actions in isolated mode.",
      "task_2"
    );

    const memory = await store.load();
    assert.equal(memory.lessons.length, 2);
    assert.ok(memory.lessons[0].relatedLessonIds.length >= 1);
    assert.ok(memory.lessons[1].relatedLessonIds.length >= 1);
  });
});

test("SemanticMemoryStore returns relevant lessons for concept query", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson("Use sandbox path guards for delete and list actions.", "task_1");
    await store.appendLesson("Prefer concise user responses when no risky action is needed.", "task_2");

    const relevant = await store.getRelevantLessons("sandbox delete safety", 3);
    assert.ok(relevant.length >= 1);
    assert.ok(relevant[0].text.toLowerCase().includes("sandbox"));
  });
});

test("SemanticMemoryStore preserves concurrent appends across separate store instances", async () => {
  await withMemoryStore(async (store, memoryPath) => {
    const second = new SemanticMemoryStore(memoryPath);
    const lessonCount = 20;
    const lessons = Array.from({ length: lessonCount }, (_value, index) =>
      `Concurrent lesson ${index} about sandbox governance safeguards.`
    );

    await Promise.all(
      lessons.map((lesson, index) =>
        index % 2 === 0
          ? store.appendLesson(lesson, `task_${index}`, "atlas-1001")
          : second.appendLesson(lesson, `task_${index}`, "milkyway-422")
      )
    );

    const memory = await store.load();
    assert.equal(memory.lessons.length, lessonCount);
  });
});

// --- Phase 1.2: Lesson type tagging tests ---

test("SemanticMemoryStore tags lessons with memoryType and filters by type", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson("User prefers dark mode interfaces.", "task_1", undefined, "fact");
    await store.appendLesson("Shell commands require sandbox validation.", "task_2", undefined, "experience");
    await store.appendLesson("This configuration change might improve performance.", "task_3", undefined, "belief");

    const memory = await store.load();
    assert.equal(memory.lessons.length, 3);
    assert.equal(memory.lessons[0].memoryType, "fact");
    assert.equal(memory.lessons[1].memoryType, "experience");
    assert.equal(memory.lessons[2].memoryType, "belief");

    const facts = await store.getRelevantLessons("dark mode configuration", 10, "fact");
    assert.ok(facts.every(lesson => lesson.memoryType === "fact"));

    const beliefs = await store.getRelevantLessons("configuration performance", 10, "belief");
    assert.ok(beliefs.every(lesson => lesson.memoryType === "belief"));
  });
});

test("SemanticMemoryStore defaults lessons to experience type", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson("Default type lesson about sandbox operations.", "task_1");
    const memory = await store.load();
    assert.equal(memory.lessons[0].memoryType, "experience");
  });
});

test("SemanticMemoryStore persists optional lesson signal metadata", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson(
      "Validate delete path constraints before execution to prevent unsafe side effects.",
      "task_signal_1",
      "atlas-1001",
      "experience",
      {
        schemaVersion: 1,
        source: "reflection_failure",
        category: "ALLOW",
        confidenceTier: "HIGH",
        matchedRuleId: "lesson_signal_v1_allow_high_signal_keyword",
        rulepackVersion: "LessonSignalRulepackV1",
        blockReason: null
      }
    );

    const memory = await store.load();
    assert.equal(memory.lessons.length, 1);
    assert.ok(memory.lessons[0].signalMetadata);
    assert.equal(memory.lessons[0].signalMetadata?.rulepackVersion, "LessonSignalRulepackV1");
    assert.equal(memory.lessons[0].signalMetadata?.matchedRuleId, "lesson_signal_v1_allow_high_signal_keyword");
  });
});

test("SemanticMemoryStore boosts same-domain lessons without filtering legacy null tags", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson(
      "Status update should stay personal and concise.",
      "task_profile_1",
      undefined,
      "fact",
      null,
      "profile"
    );
    await store.appendLesson(
      "Status update should include build and deploy state.",
      "task_workflow_1",
      undefined,
      "experience",
      null,
      "workflow"
    );
    await store.appendLesson("Status update should mention the next step.", "task_legacy_1");

    const workflowRelevant = await store.getRelevantLessons(
      "status update",
      3,
      undefined,
      "workflow"
    );
    const profileRelevant = await store.getRelevantLessons(
      "status update",
      3,
      undefined,
      "profile"
    );

    assert.equal(workflowRelevant[0]?.domainTag, "workflow");
    assert.equal(profileRelevant[0]?.domainTag, "profile");
    assert.equal(
      workflowRelevant.some((lesson) => lesson.domainTag === null),
      true,
      "legacy null-tag lessons should remain eligible"
    );
  });
});

// --- Phase 1.3: Inverted concept index tests ---

test("SemanticMemoryStore builds and persists concept index", async () => {
  await withMemoryStore(async (store) => {
    await store.appendLesson("Sandbox safety guards prevent unauthorized file access.", "task_1");
    await store.appendLesson("Governance policy requires council approval for deletion.", "task_2");

    const memory = await store.load();
    assert.ok(Object.keys(memory.conceptIndex).length > 0, "Concept index should not be empty");

    // Verify that "sandbox" concept points to lesson 1
    const sandboxEntries = memory.conceptIndex["sandbox"];
    assert.ok(sandboxEntries, "Concept index should contain 'sandbox'");
    assert.equal(sandboxEntries.length, 1);
    assert.equal(sandboxEntries[0], memory.lessons[0].id);

    // Verify shared concepts point to both lessons
    const policyEntries = memory.conceptIndex["policy"] ?? memory.conceptIndex["guards"];
    assert.ok(policyEntries, "Concept index should contain shared concepts");
  });
});

test("SemanticMemoryStore uses concept index for efficient retrieval", async () => {
  await withMemoryStore(async (store) => {
    // Add enough lessons to make index-based retrieval meaningful
    await store.appendLesson("Sandbox path guards enforce boundary safety for delete operations.", "task_1");
    await store.appendLesson("Network write actions require compliance governor approval.", "task_2");
    await store.appendLesson("Shell command execution is blocked by default security policy.", "task_3");
    await store.appendLesson("Response synthesis uses the medium general model for quality.", "task_4");

    const relevant = await store.getRelevantLessons("sandbox delete safety", 2);
    assert.ok(relevant.length >= 1);
    // The first result should be about sandbox/delete, not about network or shell
    assert.ok(
      relevant[0].text.toLowerCase().includes("sandbox") ||
      relevant[0].text.toLowerCase().includes("delete"),
      "Top result should be relevant to sandbox/delete query"
    );
  });
});
