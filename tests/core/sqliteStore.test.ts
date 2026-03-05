/**
 * @fileoverview Tests shared SQLite helper behavior for path resolution and contention-safe operation sequencing.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveSqlitePath, withSqliteDatabase } from "../../src/core/sqliteStore";

/**
 * Implements `sleep` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

test("resolveSqlitePath normalizes relative and absolute sqlite paths", () => {
  const relativePath = "runtime/ledgers.sqlite";
  const resolvedRelative = resolveSqlitePath(relativePath);
  assert.equal(path.isAbsolute(resolvedRelative), true);

  const absolutePath = path.resolve(process.cwd(), "runtime/custom-ledgers.sqlite");
  const resolvedAbsolute = resolveSqlitePath(absolutePath);
  assert.equal(resolvedAbsolute, absolutePath);
});

test("withSqliteDatabase serializes concurrent same-path writes without lost updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-sqlite-store-"));
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");

  try {
    await withSqliteDatabase(sqlitePath, async (db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS queue_test_counter (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          value INTEGER NOT NULL
        )`
      );
      db.prepare(
        "INSERT OR IGNORE INTO queue_test_counter (id, value) VALUES (1, 0)"
      ).run();
    });

    const updates = Array.from({ length: 25 }, (_value, index) =>
      withSqliteDatabase(sqlitePath, async (db) => {
        db.exec("BEGIN IMMEDIATE;");
        try {
          const row = db
            .prepare("SELECT value FROM queue_test_counter WHERE id = 1")
            .get() as { value: number };
          await sleep(index % 3 === 0 ? 2 : 1);
          db.prepare("UPDATE queue_test_counter SET value = ? WHERE id = 1").run(row.value + 1);
          db.exec("COMMIT;");
        } catch (error) {
          db.exec("ROLLBACK;");
          throw error;
        }
      })
    );

    await Promise.all(updates);

    const finalValue = await withSqliteDatabase(sqlitePath, async (db) => {
      const row = db
        .prepare("SELECT value FROM queue_test_counter WHERE id = 1")
        .get() as { value: number };
      return row.value;
    });
    assert.equal(finalValue, 25);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

