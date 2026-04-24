/**
 * @fileoverview Persists full projection snapshots as JSON for swapability proof and non-Obsidian inspection workflows.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../../fileLock";
import type {
  ProjectionChangeSet,
  ProjectionHealth,
  ProjectionSink,
  ProjectionSnapshot
} from "../contracts";

export interface JsonMirrorSinkOptions {
  outputPath: string;
}

export class JsonMirrorSink implements ProjectionSink {
  readonly id = "json";

  /**
   * Initializes the JSON mirror sink.
   *
   * **Why it exists:**
   * The projection contract should prove it is not Obsidian-specific, and a raw JSON sink is the
   * lowest-cost second target for that seam.
   *
   * **What it talks to:**
   * - Uses local sink configuration within this module.
   *
   * @param options - Output-path options for the JSON mirror file.
   */
  constructor(private readonly options: JsonMirrorSinkOptions) {}

  /**
   * Persists one change-driven snapshot update to the JSON mirror.
   *
   * **Why it exists:**
   * The JSON mirror sink does not need fine-grained change logic, so sync can simply persist the
   * latest snapshot using the same code path as a rebuild.
   *
   * **What it talks to:**
   * - Uses `ProjectionSnapshot` from `../contracts`.
   * - Uses local persistence helpers within this module.
   *
   * @param changeSet - Canonical projection change-set.
   * @param snapshot - Projection snapshot associated with the change.
   * @returns Promise resolving after the snapshot file is updated.
   */
  async sync(changeSet: ProjectionChangeSet, snapshot: ProjectionSnapshot): Promise<void> {
    void changeSet;
    await this.persistSnapshot(snapshot);
  }

  /**
   * Persists one full projection snapshot to the JSON mirror file.
   *
   * **Why it exists:**
   * Manual export and rebuild workflows should share one durable JSON path so operators and tests
   * can inspect the complete projection state outside of Obsidian.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../../fileLock`.
   *
   * @param snapshot - Full projection snapshot.
   * @returns Promise resolving after the JSON file is written.
   */
  async rebuild(snapshot: ProjectionSnapshot): Promise<void> {
    await this.persistSnapshot(snapshot);
  }

  /**
   * Reports sink health based on output-path reachability.
   *
   * **Why it exists:**
   * Projection health checks should tell operators whether a target path is at least writable
   * before a rebuild starts.
   *
   * **What it talks to:**
   * - Uses `path.dirname` (import `default`) from `node:path`.
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   *
   * @returns Health result for the JSON sink.
   */
  async healthCheck(): Promise<ProjectionHealth> {
    await mkdir(path.dirname(this.options.outputPath), { recursive: true });
    return {
      healthy: true,
      detail: `JSON mirror ready at ${this.options.outputPath}.`
    };
  }

  /**
   * Writes the full projection snapshot to the configured JSON file.
   *
   * **Why it exists:**
   * Both sync and rebuild use the same persistence path, and a shared helper keeps that file
   * writing logic out of the public sink methods.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `path.dirname` (import `default`) from `node:path`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../../fileLock`.
   *
   * @param snapshot - Full projection snapshot.
   * @returns Promise resolving after the JSON file is written.
   */
  private async persistSnapshot(snapshot: ProjectionSnapshot): Promise<void> {
    await mkdir(path.dirname(this.options.outputPath), { recursive: true });
    await writeFileAtomic(this.options.outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}
