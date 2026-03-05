/**
 * @fileoverview Tests for embeddingProvider, vectorStore, hybrid retrieval in SemanticMemoryStore,
 * execution mode routing, and decomposed module barrel re-exports.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    NoOpEmbeddingProvider,
    cosineSimilarity,
    normalizeTextForEmbedding
} from "../../src/core/embeddingProvider";
import type { EmbeddingProvider } from "../../src/core/embeddingProvider";
import { SqliteVectorStore } from "../../src/core/vectorStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { resolveExecutionMode } from "../../src/core/executionMode";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import type { PlannedAction } from "../../src/core/types";

// --- Helpers ---

/**
 * Implements `sleep` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implements `withTempDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempDir(callback: (tempDir: string) => Promise<void>): Promise<void> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-move-tests-"));
    try {
        await callback(tempDir);
    } finally {
        await sleep(50);
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await rm(tempDir, { recursive: true, force: true });
                return;
            } catch {
                await sleep(attempt * 25);
            }
        }
    }
}

/**
 * A deterministic test embedding provider that returns fixed-dimension vectors
 * based on simple word hashing. NOT a real embedding model — just enough
 * to exercise the hybrid retrieval path.
 */
class TestEmbeddingProvider implements EmbeddingProvider {
    readonly enabled = true;
    readonly dimension = 8;

    /**
     * Implements `embed` behavior within class TestEmbeddingProvider.
     * Interacts with local collaborators through imported modules and typed inputs/outputs.
     */
    async embed(text: string): Promise<number[]> {
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        const vec = new Array(this.dimension).fill(0);
        for (const word of words) {
            for (let i = 0; i < word.length; i++) {
                vec[(word.charCodeAt(i) + i) % this.dimension] += 1;
            }
        }
        // L2 normalize
        const magnitude = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
        if (magnitude > 0) {
            for (let i = 0; i < vec.length; i++) {
                vec[i] /= magnitude;
            }
        }
        return vec;
    }

    /**
     * Implements `embedBatch` behavior within class TestEmbeddingProvider.
     * Interacts with local collaborators through imported modules and typed inputs/outputs.
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map((t) => this.embed(t)));
    }
}

// ==========================================
// Embedding Provider Tests
// ==========================================

test("NoOpEmbeddingProvider returns empty vectors and reports disabled", async () => {
    const provider = new NoOpEmbeddingProvider();
    assert.equal(provider.enabled, false);
    assert.equal(provider.dimension, 0);

    const single = await provider.embed("hello world");
    assert.deepEqual(single, []);

    const batch = await provider.embedBatch(["hello", "world"]);
    assert.equal(batch.length, 2);
    assert.deepEqual(batch[0], []);
    assert.deepEqual(batch[1], []);
});

test("cosineSimilarity returns 1.0 for identical vectors", () => {
    const vec = [1, 2, 3, 4];
    const similarity = cosineSimilarity(vec, vec);
    assert.ok(Math.abs(similarity - 1.0) < 0.0001, `Expected ~1.0, got ${similarity}`);
});

test("cosineSimilarity returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    const similarity = cosineSimilarity(a, b);
    assert.ok(Math.abs(similarity) < 0.0001, `Expected ~0.0, got ${similarity}`);
});

test("cosineSimilarity returns 0 for empty or mismatched vectors", () => {
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity([1, 2], [1]), 0);
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
});

test("normalizeTextForEmbedding strips punctuation and collapses whitespace", () => {
    const result = normalizeTextForEmbedding("Hello, World!  This is   a Test.");
    assert.equal(result, "hello world this is a test");
});

// ==========================================
// Vector Store Tests
// ==========================================

test("SqliteVectorStore upserts and searches by cosine similarity", async () => {
    await withTempDir(async (tempDir) => {
        const store = new SqliteVectorStore(path.join(tempDir, "vectors.sqlite"));

        // Store three embeddings
        await store.upsert("lesson_a", [1, 0, 0, 0]);
        await store.upsert("lesson_b", [0, 1, 0, 0]);
        await store.upsert("lesson_c", [0.9, 0.1, 0, 0]); // similar to lesson_a

        assert.equal(await store.count(), 3);

        // Search for something similar to lesson_a
        const results = await store.search([1, 0, 0, 0], 2);
        assert.equal(results.length, 2);
        assert.equal(results[0].lessonId, "lesson_a");
        assert.ok(results[0].similarity > 0.99, "lesson_a should be most similar");
        assert.equal(results[1].lessonId, "lesson_c");
        assert.ok(results[1].similarity > 0.9, "lesson_c should be second most similar");
    });
});

test("SqliteVectorStore upsertBatch writes multiple embeddings atomically", async () => {
    await withTempDir(async (tempDir) => {
        const store = new SqliteVectorStore(path.join(tempDir, "vectors.sqlite"));

        await store.upsertBatch([
            { lessonId: "l1", embedding: [1, 0] },
            { lessonId: "l2", embedding: [0, 1] },
            { lessonId: "l3", embedding: [0.5, 0.5] }
        ]);

        assert.equal(await store.count(), 3);

        const results = await store.search([1, 0], 3);
        assert.equal(results[0].lessonId, "l1");
    });
});

test("SqliteVectorStore upsert replaces existing embedding", async () => {
    await withTempDir(async (tempDir) => {
        const store = new SqliteVectorStore(path.join(tempDir, "vectors.sqlite"));

        await store.upsert("lesson_x", [1, 0, 0, 0]);
        await store.upsert("lesson_x", [0, 0, 0, 1]); // update

        assert.equal(await store.count(), 1);

        const results = await store.search([0, 0, 0, 1], 1);
        assert.equal(results[0].lessonId, "lesson_x");
        assert.ok(results[0].similarity > 0.99);
    });
});

test("SqliteVectorStore remove deletes embedding", async () => {
    await withTempDir(async (tempDir) => {
        const store = new SqliteVectorStore(path.join(tempDir, "vectors.sqlite"));

        await store.upsert("to_delete", [1, 0]);
        assert.equal(await store.count(), 1);

        await store.remove("to_delete");
        assert.equal(await store.count(), 0);
    });
});

// ==========================================
// Hybrid Retrieval Tests (SemanticMemoryStore)
// ==========================================

test("SemanticMemoryStore with NoOp embedding behaves identically to keyword-only", async () => {
    await withTempDir(async (tempDir) => {
        const store = new SemanticMemoryStore(
            path.join(tempDir, "semantic_memory.json"),
            new NoOpEmbeddingProvider()
        );

        await store.appendLesson("TypeScript governance model enforces safety constraints");
        await store.appendLesson("Python machine learning pipeline for data analysis");
        await store.appendLesson("Governance voting system with supermajority threshold");

        const results = await store.getRelevantLessons("governance safety", 2);
        assert.ok(results.length > 0, "Should find at least one match");
        assert.ok(
            results.some((r) => r.text.includes("governance")),
            "Should find governance-related lesson"
        );
    });
});

test("SemanticMemoryStore with test embedding provider uses hybrid scoring", async () => {
    await withTempDir(async (tempDir) => {
        const embeddingProvider = new TestEmbeddingProvider();
        const vectorStore = new SqliteVectorStore(path.join(tempDir, "vectors.sqlite"));
        const store = new SemanticMemoryStore(
            path.join(tempDir, "semantic_memory.json"),
            embeddingProvider,
            vectorStore
        );

        // Add lessons — embeddings are fire-and-forget
        await store.appendLesson("Deterministic governance model with hard constraints");
        await store.appendLesson("Machine learning pipeline for prediction accuracy");
        await store.appendLesson("Governor voting requires supermajority for execution");

        // Give fire-and-forget embeds time to complete
        await sleep(200);

        // Keyword retrieval should still work
        const results = await store.getRelevantLessons("governance model constraints", 3);
        assert.ok(results.length > 0, "Should find matches via hybrid retrieval");
    });
});

// ==========================================
// Execution Mode Routing Tests
// ==========================================

test("resolveExecutionMode returns fast_path for respond actions", () => {
    const respondAction: PlannedAction = {
        id: "test_action",
        type: "respond",
        description: "Say hello",
        params: { message: "Hello" },
        estimatedCostUsd: 0
    };

    const mode = resolveExecutionMode(respondAction, DEFAULT_BRAIN_CONFIG);
    assert.equal(mode, "fast_path");
});

test("resolveExecutionMode returns fast_path for write_file actions (non-escalated, non-respond)", () => {
    const writeAction: PlannedAction = {
        id: "test_action",
        type: "write_file",
        description: "Write a file",
        params: {},
        estimatedCostUsd: 0
    };

    const mode = resolveExecutionMode(writeAction, DEFAULT_BRAIN_CONFIG);
    assert.equal(mode, "fast_path");
});

test("resolveExecutionMode returns escalation_path for escalation actions", () => {
    const config = {
        ...DEFAULT_BRAIN_CONFIG,
        governance: {
            ...DEFAULT_BRAIN_CONFIG.governance,
            escalationActionTypes: ["shell_command" as const]
        }
    };

    const shellAction: PlannedAction = {
        id: "test_action",
        type: "shell_command",
        description: "Run a command",
        params: {},
        estimatedCostUsd: 0
    };

    const mode = resolveExecutionMode(shellAction, config);
    assert.equal(mode, "escalation_path");
});

// ==========================================
// Decomposition Barrel Re-export Tests
// ==========================================

test("barrel re-export provides all expected classes from advancedAutonomyRuntime", async () => {
    const barrel = await import("../../src/core/advancedAutonomyRuntime");

    // Verify all major exports are present
    assert.equal(typeof barrel.FederatedDelegationGateway, "function");
    assert.equal(typeof barrel.SatelliteCloneCoordinator, "function");
    assert.equal(typeof barrel.SatelliteIsolationBroker, "function");
    assert.equal(typeof barrel.DistillerMergeLedgerStore, "function");
    assert.equal(typeof barrel.ExecutionReceiptStore, "function");
    assert.equal(typeof barrel.JudgmentPatternStore, "function");
    assert.equal(typeof barrel.deriveJudgmentPatternFromTaskRun, "function");
});

// ==========================================
// Ollama Client Structure Tests
// ==========================================

test("OllamaModelClient has correct backend identifier", async () => {
    const { OllamaModelClient } = await import("../../src/models/ollamaModelClient");
    const client = new OllamaModelClient({
        baseUrl: "http://localhost:11434",
        requestTimeoutMs: 5000
    });

    assert.equal(client.backend, "ollama");

    const usage = client.getUsageSnapshot();
    assert.equal(usage.calls, 0);
    assert.equal(usage.estimatedSpendUsd, 0);
    assert.equal(usage.promptTokens, 0);
});
