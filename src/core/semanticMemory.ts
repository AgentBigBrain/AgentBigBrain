/**
 * @fileoverview Stores semantic lessons and concept links to support dot-connecting memory retrieval.
 * Supports lesson type tagging (fact/experience/belief) and inverted concept indexing for efficient retrieval.
 */

import { readFile } from "node:fs/promises";

import { MAIN_AGENT_ID, normalizeAgentId } from "./agentIdentity";
import { EmbeddingProvider, normalizeTextForEmbedding } from "./embeddingProvider";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";
import { countLanguageTermOverlap } from "./languageRuntime/languageScoring";
import { extractSemanticConceptTerms } from "./languageRuntime/queryIntentTerms";
import { SqliteVectorStore } from "./vectorStore";

const MAX_LESSONS = 300;
const MIN_LINK_OVERLAP = 2;

export type LessonMemoryType = "fact" | "experience" | "belief";

export interface LessonSignalMetadataV1 {
  schemaVersion: 1;
  source: string;
  category: string;
  confidenceTier: string;
  matchedRuleId: string;
  rulepackVersion: string;
  blockReason: string | null;
}

export interface SemanticLesson {
  id: string;
  text: string;
  sourceTaskId: string | null;
  committedByAgentId: string;
  createdAt: string;
  concepts: string[];
  relatedLessonIds: string[];
  memoryType: LessonMemoryType;
  signalMetadata?: LessonSignalMetadataV1;
}

export interface SemanticMemory {
  lessons: SemanticLesson[];
  conceptIndex: Record<string, string[]>;
}

/**
 * Normalizes concept into a stable shape for `semanticMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for concept so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param token - Token value used for lexical parsing or matching.
 * @returns Resulting string value.
 */
function normalizeConcept(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * Derives concepts from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for concepts in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Ordered collection produced by this step.
 */
function extractConcepts(text: string): string[] {
  return extractSemanticConceptTerms(text).map((token) => normalizeConcept(token));
}

/**
 * Derives overlap from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps `calculate overlap` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Value for left.
 * @param right - Value for right.
 * @returns Computed numeric value.
 */
function calculateOverlap(left: string[], right: string[]): number {
  return countLanguageTermOverlap(left, right);
}

/**
 * Builds lesson for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of lesson consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `normalizeAgentId` (import `normalizeAgentId`) from `./agentIdentity`.
 * - Uses `makeId` (import `makeId`) from `./ids`.
 *
 * @param text - Message/text content processed by this function.
 * @param sourceTaskId - Stable identifier used to reference an entity or record.
 * @param committedByAgentId - Stable identifier used to reference an entity or record.
 * @param memoryType - Value for memory type.
 * @param signalMetadata - Value for signal metadata.
 * @returns Computed `SemanticLesson` result.
 */
function buildLesson(
  text: string,
  sourceTaskId: string | null,
  committedByAgentId: string,
  memoryType: LessonMemoryType = "experience",
  signalMetadata: LessonSignalMetadataV1 | null = null
): SemanticLesson {
  return {
    id: makeId("lesson"),
    text,
    sourceTaskId,
    committedByAgentId: normalizeAgentId(committedByAgentId),
    createdAt: new Date().toISOString(),
    concepts: extractConcepts(text),
    relatedLessonIds: [],
    memoryType,
    signalMetadata: signalMetadata ?? undefined
  };
}

/**
 * Normalizes lesson signal metadata into a stable shape for `semanticMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for lesson signal metadata so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Computed `LessonSignalMetadataV1 | null` result.
 */
function normalizeLessonSignalMetadata(raw: unknown): LessonSignalMetadataV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<LessonSignalMetadataV1>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.source !== "string" ||
    typeof candidate.category !== "string" ||
    typeof candidate.confidenceTier !== "string" ||
    typeof candidate.matchedRuleId !== "string" ||
    typeof candidate.rulepackVersion !== "string"
  ) {
    return null;
  }
  if (candidate.blockReason !== null && typeof candidate.blockReason !== "string") {
    return null;
  }
  return {
    schemaVersion: 1,
    source: candidate.source,
    category: candidate.category,
    confidenceTier: candidate.confidenceTier,
    matchedRuleId: candidate.matchedRuleId,
    rulepackVersion: candidate.rulepackVersion,
    blockReason: candidate.blockReason
  };
}

/**
 * Builds an inverted concept index from an array of lessons.
 * Maps each concept to the IDs of lessons that contain it.
 */
function buildConceptIndex(lessons: SemanticLesson[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const lesson of lessons) {
    for (const concept of lesson.concepts) {
      if (!index[concept]) {
        index[concept] = [];
      }
      if (!index[concept].includes(lesson.id)) {
        index[concept].push(lesson.id);
      }
    }
  }
  return index;
}

/**
 * Adds a lesson's concepts to the inverted index.
 */
function addToConceptIndex(
  index: Record<string, string[]>,
  lesson: SemanticLesson
): void {
  for (const concept of lesson.concepts) {
    if (!index[concept]) {
      index[concept] = [];
    }
    if (!index[concept].includes(lesson.id)) {
      index[concept].push(lesson.id);
    }
  }
}

/**
 * Removes a lesson's ID from all concept index entries.
 * Used during eviction when lessons exceed MAX_LESSONS.
 */
function removeFromConceptIndex(
  index: Record<string, string[]>,
  lessonId: string
): void {
  for (const concept of Object.keys(index)) {
    const ids = index[concept];
    const position = ids.indexOf(lessonId);
    if (position !== -1) {
      ids.splice(position, 1);
      if (ids.length === 0) {
        delete index[concept];
      }
    }
  }
}

/**
 * Coerces a legacy or partially-formed memory structure into the current schema.
 * Handles missing memoryType (defaults to "experience") and missing conceptIndex (rebuilds it).
 */
function coerceLegacyMemory(input: unknown): SemanticMemory {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { lessons: [], conceptIndex: {} };
  }

  const raw = input as { lessons?: unknown; conceptIndex?: unknown };
  if (!Array.isArray(raw.lessons)) {
    return { lessons: [], conceptIndex: {} };
  }

  let lessons: SemanticLesson[];

  if (raw.lessons.every((item) => typeof item === "string")) {
    lessons = (raw.lessons as string[]).map((text) =>
      buildLesson(text, null, MAIN_AGENT_ID)
    );
  } else {
    lessons = raw.lessons
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => {
        const rawLesson = item as Partial<SemanticLesson>;
        const text = typeof rawLesson.text === "string" ? rawLesson.text : "";
        const concepts = Array.isArray(rawLesson.concepts)
          ? rawLesson.concepts.filter((token): token is string => typeof token === "string")
          : extractConcepts(text);
        const relatedLessonIds = Array.isArray(rawLesson.relatedLessonIds)
          ? rawLesson.relatedLessonIds.filter((id): id is string => typeof id === "string")
          : [];
        const memoryType =
          typeof rawLesson.memoryType === "string" &&
            (rawLesson.memoryType === "fact" || rawLesson.memoryType === "experience" || rawLesson.memoryType === "belief")
            ? rawLesson.memoryType
            : "experience";
        const signalMetadata = normalizeLessonSignalMetadata(rawLesson.signalMetadata);
        return {
          id:
            typeof rawLesson.id === "string" && rawLesson.id.trim()
              ? rawLesson.id
              : makeId("lesson"),
          text,
          sourceTaskId:
            typeof rawLesson.sourceTaskId === "string" ? rawLesson.sourceTaskId : null,
          committedByAgentId:
            typeof rawLesson.committedByAgentId === "string"
              ? normalizeAgentId(rawLesson.committedByAgentId)
              : MAIN_AGENT_ID,
          createdAt:
            typeof rawLesson.createdAt === "string"
              ? rawLesson.createdAt
              : new Date().toISOString(),
          concepts,
          relatedLessonIds,
          memoryType,
          signalMetadata: signalMetadata ?? undefined
        } satisfies SemanticLesson;
      })
      .filter((lesson) => lesson.text.trim().length > 0);
  }

  // Rebuild concept index if missing or invalid.
  const conceptIndex =
    raw.conceptIndex && typeof raw.conceptIndex === "object" && !Array.isArray(raw.conceptIndex)
      ? raw.conceptIndex as Record<string, string[]>
      : buildConceptIndex(lessons);

  return { lessons, conceptIndex };
}

export class SemanticMemoryStore {
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly vectorStore: SqliteVectorStore | null;

  /**
   * Initializes `SemanticMemoryStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `EmbeddingProvider` (import `EmbeddingProvider`) from `./embeddingProvider`.
   * - Uses `SqliteVectorStore` (import `SqliteVectorStore`) from `./vectorStore`.
   *
   * @param filePath - Filesystem location used by this operation.
   * @param embeddingProvider - Stable identifier used to reference an entity or record.
   * @param vectorStore - Value for vector store.
   */
  constructor(
    private readonly filePath = "runtime/semantic_memory.json",
    embeddingProvider?: EmbeddingProvider,
    vectorStore?: SqliteVectorStore
  ) {
    this.embeddingProvider = embeddingProvider ?? null;
    this.vectorStore = vectorStore ?? null;
  }

  /**
   * Reads input needed for this execution step.
   *
   * **Why it exists:**
   * Separates input read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to SemanticMemory.
   */
  async load(): Promise<SemanticMemory> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return coerceLegacyMemory(JSON.parse(raw));
    } catch {
      return { lessons: [], conceptIndex: {} };
    }
  }

  /**
   * Persists lesson with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes lesson mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `MAIN_AGENT_ID` (import `MAIN_AGENT_ID`) from `./agentIdentity`.
   * - Uses `normalizeAgentId` (import `normalizeAgentId`) from `./agentIdentity`.
   * - Uses `normalizeTextForEmbedding` (import `normalizeTextForEmbedding`) from `./embeddingProvider`.
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   *
   * @param lessonText - Message/text content processed by this function.
   * @param sourceTaskId - Stable identifier used to reference an entity or record.
   * @param committedByAgentId - Stable identifier used to reference an entity or record.
   * @param memoryType - Value for memory type.
   * @param signalMetadata - Value for signal metadata.
   * @returns Promise resolving to void.
   */
  async appendLesson(
    lessonText: string,
    sourceTaskId: string | null = null,
    committedByAgentId: string = MAIN_AGENT_ID,
    memoryType: LessonMemoryType = "experience",
    signalMetadata: LessonSignalMetadataV1 | null = null
  ): Promise<void> {
    const normalized = lessonText.trim();
    if (!normalized) {
      return;
    }
    let persistedLessonId: string | null = null;
    const evictedLessonIds: string[] = [];

    await withFileLock(this.filePath, async () => {
      const normalizedAgentId = normalizeAgentId(committedByAgentId);
      const memory = await this.load();

      if (
        memory.lessons.some(
          (existing) =>
            existing.text === normalized && existing.committedByAgentId === normalizedAgentId
        )
      ) {
        return;
      }

      const lesson = buildLesson(
        normalized,
        sourceTaskId,
        normalizedAgentId,
        memoryType,
        signalMetadata
      );
      persistedLessonId = lesson.id;
      this.connectLesson(memory.lessons, lesson);
      memory.lessons.push(lesson);
      addToConceptIndex(memory.conceptIndex, lesson);

      // Evict oldest lessons if exceeding cap, maintaining index consistency.
      while (memory.lessons.length > MAX_LESSONS) {
        const evicted = memory.lessons.shift();
        if (evicted) {
          evictedLessonIds.push(evicted.id);
          removeFromConceptIndex(memory.conceptIndex, evicted.id);
        }
      }

      await this.save(memory);
    });

    // Keep vector store consistent with JSON-memory eviction.
    if (this.vectorStore && evictedLessonIds.length > 0) {
      await Promise.all(
        evictedLessonIds.map(async (lessonId) => {
          try {
            await this.vectorStore!.remove(lessonId);
          } catch {
            // Vector cleanup failures are non-fatal; retrieval still falls back to keywords.
          }
        })
      );
    }

    // Embed the new lesson asynchronously (fire-and-forget, non-blocking).
    if (
      this.embeddingProvider &&
      this.embeddingProvider.dimension > 0 &&
      this.vectorStore &&
      persistedLessonId
    ) {
      const embeddingText = normalizeTextForEmbedding(normalized);
      const lessonIdForEmbedding = persistedLessonId;
      this.embeddingProvider.embed(embeddingText).then((embedding) => {
        if (embedding.length > 0) {
          return this.vectorStore!.upsert(lessonIdForEmbedding, embedding);
        }
      }).catch(() => {
        // Embedding failures are non-fatal; keyword retrieval remains available.
      });
    }
  }

  /**
   * Retrieves lessons relevant to a query using the inverted concept index.
   * Optionally filters by memoryType. Falls back to most recent lessons if no concepts match.
   */
  async getRelevantLessons(
    query: string,
    limit = 6,
    memoryType?: LessonMemoryType
  ): Promise<SemanticLesson[]> {
    const memory = await this.load();
    const queryConcepts = extractConcepts(query);

    let candidates = memory.lessons;
    if (memoryType) {
      candidates = candidates.filter((lesson) => lesson.memoryType === memoryType);
    }

    if (queryConcepts.length === 0) {
      return candidates.slice(-limit);
    }

    // --- Keyword path: inverted concept index ---
    const keywordScores = new Map<string, number>();
    for (const concept of queryConcepts) {
      const lessonIds = memory.conceptIndex[concept];
      if (!lessonIds) {
        continue;
      }
      for (const lessonId of lessonIds) {
        keywordScores.set(lessonId, (keywordScores.get(lessonId) ?? 0) + 1);
      }
    }

    // --- Vector path: cosine similarity (when embedding is enabled) ---
    const vectorScores = new Map<string, number>();
    if (
      this.embeddingProvider &&
      this.embeddingProvider.dimension > 0 &&
      this.vectorStore
    ) {
      try {
        const queryEmbedding = await this.embeddingProvider.embed(
          normalizeTextForEmbedding(query)
        );
        if (queryEmbedding.length > 0) {
          const vectorResults = await this.vectorStore.search(queryEmbedding, limit * 3);
          for (const result of vectorResults) {
            vectorScores.set(result.lessonId, result.similarity);
          }
        }
      } catch {
        // Vector search failures are non-fatal; fall through to keyword-only.
      }
    }

    // --- Hybrid scoring: blend keyword and vector scores ---
    const KEYWORD_WEIGHT = 0.6;
    const VECTOR_WEIGHT = 0.4;

    const allCandidateIds = new Set([
      ...keywordScores.keys(),
      ...vectorScores.keys()
    ]);

    if (allCandidateIds.size === 0) {
      return candidates.slice(-limit);
    }

    // Normalize keyword scores to [0, 1]
    const maxKeywordScore = Math.max(1, ...keywordScores.values());

    const candidateSet = memoryType
      ? new Set(candidates.map((lesson) => lesson.id))
      : null;

    const lessonMap = new Map(memory.lessons.map((lesson) => [lesson.id, lesson]));

    const hybridScored: Array<[string, number]> = [];
    for (const id of allCandidateIds) {
      if (candidateSet && !candidateSet.has(id)) continue;
      const kScore = (keywordScores.get(id) ?? 0) / maxKeywordScore;
      const vScore = vectorScores.get(id) ?? 0;
      const blended = KEYWORD_WEIGHT * kScore + VECTOR_WEIGHT * vScore;
      hybridScored.push([id, blended]);
    }

    return hybridScored
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => lessonMap.get(id))
      .filter((lesson): lesson is SemanticLesson => lesson !== undefined);
  }

  /**
   * Starts lesson within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for lesson explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param existingLessons - Value for existing lessons.
   * @param lesson - Value for lesson.
   */
  private connectLesson(existingLessons: SemanticLesson[], lesson: SemanticLesson): void {
    for (const existing of existingLessons) {
      const overlap = calculateOverlap(existing.concepts, lesson.concepts);
      if (overlap < MIN_LINK_OVERLAP) {
        continue;
      }

      if (!existing.relatedLessonIds.includes(lesson.id)) {
        existing.relatedLessonIds.push(lesson.id);
      }
      if (!lesson.relatedLessonIds.includes(existing.id)) {
        lesson.relatedLessonIds.push(existing.id);
      }
    }
  }

  /**
   * Persists input with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes input mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   *
   * @param memory - Value for memory.
   * @returns Promise resolving to void.
   */
  private async save(memory: SemanticMemory): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(memory, null, 2));
  }
}
