/**
 * @fileoverview Tests model-client backend selection and strict OpenAI-key requirements from environment settings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createModelClientFromEnv } from "../../src/models/createModelClient";

/**
 * Implements `withEnv` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withEnv(
  overrides: Record<string, string | undefined>,
  callback: () => Promise<void>
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("createModelClientFromEnv returns mock backend when backend is configured as mock", async () => {
  await withEnv(
    {
      BRAIN_MODEL_BACKEND: "mock",
      OPENAI_API_KEY: undefined
    },
    async () => {
      const client = createModelClientFromEnv();
      assert.equal(client.backend, "mock");
    }
  );
});

test("createModelClientFromEnv throws when openai key is missing", async () => {
  await withEnv(
    {
      BRAIN_MODEL_BACKEND: "openai_api",
      OPENAI_API_KEY: undefined
    },
    async () => {
      assert.throws(
        () => createModelClientFromEnv(),
        /OPENAI_API_KEY is missing/i
      );
    }
  );
});

test("createModelClientFromEnv returns openai backend when key exists", async () => {
  await withEnv(
    {
      BRAIN_MODEL_BACKEND: "openai_api",
      OPENAI_API_KEY: "test-key"
    },
    async () => {
      const client = createModelClientFromEnv();
      assert.equal(client.backend, "openai_api");
    }
  );
});

test("createModelClientFromEnv preserves legacy openai alias", async () => {
  await withEnv(
    {
      BRAIN_MODEL_BACKEND: "openai",
      OPENAI_API_KEY: "test-key"
    },
    async () => {
      const client = createModelClientFromEnv();
      assert.equal(client.backend, "openai_api");
    }
  );
});

test("createModelClientFromEnv returns ollama backend when configured", async () => {
  await withEnv(
    {
      BRAIN_MODEL_BACKEND: "ollama"
    },
    async () => {
      const client = createModelClientFromEnv();
      assert.equal(client.backend, "ollama");
    }
  );
});

test("createModelClientFromEnv returns codex backend when configured", async () => {
  await withEnv(
    {
      BRAIN_MODEL_BACKEND: "codex_oauth"
    },
    async () => {
      const client = createModelClientFromEnv();
      assert.equal(client.backend, "codex_oauth");
    }
  );
});

test("createModelClientFromEnv fails closed for unsupported backend names", async () => {
  await withEnv(
    {
      BRAIN_MODEL_BACKEND: "mystery_backend"
    },
    async () => {
      assert.throws(
        () => createModelClientFromEnv(),
        /Unsupported BRAIN_MODEL_BACKEND/i
      );
    }
  );
});
