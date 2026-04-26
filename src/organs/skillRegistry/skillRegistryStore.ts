/**
 * @fileoverview Persists and lists governed skill manifests for user-facing and planner-facing discovery.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { withFileLock, writeFileAtomic } from "../../core/fileLock";
import type {
  PlannerSkillGuidanceEntry,
  SkillManifest,
  SkillInventoryEntry
} from "./contracts";
import { parseSkillManifest, toSkillInventoryEntry } from "./skillManifest";
import { parseBuiltInMarkdownSkillManifest } from "./skillMarkdownManifest";

const DEFAULT_BUILTIN_MARKDOWN_SKILLS_ROOT = path.resolve(
  process.cwd(),
  "src/organs/skillRegistry/builtinMarkdownSkills"
);
const MAX_PLANNER_GUIDANCE_CHARS = 4_000;

/**
 * Reads and writes skill manifests stored alongside runtime skill artifacts.
 */
export class SkillRegistryStore {
  /**
   * Creates a registry store rooted at the runtime skills directory.
   *
   * @param skillsRoot - Absolute path to the runtime skills directory.
   * @param builtInMarkdownSkillsRoot - Absolute path to source-controlled Markdown skills.
   */
  constructor(
    private readonly skillsRoot: string,
    private readonly builtInMarkdownSkillsRoot: string = DEFAULT_BUILTIN_MARKDOWN_SKILLS_ROOT
  ) {}

  /**
   * Persists one manifest to disk.
   *
   * @param manifest - Manifest to write.
   * @returns Promise resolving when the manifest is durable on disk.
   */
  async saveManifest(manifest: SkillManifest): Promise<void> {
    await mkdir(this.skillsRoot, { recursive: true });
    const manifestPath = path.resolve(path.join(this.skillsRoot, `${manifest.name}.manifest.json`));
    await withFileLock(manifestPath, async () => {
      await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    });
  }

  /**
   * Loads one manifest by skill name.
   *
   * @param skillName - Skill name whose manifest should be read.
   * @returns Parsed manifest or `null` when the manifest is missing/invalid.
   */
  async loadManifest(skillName: string): Promise<SkillManifest | null> {
    const manifestPath = path.resolve(path.join(this.skillsRoot, `${skillName}.manifest.json`));
    try {
      const raw = await readFile(manifestPath, "utf8");
      return parseSkillManifest(JSON.parse(raw));
    } catch {
      return this.loadBuiltInManifest(skillName);
    }
  }

  /**
   * Lists active skills for user-facing inspection surfaces.
   *
   * @returns Sorted inventory entries for active known skills.
   */
  async listAvailableSkills(): Promise<readonly SkillInventoryEntry[]> {
    const manifests = await this.listMergedActiveManifests();
    return [...manifests]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((manifest) => toSkillInventoryEntry(manifest));
  }

  /**
   * Lists active manifests for internal runtime consumers that need policy metadata.
   *
   * @returns Runtime-overridden active manifests.
   */
  async listActiveManifests(): Promise<readonly SkillManifest[]> {
    return this.listMergedActiveManifests();
  }

  /**
   * Lists bounded Markdown guidance skills that match one planner request.
   *
   * @param query - Current user request or planner context.
   * @param limit - Maximum number of guidance entries to expose.
   * @returns Ranked guidance entries with bounded Markdown content.
   */
  async listApplicableGuidance(
    query: string,
    limit = 3
  ): Promise<readonly PlannerSkillGuidanceEntry[]> {
    const normalizedQuery = normalizeGuidanceText(query);
    if (!normalizedQuery) {
      return [];
    }
    const manifests = await this.listMergedActiveManifests();
    const guidanceCandidates: Array<{
      manifest: SkillManifest;
      score: number;
      guidance: string;
    }> = [];
    for (const manifest of manifests) {
      if (manifest.kind !== "markdown_instruction" || !manifest.instructionPath) {
        continue;
      }
      const score = scoreGuidanceManifest(manifest, normalizedQuery);
      if (score <= 0) {
        continue;
      }
      const guidance = await this.readGuidanceMarkdown(manifest.instructionPath);
      if (!guidance) {
        continue;
      }
      guidanceCandidates.push({
        manifest,
        score,
        guidance
      });
    }
    return guidanceCandidates
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.manifest.origin !== right.manifest.origin) {
          return left.manifest.origin === "runtime_user" ? -1 : 1;
        }
        return left.manifest.name.localeCompare(right.manifest.name);
      })
      .slice(0, limit)
      .map(({ manifest, guidance }) => ({
        name: manifest.name,
        origin: manifest.origin,
        description: manifest.description,
        tags: manifest.tags,
        invocationHints: manifest.invocationHints,
        guidance
      }));
  }

  /**
   * Lists runtime and built-in active manifests with runtime names taking precedence.
   *
   * @returns Merged active manifests.
   */
  private async listMergedActiveManifests(): Promise<readonly SkillManifest[]> {
    const merged = new Map<string, SkillManifest>();
    for (const manifest of await this.listBuiltInManifests()) {
      if (manifest.lifecycleStatus === "active") {
        merged.set(manifest.name, manifest);
      }
    }
    for (const manifest of await this.listRuntimeManifests()) {
      if (manifest.lifecycleStatus === "active") {
        merged.set(manifest.name, manifest);
      }
    }
    return [...merged.values()];
  }

  /**
   * Lists manifests stored under the runtime skills directory.
   *
   * @returns Parsed runtime manifests.
   */
  private async listRuntimeManifests(): Promise<readonly SkillManifest[]> {
    try {
      const entries = await readdir(this.skillsRoot, { withFileTypes: true });
      const manifests: SkillManifest[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) {
          continue;
        }
        const manifest = await this.loadManifest(entry.name.replace(/\.manifest\.json$/i, ""));
        if (manifest) {
          manifests.push(manifest);
        }
      }
      return manifests;
    } catch {
      return [];
    }
  }

  /**
   * Lists source-controlled built-in Markdown skill manifests.
   *
   * @returns Parsed built-in manifests.
   */
  private async listBuiltInManifests(): Promise<readonly SkillManifest[]> {
    try {
      const entries = await readdir(this.builtInMarkdownSkillsRoot, { withFileTypes: true });
      const manifests: SkillManifest[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
          continue;
        }
        const instructionPath = path.resolve(
          path.join(this.builtInMarkdownSkillsRoot, entry.name)
        );
        const raw = await readFile(instructionPath, "utf8");
        const manifest = parseBuiltInMarkdownSkillManifest(raw, instructionPath);
        if (manifest) {
          manifests.push(manifest);
        }
      }
      return manifests;
    } catch {
      return [];
    }
  }

  /**
   * Loads one built-in manifest by skill name.
   *
   * @param skillName - Skill name to resolve.
   * @returns Built-in manifest or `null`.
   */
  private async loadBuiltInManifest(skillName: string): Promise<SkillManifest | null> {
    const manifests = await this.listBuiltInManifests();
    return manifests.find((manifest) => manifest.name === skillName) ?? null;
  }

  /**
   * Reads a Markdown instruction file and strips frontmatter.
   *
   * @param instructionPath - Manifest-owned Markdown path.
   * @returns Bounded Markdown guidance body, or `null`.
   */
  private async readGuidanceMarkdown(instructionPath: string): Promise<string | null> {
    try {
      const raw = await readFile(instructionPath, "utf8");
      const body = stripMarkdownFrontmatter(raw).trim();
      if (!body) {
        return null;
      }
      return body.length <= MAX_PLANNER_GUIDANCE_CHARS
        ? body
        : `${body.slice(0, MAX_PLANNER_GUIDANCE_CHARS - 3).trimEnd()}...`;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes text for simple bounded guidance matching.
 *
 * @param value - Raw input.
 * @returns Lowercase searchable text.
 */
function normalizeGuidanceText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Scores one guidance manifest against a normalized query.
 *
 * @param manifest - Candidate Markdown skill manifest.
 * @param normalizedQuery - Lowercase user request.
 * @returns Deterministic relevance score.
 */
function scoreGuidanceManifest(manifest: SkillManifest, normalizedQuery: string): number {
  const fields = [
    manifest.name,
    manifest.description,
    manifest.userSummary,
    ...manifest.tags,
    ...manifest.capabilities,
    ...manifest.invocationHints
  ]
    .join(" ")
    .toLowerCase();
  const terms = fields
    .split(/[^a-z0-9.]+/)
    .filter((term) => term.length >= 3);
  let score = 0;
  for (const term of new Set(terms)) {
    if (normalizedQuery.includes(term)) {
      score += manifest.origin === "runtime_user" ? 3 : 2;
    }
  }
  return score;
}

/**
 * Removes YAML-style frontmatter from Markdown text.
 *
 * @param markdown - Raw Markdown text.
 * @returns Markdown body.
 */
function stripMarkdownFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---")) {
    return normalized;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex < 0) {
    return normalized;
  }
  const bodyStart = normalized.indexOf("\n", endIndex + 4);
  return bodyStart >= 0 ? normalized.slice(bodyStart + 1) : "";
}
