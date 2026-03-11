/**
 * @fileoverview Persists and lists governed skill manifests for user-facing and planner-facing discovery.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { withFileLock, writeFileAtomic } from "../../core/fileLock";
import type { SkillManifest, SkillInventoryEntry } from "./contracts";
import { parseSkillManifest, toSkillInventoryEntry } from "./skillManifest";

/**
 * Reads and writes skill manifests stored alongside runtime skill artifacts.
 */
export class SkillRegistryStore {
  /**
   * Creates a registry store rooted at the runtime skills directory.
   *
   * @param skillsRoot - Absolute path to the runtime skills directory.
   */
  constructor(private readonly skillsRoot: string) {}

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
      return null;
    }
  }

  /**
   * Lists active skills for user-facing inspection surfaces.
   *
   * @returns Sorted inventory entries for active known skills.
   */
  async listAvailableSkills(): Promise<readonly SkillInventoryEntry[]> {
    try {
      const entries = await readdir(this.skillsRoot, { withFileTypes: true });
      const manifests: SkillManifest[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) {
          continue;
        }
        const manifest = await this.loadManifest(entry.name.replace(/\.manifest\.json$/i, ""));
        if (manifest && manifest.lifecycleStatus === "active") {
          manifests.push(manifest);
        }
      }
      return manifests
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((manifest) => toSkillInventoryEntry(manifest));
    } catch {
      return [];
    }
  }
}
