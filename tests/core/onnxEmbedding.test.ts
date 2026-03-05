/**
 * @fileoverview Tests the real ONNX embedding provider with the all-MiniLM-L6-v2 model.
 *
 * These tests exercise ACTUAL NEURAL NETWORK INFERENCE — not mock/fake embeddings.
 * They verify:
 *   1. The model loads and produces 384-dimensional embeddings
 *   2. Semantically similar sentences have high cosine similarity
 *   3. Semantically different sentences have low cosine similarity
 *   4. The hybrid retrieval path works end-to-end with real embeddings
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cosineSimilarity } from "../../src/core/embeddingProvider";
import { OnnxEmbeddingProvider } from "../../src/core/onnxEmbeddingProvider";
import { SqliteVectorStore } from "../../src/core/vectorStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";

const MODEL_DIR = path.resolve(process.cwd(), "models", "all-MiniLM-L6-v2");
const MODEL_AVAILABLE = existsSync(path.join(MODEL_DIR, "model.onnx")) &&
    existsSync(path.join(MODEL_DIR, "tokenizer.json"));

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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "onnx-embed-test-"));
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

// ==========================================
// Real ONNX Model Tests
// ==========================================

test("ONNX model loads and produces 384-dim embeddings", { skip: !MODEL_AVAILABLE && "ONNX model not downloaded" }, async () => {
    const provider = new OnnxEmbeddingProvider(MODEL_DIR);
    await provider.initialize();

    try {
        const embedding = await provider.embed("Hello world, this is a test.");
        assert.equal(embedding.length, 384, `Expected 384 dimensions, got ${embedding.length}`);
        assert.equal(provider.enabled, true);
        assert.equal(provider.dimension, 384);

        // Verify the embedding is L2-normalized (magnitude ≈ 1.0)
        const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
        assert.ok(
            Math.abs(magnitude - 1.0) < 0.01,
            `Expected L2-normalized (magnitude ~1.0), got ${magnitude}`
        );
    } finally {
        await provider.dispose();
    }
});

test("ONNX provider lazily initializes on first embed call", { skip: !MODEL_AVAILABLE && "ONNX model not downloaded" }, async () => {
    const provider = new OnnxEmbeddingProvider(MODEL_DIR);

    try {
        const embedding = await provider.embed("lazy init should produce a valid vector");
        assert.equal(embedding.length, 384, `Expected 384 dimensions, got ${embedding.length}`);
        assert.equal(provider.enabled, true);
    } finally {
        await provider.dispose();
    }
});

test("semantically similar sentences have high cosine similarity", { skip: !MODEL_AVAILABLE && "ONNX model not downloaded" }, async () => {
    const provider = new OnnxEmbeddingProvider(MODEL_DIR);
    await provider.initialize();

    try {
        // These should be semantically similar
        const embA = await provider.embed("The cat sat on the mat.");
        const embB = await provider.embed("A kitten was resting on the rug.");

        // And this one should be different
        const embC = await provider.embed("JavaScript runtime environments use V8 engines.");

        const simAB = cosineSimilarity(embA, embB);
        const simAC = cosineSimilarity(embA, embC);

        console.log(`  Similarity (cat/kitten): ${simAB.toFixed(4)}`);
        console.log(`  Similarity (cat/javascript): ${simAC.toFixed(4)}`);

        assert.ok(
            simAB > simAC,
            `Cat/kitten similarity (${simAB.toFixed(4)}) should be higher than cat/javascript (${simAC.toFixed(4)})`
        );
        assert.ok(simAB > 0.5, `Semantically similar sentences should have similarity > 0.5, got ${simAB.toFixed(4)}`);
        assert.ok(simAC < 0.5, `Semantically different sentences should have similarity < 0.5, got ${simAC.toFixed(4)}`);
    } finally {
        await provider.dispose();
    }
});

test("governance-related concepts cluster together", { skip: !MODEL_AVAILABLE && "ONNX model not downloaded" }, async () => {
    const provider = new OnnxEmbeddingProvider(MODEL_DIR);
    await provider.initialize();

    try {
        const governance = await provider.embed("The governor council votes on action proposals.");
        const safety = await provider.embed("Hard constraints prevent dangerous operations from executing.");
        const cooking = await provider.embed("Add two cups of flour and mix until smooth.");

        const govSafety = cosineSimilarity(governance, safety);
        const govCooking = cosineSimilarity(governance, cooking);

        console.log(`  Similarity (governance/safety): ${govSafety.toFixed(4)}`);
        console.log(`  Similarity (governance/cooking): ${govCooking.toFixed(4)}`);

        assert.ok(
            govSafety > govCooking,
            `Governance/safety (${govSafety.toFixed(4)}) should cluster tighter than governance/cooking (${govCooking.toFixed(4)})`
        );
    } finally {
        await provider.dispose();
    }
});

test("batch embedding produces correct results", { skip: !MODEL_AVAILABLE && "ONNX model not downloaded" }, async () => {
    const provider = new OnnxEmbeddingProvider(MODEL_DIR);
    await provider.initialize();

    try {
        const texts = [
            "Machine learning improves with more data.",
            "Neural networks require training samples."
        ];

        const batch = await provider.embedBatch(texts);
        assert.equal(batch.length, 2);
        assert.equal(batch[0].length, 384);
        assert.equal(batch[1].length, 384);

        // Both are about ML — should be similar
        const similarity = cosineSimilarity(batch[0], batch[1]);
        console.log(`  Batch ML similarity: ${similarity.toFixed(4)}`);
        assert.ok(similarity > 0.2, `Related ML sentences should have some similarity, got ${similarity.toFixed(4)}`);
    } finally {
        await provider.dispose();
    }
});

// ==========================================
// End-to-End: Real Embedding + Vector Store + Hybrid Retrieval
// ==========================================

test("end-to-end hybrid retrieval with real ONNX embeddings", { skip: !MODEL_AVAILABLE && "ONNX model not downloaded" }, async () => {
    const provider = new OnnxEmbeddingProvider(MODEL_DIR);
    await provider.initialize();

    try {
        await withTempDir(async (tempDir) => {
            const vectorStore = new SqliteVectorStore(path.join(tempDir, "vectors.sqlite"));

            // Store some lesson embeddings directly
            const lessons = [
                { id: "lesson_gov", text: "Governance council requires supermajority voting for approval." },
                { id: "lesson_safety", text: "Hard constraints block dangerous file deletions outside sandbox." },
                { id: "lesson_memory", text: "Semantic memory stores lessons with concept-linked retrieval." },
                { id: "lesson_cooking", text: "The recipe calls for butter, eggs, and all-purpose flour." }
            ];

            for (const lesson of lessons) {
                const embedding = await provider.embed(lesson.text);
                await vectorStore.upsert(lesson.id, embedding);
            }

            // Search for governance-related query
            const queryEmb = await provider.embed("How does the voting system work for governance?");
            const results = await vectorStore.search(queryEmb, 4);

            console.log("  Vector search results:");
            for (const r of results) {
                const label = lessons.find(l => l.id === r.lessonId)?.text.slice(0, 50) ?? "unknown";
                console.log(`    ${r.lessonId}: ${r.similarity.toFixed(4)} — "${label}..."`);
            }

            // Governance lesson should rank above cooking for a governance query
            const govRank = results.findIndex(r => r.lessonId === "lesson_gov");
            const cookRank = results.findIndex(r => r.lessonId === "lesson_cooking");

            assert.ok(
                govRank < cookRank,
                `Governance (rank ${govRank}) should be above cooking (rank ${cookRank}) for governance query`
            );

            // Governance should be in top 2
            assert.ok(
                govRank <= 1,
                `Governance lesson should be in top 2, got rank ${govRank}`
            );
        });
    } finally {
        await provider.dispose();
    }
});
