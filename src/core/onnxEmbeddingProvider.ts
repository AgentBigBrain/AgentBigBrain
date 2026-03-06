/**
 * @fileoverview ONNX-based embedding provider using all-MiniLM-L6-v2 for local sentence embeddings.
 *
 * Loads a local ONNX model and HuggingFace tokenizer.json to compute 384-dimensional
 * sentence embeddings entirely on CPU with zero API dependency.
 *
 * Requirements:
 *   - onnxruntime-node (npm dependency)
 *   - models/all-MiniLM-L6-v2/model.onnx (ONNX model file)
 *   - models/all-MiniLM-L6-v2/tokenizer.json (HuggingFace tokenizer config)
 *
 * Usage:
 *   const provider = new OnnxEmbeddingProvider("models/all-MiniLM-L6-v2");
 *   await provider.initialize();
 *   const embedding = await provider.embed("hello world"); // number[384]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EmbeddingProvider } from "./embeddingProvider";
import {
    buildAppleSiliconNodeMismatchMessage,
    detectCurrentAppleSiliconNodeMismatch
} from "./appleSiliconRuntime";

// onnxruntime-node types
interface OnnxTensor {
    data: Float32Array | BigInt64Array;
    dims: number[];
}

interface OnnxInferenceSession {
    run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
    release(): Promise<void>;
}

interface OnnxRuntime {
    InferenceSession: {
        create(modelPath: string): Promise<OnnxInferenceSession>;
    };
    Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => OnnxTensor;
}

// HuggingFace tokenizer.json schema (simplified)
interface TokenizerConfig {
    model: {
        vocab: Record<string, number>;
        type?: string;
    };
    added_tokens?: Array<{
        id: number;
        content: string;
        special: boolean;
    }>;
    truncation?: {
        max_length: number;
    };
}

const DEFAULT_MAX_LENGTH = 128;
const DEFAULT_DIMENSION = 384;
const CLS_TOKEN = "[CLS]";
const SEP_TOKEN = "[SEP]";
const UNK_TOKEN = "[UNK]";
const PAD_TOKEN = "[PAD]";

/**
 * Minimal WordPiece tokenizer that reads a HuggingFace tokenizer.json vocab.
 * Handles: lowercasing, basic splitting, WordPiece subword lookup.
 */
class WordPieceTokenizer {
    private vocab: Map<string, number>;
    private clsId: number;
    private sepId: number;
    private unkId: number;
    private padId: number;
    private maxLength: number;

    /**
     * Initializes `WordPieceTokenizer` with deterministic runtime dependencies.
     *
     * **Why it exists:**
     * Captures required dependencies at initialization time so runtime behavior remains explicit.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param config - Configuration or policy settings applied here.
     */
    constructor(config: TokenizerConfig) {
        this.vocab = new Map(Object.entries(config.model.vocab));
        this.clsId = this.vocab.get(CLS_TOKEN) ?? 101;
        this.sepId = this.vocab.get(SEP_TOKEN) ?? 102;
        this.unkId = this.vocab.get(UNK_TOKEN) ?? 100;
        this.padId = this.vocab.get(PAD_TOKEN) ?? 0;
        this.maxLength = config.truncation?.max_length ?? DEFAULT_MAX_LENGTH;
    }

    /**
     * Tokenizes text into input_ids, attention_mask, and token_type_ids.
     * Matches the BERT tokenization pipeline: [CLS] tokens... [SEP] [PAD]...
     */
    encode(text: string): {
        inputIds: number[];
        attentionMask: number[];
        tokenTypeIds: number[];
    } {
        const tokens = this.wordPieceTokenize(text);

        // Truncate to maxLength - 2 (for [CLS] and [SEP])
        const maxTokens = this.maxLength - 2;
        const truncatedTokens = tokens.slice(0, maxTokens);

        // Build [CLS] + tokens + [SEP]
        const inputIds = [this.clsId];
        for (const token of truncatedTokens) {
            inputIds.push(this.vocab.get(token) ?? this.unkId);
        }
        inputIds.push(this.sepId);

        // Pad to maxLength
        const attentionMask = new Array(inputIds.length).fill(1);
        const tokenTypeIds = new Array(inputIds.length).fill(0);

        while (inputIds.length < this.maxLength) {
            inputIds.push(this.padId);
            attentionMask.push(0);
            tokenTypeIds.push(0);
        }

        return { inputIds, attentionMask, tokenTypeIds };
    }

    /**
     * Splits text into WordPiece tokens using greedy longest-match-first.
     */
    private wordPieceTokenize(text: string): string[] {
        const normalized = text.toLowerCase().replace(/[^\w\s']/g, " ");
        const words = normalized.split(/\s+/).filter(Boolean);
        const result: string[] = [];

        for (const word of words) {
            let remaining = word;
            let isFirst = true;

            while (remaining.length > 0) {
                let matched = false;

                for (let end = remaining.length; end > 0; end--) {
                    const candidate = isFirst ? remaining.slice(0, end) : `##${remaining.slice(0, end)}`;

                    if (this.vocab.has(candidate)) {
                        result.push(candidate);
                        remaining = remaining.slice(end);
                        isFirst = false;
                        matched = true;
                        break;
                    }
                }

                if (!matched) {
                    // Character not in vocab — add [UNK] and skip
                    result.push(UNK_TOKEN);
                    break;
                }
            }
        }

        return result;
    }
}

/**
 * Computes mean pooling over token embeddings, respecting the attention mask.
 * This is how sentence-transformers produces sentence embeddings from token-level output.
 */
function meanPool(
    lastHiddenState: Float32Array,
    attentionMask: number[],
    seqLength: number,
    hiddenSize: number
): number[] {
    const result = new Array(hiddenSize).fill(0);
    let validTokenCount = 0;

    for (let i = 0; i < seqLength; i++) {
        if (attentionMask[i] === 0) continue;
        validTokenCount++;
        for (let j = 0; j < hiddenSize; j++) {
            result[j] += lastHiddenState[i * hiddenSize + j];
        }
    }

    if (validTokenCount > 0) {
        for (let j = 0; j < hiddenSize; j++) {
            result[j] /= validTokenCount;
        }
    }

    // L2 normalize
    let magnitude = 0;
    for (let j = 0; j < hiddenSize; j++) {
        magnitude += result[j] * result[j];
    }
    magnitude = Math.sqrt(magnitude);
    if (magnitude > 0) {
        for (let j = 0; j < hiddenSize; j++) {
            result[j] /= magnitude;
        }
    }

    return result;
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = DEFAULT_DIMENSION;

    private session: OnnxInferenceSession | null = null;
    private tokenizer: WordPieceTokenizer | null = null;
    private ort: OnnxRuntime | null = null;
    private initialized = false;
    private initializationPromise: Promise<void> | null = null;
    private initializationFailed = false;

    /**
     * Indicates whether the provider is ready to serve embeddings immediately.
     *
     * **Why it exists:**
     * Callers often need a cheap readiness check before deciding to initialize or fall back.
     *
     * **What it talks to:**
     * - Reads internal initialization state only.
     *
     * @returns `true` when the tokenizer and ONNX session were initialized successfully.
     */
    get enabled(): boolean {
        return this.initialized;
    }

    /**
     * Initializes `OnnxEmbeddingProvider` with deterministic runtime dependencies.
     *
     * **Why it exists:**
     * Captures required dependencies at initialization time so runtime behavior remains explicit.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param modelDir - Filesystem location used by this operation.
     */
    constructor(private readonly modelDir: string) { }

    /**
     * Loads the ONNX model and tokenizer. Must be called before embed().
     * Idempotent — safe to call multiple times.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initializationFailed) {
            throw new Error("ONNX embedding provider failed to initialize previously.");
        }
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        this.initializationPromise = (async () => {
            const appleSiliconMismatch = detectCurrentAppleSiliconNodeMismatch();
            if (appleSiliconMismatch) {
                throw new Error(
                    buildAppleSiliconNodeMismatchMessage("onnxruntime-node")
                );
            }

            // Dynamic import to avoid hard crash if onnxruntime-node isn't installed
            const ort = (await import("onnxruntime-node")) as unknown as OnnxRuntime;
            this.ort = ort;

            const modelPath = path.resolve(this.modelDir, "model.onnx");
            const tokenizerPath = path.resolve(this.modelDir, "tokenizer.json");

            const tokenizerRaw = await readFile(tokenizerPath, "utf8");
            const tokenizerConfig = JSON.parse(tokenizerRaw) as TokenizerConfig;
            this.tokenizer = new WordPieceTokenizer(tokenizerConfig);

            this.session = await ort.InferenceSession.create(modelPath);
            this.initialized = true;
        })()
            .catch((error) => {
                this.initializationFailed = true;
                throw error;
            })
            .finally(() => {
                this.initializationPromise = null;
            });

        return this.initializationPromise;
    }

    /**
     * Generates embedding vectors for input.
     *
     * **Why it exists:**
     * Centralizes vectorization behavior for input so retrieval scoring remains consistent.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param text - Message/text content processed by this function.
     * @returns Ordered collection produced by this step.
     */
    async embed(text: string): Promise<number[]> {
        if (!this.initialized) {
            try {
                await this.initialize();
            } catch {
                return [];
            }
        }
        if (!this.initialized || !this.session || !this.tokenizer || !this.ort) {
            return [];
        }

        const encoded = this.tokenizer.encode(text);
        const seqLength = encoded.inputIds.length;

        const inputIdsTensor = new this.ort.Tensor(
            "int64",
            BigInt64Array.from(encoded.inputIds.map(BigInt)),
            [1, seqLength]
        );
        const attentionMaskTensor = new this.ort.Tensor(
            "int64",
            BigInt64Array.from(encoded.attentionMask.map(BigInt)),
            [1, seqLength]
        );
        const tokenTypeIdsTensor = new this.ort.Tensor(
            "int64",
            BigInt64Array.from(encoded.tokenTypeIds.map(BigInt)),
            [1, seqLength]
        );

        const results = await this.session.run({
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
            token_type_ids: tokenTypeIdsTensor
        });

        // Model output: last_hidden_state with shape [1, seqLength, 384]
        const outputKey = Object.keys(results).find(
            (k) => results[k].dims.length === 3
        );
        if (!outputKey) {
            throw new Error("ONNX model did not produce a 3D output tensor.");
        }

        const output = results[outputKey];
        const hiddenSize = output.dims[2];

        return meanPool(
            output.data as Float32Array,
            encoded.attentionMask,
            seqLength,
            hiddenSize
        );
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
        // Sequential for now — batch inference with padding can be added later
        const results: number[][] = [];
        for (const text of texts) {
            results.push(await this.embed(text));
        }
        return results;
    }

    /**
     * Releases the ONNX session resources. Call when done embedding.
     */
    async dispose(): Promise<void> {
        if (this.session) {
            await this.session.release();
            this.session = null;
        }
        this.initialized = false;
        this.initializationPromise = null;
        this.initializationFailed = false;
    }
}
