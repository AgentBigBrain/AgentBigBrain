/**
 * @fileoverview Embedding provider interface and implementations for local vector-based memory retrieval.
 *
 * Provides two implementations:
 * - NoOpEmbeddingProvider: returns empty vectors, used when embedding is disabled (default)
 * - OnnxEmbeddingProvider: uses onnxruntime-node with a local model file for CPU-based embedding
 *
 * The embedding provider is injected into SemanticMemoryStore for hybrid retrieval. When disabled,
 * the system falls back to pure keyword-based retrieval with zero performance overhead.
 */

export interface EmbeddingProvider {
    /** Returns true if this provider actually computes embeddings (false for NoOp). */
    readonly enabled: boolean;

    /** Returns the embedding dimension for the loaded model (0 for NoOp). */
    readonly dimension: number;

    /** Embeds a single text string into a float32 vector. Returns empty array if disabled. */
    embed(text: string): Promise<number[]>;

    /** Embeds multiple texts in batch. Returns array of float32 vectors. */
    embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * No-op provider used when embedding is disabled. Returns empty vectors with zero overhead.
 * All retrieval falls back to keyword-only mode.
 */
export class NoOpEmbeddingProvider implements EmbeddingProvider {
    readonly enabled = false;
    readonly dimension = 0;

    /**
     * Generates embedding vectors for input.
     *
     * **Why it exists:**
     * Centralizes vectorization behavior for input so retrieval scoring remains consistent.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param _text - Message/text content processed by this function.
     * @returns Ordered collection produced by this step.
     */
    async embed(_text: string): Promise<number[]> {
        return [];
    }

    /**
     * Generates embedding vectors for batch.
     *
     * **Why it exists:**
     * Centralizes vectorization behavior for batch so retrieval scoring remains consistent.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param texts - Message/text content processed by this function.
     * @returns Ordered collection produced by this step.
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        return texts.map(() => []);
    }
}

/**
 * Computes cosine similarity between two vectors. Returns 0 for zero-magnitude vectors.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || a.length === 0) {
        return 0;
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        magnitudeA += a[i] * a[i];
        magnitudeB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
    if (magnitude === 0) {
        return 0;
    }

    return dotProduct / magnitude;
}

/**
 * Normalizes text for embedding: lowercases, strips punctuation, collapses whitespace.
 */
export function normalizeTextForEmbedding(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
