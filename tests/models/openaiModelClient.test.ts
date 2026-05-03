/**
 * @fileoverview Tests OpenAI model client parsing and error-handling contracts for structured JSON completions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAIModelClient } from "../../src/models/openaiModelClient";
import { StructuredCompletionRequest } from "../../src/models/types";

interface MockResponseOptions {
  ok: boolean;
  status: number;
  statusText?: string;
  payload: unknown;
}

/**
 * Implements `parseRequestBody` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function parseRequestBody(init?: RequestInit): Record<string, unknown> {
  if (!init || typeof init.body !== "string") {
    return {};
  }

  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Implements `collectMissingAdditionalPropertiesFalsePaths` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function collectMissingAdditionalPropertiesFalsePaths(
  schemaNode: unknown,
  currentPath = "$"
): string[] {
  if (!schemaNode || typeof schemaNode !== "object" || Array.isArray(schemaNode)) {
    return [];
  }

  const node = schemaNode as Record<string, unknown>;
  const violations: string[] = [];
  if (node.type === "object" && node.additionalProperties !== false) {
    violations.push(currentPath);
  }

  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        violations.push(
          ...collectMissingAdditionalPropertiesFalsePaths(entry, `${currentPath}.${key}[${index}]`)
        );
      });
      continue;
    }

    if (value && typeof value === "object") {
      violations.push(
        ...collectMissingAdditionalPropertiesFalsePaths(value, `${currentPath}.${key}`)
      );
    }
  }

  return violations;
}

function collectMissingRequiredPropertyPaths(
  schemaNode: unknown,
  currentPath = "$"
): string[] {
  if (!schemaNode || typeof schemaNode !== "object" || Array.isArray(schemaNode)) {
    return [];
  }

  const node = schemaNode as Record<string, unknown>;
  const violations: string[] = [];
  if (
    node.type === "object" &&
    node.properties &&
    typeof node.properties === "object" &&
    !Array.isArray(node.properties)
  ) {
    const propertyKeys = Object.keys(node.properties as Record<string, unknown>);
    const requiredKeys = Array.isArray(node.required)
      ? new Set(node.required.filter((entry): entry is string => typeof entry === "string"))
      : new Set<string>();
    const missing = propertyKeys.filter((key) => !requiredKeys.has(key));
    if (missing.length > 0) {
      violations.push(`${currentPath} -> ${missing.join(",")}`);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        violations.push(...collectMissingRequiredPropertyPaths(entry, `${currentPath}.${key}[${index}]`));
      });
      continue;
    }

    if (value && typeof value === "object") {
      violations.push(...collectMissingRequiredPropertyPaths(value, `${currentPath}.${key}`));
    }
  }

  return violations;
}

/**
 * Implements `buildMockResponse` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMockResponse(options: MockResponseOptions): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText ?? "",
    json: async () => options.payload
  } as Response;
}

/**
 * Implements `buildRequest` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRequest(): StructuredCompletionRequest {
  return {
    model: "gpt-4.1-mini",
    schemaName: "planner_v1",
    systemPrompt: "Return planner JSON.",
    userPrompt: "Plan a safe next step.",
    temperature: 0
  };
}

/**
 * Implements `withMockFetch` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withMockFetch(
  mockImplementation: typeof fetch,
  callback: () => Promise<void>
): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockImplementation;
  try {
    await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

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

test("OpenAIModelClient parses direct JSON content", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
              }
            }
          ]
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      const output = await client.completeJson<{ plannerNotes: string; actions: unknown[] }>(
        buildRequest()
      );

      assert.equal(output.plannerNotes, "ok");
      assert.equal(Array.isArray(output.actions), true);
    }
  );
});

test("OpenAIModelClient extracts JSON object from wrapped text", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "Here is your payload:\n{\"plannerNotes\":\"wrapped\",\"actions\":[]}\nDone."
              }
            }
          ]
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      const output = await client.completeJson<{ plannerNotes: string; actions: unknown[] }>(
        buildRequest()
      );

      assert.equal(output.plannerNotes, "wrapped");
    }
  );
});

test("OpenAIModelClient sends provider-side json_schema contract for known schema names", async () => {
  await withMockFetch(
    (async (_input: unknown, init?: RequestInit) => {
      const requestBody = parseRequestBody(init);
      const responseFormat = requestBody.response_format as
        | { type?: string; json_schema?: { strict?: boolean; name?: string; schema?: unknown } }
        | undefined;

      assert.equal(responseFormat?.type, "json_schema");
      assert.equal(responseFormat?.json_schema?.strict, true);
      assert.equal(responseFormat?.json_schema?.name, "planner_v1");
      assert.equal(
        typeof responseFormat?.json_schema?.schema === "object" &&
        responseFormat?.json_schema?.schema !== null,
        true
      );

      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
              }
            }
          ]
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      await client.completeJson(buildRequest());
    }
  );
});

test("OpenAIModelClient planner schema sets additionalProperties false on every object node", async () => {
  await withMockFetch(
    (async (_input: unknown, init?: RequestInit) => {
      const requestBody = parseRequestBody(init);
      const responseFormat = requestBody.response_format as
        | { type?: string; json_schema?: { strict?: boolean; name?: string; schema?: unknown } }
        | undefined;

      assert.equal(responseFormat?.type, "json_schema");
      assert.equal(responseFormat?.json_schema?.name, "planner_v1");
      const schema = responseFormat?.json_schema?.schema;
      const violations = collectMissingAdditionalPropertiesFalsePaths(schema);
      assert.deepEqual(
        violations,
        [],
        `planner_v1 strict schema has object nodes missing additionalProperties=false: ${violations.join(", ")}`
      );

      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
              }
            }
          ]
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      await client.completeJson(buildRequest());
    }
  );
});

test("OpenAIModelClient planner schema marks every object property as required for strict provider mode", async () => {
  await withMockFetch(
    (async (_input: unknown, init?: RequestInit) => {
      const requestBody = parseRequestBody(init);
      const responseFormat = requestBody.response_format as
        | { type?: string; json_schema?: { name?: string; schema?: unknown } }
        | undefined;

      assert.equal(responseFormat?.type, "json_schema");
      assert.equal(responseFormat?.json_schema?.name, "planner_v1");
      const schema = responseFormat?.json_schema?.schema;
      const violations = collectMissingRequiredPropertyPaths(schema);
      assert.deepEqual(
        violations,
        [],
        `planner_v1 strict schema has object nodes missing required keys for declared properties: ${violations.join("; ")}`
      );

      const plannerSchema = schema as Record<string, unknown>;
      const actionBranches =
        (((plannerSchema.properties as Record<string, unknown>).actions as Record<string, unknown>).items as Record<string, unknown>).anyOf as Array<Record<string, unknown>>;
      const shellActionBranch = actionBranches.find((branch) => {
        const properties = branch.properties as Record<string, unknown> | undefined;
        const typeSchema = properties?.type as Record<string, unknown> | undefined;
        return Array.isArray(typeSchema?.enum) && typeSchema.enum.includes("shell_command");
      });
      const shellParamsBranch = (shellActionBranch?.properties as Record<string, unknown> | undefined)
        ?.params as Record<string, unknown> | undefined;

      assert.ok(shellParamsBranch, "expected shell_command params branch to exist");
      const shellProperties = shellParamsBranch?.properties as Record<string, unknown>;
      const requestedShellKindSchema =
        shellProperties.requestedShellKind as Record<string, unknown>;
      assert.equal(Array.isArray(requestedShellKindSchema.anyOf), true);
      assert.equal(
        (requestedShellKindSchema.anyOf as Array<Record<string, unknown>>).some((entry) =>
          Array.isArray(entry.enum) && (entry.enum as unknown[]).includes("zsh")
        ),
        true
      );
      const cwdSchema = shellProperties.cwd as Record<string, unknown>;
      assert.equal(Array.isArray(cwdSchema.anyOf), true);
      assert.equal(
        (cwdSchema.anyOf as Array<Record<string, unknown>>).some((entry) => entry.type === "null"),
        true
      );

      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
              }
            }
          ]
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      await client.completeJson(buildRequest());
    }
  );
});

test("OpenAIModelClient falls back to json_object for unknown schema names", async () => {
  await withMockFetch(
    (async (_input: unknown, init?: RequestInit) => {
      const requestBody = parseRequestBody(init);
      const responseFormat = requestBody.response_format as { type?: string } | undefined;
      assert.equal(responseFormat?.type, "json_object");

      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"custom\":\"ok\"}"
              }
            }
          ]
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      const output = await client.completeJson<{ custom: string }>({
        ...buildRequest(),
        schemaName: "custom_schema_v1"
      });
      assert.equal(output.custom, "ok");
    }
  );
});

test("OpenAIModelClient strips provider-null placeholders from normalized planner params", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content:
                  "{\"plannerNotes\":\"ok\",\"actions\":[{\"type\":\"shell_command\",\"description\":\"Run the app\",\"params\":{\"command\":\"npm start\",\"cwd\":null,\"workdir\":null,\"requestedShellKind\":null,\"timeoutMs\":null}}]}"
              }
            }
          ]
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      const output = await client.completeJson<{
        plannerNotes: string;
        actions: Array<{ params: Record<string, unknown> }>;
      }>(buildRequest());

      assert.deepEqual(output.actions[0]?.params, { command: "npm start" });
    }
  );
});

test("OpenAIModelClient canonicalizes planner action shape drift before schema validation", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content:
                  "{\"notes\":\"wrapped\",\"action\":{\"action\":\"response\",\"description\":42,\"message\":\"Hello from drift\"}}"
              }
            }
          ]
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      const output = await client.completeJson<{
        plannerNotes: string;
        actions: Array<{ type: string; description: string; params: Record<string, unknown> }>;
      }>(buildRequest());

      assert.equal(output.plannerNotes, "wrapped");
      assert.equal(output.actions.length, 1);
      assert.equal(output.actions[0].type, "respond");
      assert.equal(typeof output.actions[0].description, "string");
      assert.equal(output.actions[0].params.message, "Hello from drift");
    }
  );
});

test("OpenAIModelClient rejects payloads that fail non-planner schema validation", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"approve\":\"yes\",\"reason\":5,\"confidence\":2}"
              }
            }
          ]
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      await assert.rejects(
        () =>
          client.completeJson({
            ...buildRequest(),
            schemaName: "governor_v1"
          }),
        /governor_v1 validation/i
      );
    }
  );
});

test("OpenAIModelClient throws when response is missing content", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {}
            }
          ]
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      await assert.rejects(
        () => client.completeJson(buildRequest()),
        /missing message content/i
      );
    }
  );
});

test("OpenAIModelClient propagates provider error message on non-ok status", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: false,
        status: 429,
        payload: {
          error: {
            message: "Rate limit exceeded."
          }
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      await assert.rejects(
        () => client.completeJson(buildRequest()),
        /rate limit exceeded/i
      );
    }
  );
});

test("OpenAIModelClient throws when no JSON object is present", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "no json payload available"
              }
            }
          ]
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      await assert.rejects(
        () => client.completeJson(buildRequest()),
        /did not contain a json object/i
      );
    }
  );
});

test("OpenAIModelClient times out when provider exceeds configured deadline", async () => {
  await withMockFetch(
    (() => new Promise<Response>(() => {
      // Intentionally unresolved to trigger timeout behavior.
    })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseUrl: "https://mock.local",
        requestTimeoutMs: 10
      });
      await assert.rejects(
        () => client.completeJson(buildRequest()),
        /timed out/i
      );
    }
  );
});

test("OpenAIModelClient resolves abstract routing model labels with default mapping", async () => {
  await withEnv(
    {
      OPENAI_MODEL_LARGE_REASONING: undefined
    },
    async () => {
      let resolvedModel = "";
      await withMockFetch(
        (async (_input: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
          resolvedModel = body.model ?? "";
          return buildMockResponse({
            ok: true,
            status: 200,
            payload: {
              choices: [
                {
                  message: {
                    content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
                  }
                }
              ]
            }
          });
        }) as typeof fetch,
        async () => {
          const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
          await client.completeJson({
            ...buildRequest(),
            model: "large-reasoning-model"
          });
          assert.equal(resolvedModel, "gpt-4.1");
        }
      );
    }
  );
});

test("OpenAIModelClient resolves abstract routing model labels with env override", async () => {
  await withEnv(
    {
      OPENAI_MODEL_LARGE_REASONING: "gpt-4.1-mini"
    },
    async () => {
      let resolvedModel = "";
      await withMockFetch(
        (async (_input: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
          resolvedModel = body.model ?? "";
          return buildMockResponse({
            ok: true,
            status: 200,
            payload: {
              choices: [
                {
                  message: {
                    content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
                  }
                }
              ]
            }
          });
        }) as typeof fetch,
        async () => {
          const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
          await client.completeJson({
            ...buildRequest(),
            model: "large-reasoning-model"
          });
          assert.equal(resolvedModel, "gpt-4.1-mini");
        }
      );
    }
  );
});

test("OpenAIModelClient tracks provider usage tokens and estimated spend", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
              }
            }
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500
          }
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseUrl: "https://mock.local",
        defaultPricing: {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2
        }
      });

      await client.completeJson(buildRequest());
      const usage = client.getUsageSnapshot();
      assert.equal(usage.calls, 1);
      assert.equal(usage.promptTokens, 1000);
      assert.equal(usage.completionTokens, 500);
      assert.equal(usage.totalTokens, 1500);
      assert.equal(usage.estimatedSpendUsd, 0.002);
    }
  );
});

test("OpenAIModelClient applies alias-specific pricing for abstract routed models", async () => {
  await withMockFetch(
    (async () =>
      buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"ok\",\"actions\":[]}"
              }
            }
          ],
          usage: {
            prompt_tokens: 2_000,
            completion_tokens: 1_000,
            total_tokens: 3_000
          }
        }
      })) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseUrl: "https://mock.local",
        defaultPricing: {
          inputPer1MUsd: 0,
          outputPer1MUsd: 0
        },
        aliasPricing: {
          "large-reasoning-model": {
            inputPer1MUsd: 3,
            outputPer1MUsd: 9
          }
        }
      });

      await client.completeJson({
        ...buildRequest(),
        model: "large-reasoning-model"
      });

      const usage = client.getUsageSnapshot();
      // (2000 / 1_000_000 * 3) + (1000 / 1_000_000 * 9) = 0.015
      assert.equal(usage.estimatedSpendUsd, 0.015);
    }
  );
});

test("OpenAIModelClient can use the Responses transport for structured output", async () => {
  await withMockFetch(
    (async (input: unknown, init?: RequestInit) => {
      assert.equal(String(input), "https://mock.local/responses");
      const requestBody = parseRequestBody(init);
      assert.equal(Array.isArray(requestBody.input), true);
      assert.equal(
        ((requestBody.text as { format?: { type?: string } } | undefined)?.format?.type),
        "json_schema"
      );

      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          output_text: "{\"plannerNotes\":\"responses\",\"actions\":[]}",
          usage: {
            input_tokens: 120,
            output_tokens: 40,
            total_tokens: 160
          }
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseUrl: "https://mock.local",
        transportMode: "responses"
      });

      const output = await client.completeJson<{ plannerNotes: string; actions: unknown[] }>({
        ...buildRequest(),
        model: "gpt-5"
      });

      assert.equal(output.plannerNotes, "responses");
      const usage = client.getUsageSnapshot();
      assert.equal(usage.promptTokens, 120);
      assert.equal(usage.completionTokens, 40);
      assert.equal(usage.totalTokens, 160);
    }
  );
});

test("OpenAIModelClient retries once without temperature when provider rejects that parameter", async () => {
  let calls = 0;
  await withMockFetch(
    (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const requestBody = parseRequestBody(init);
      if (calls === 1) {
        assert.equal(requestBody.temperature, 0);
        return buildMockResponse({
          ok: false,
          status: 400,
          payload: {
            error: {
              message: "Unsupported parameter: temperature"
            }
          }
        });
      }

      assert.equal(Object.prototype.hasOwnProperty.call(requestBody, "temperature"), false);
      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"retry-ok\",\"actions\":[]}"
              }
            }
          ]
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({ apiKey: "test-key", baseUrl: "https://mock.local" });
      const output = await client.completeJson<{ plannerNotes: string; actions: unknown[] }>(
        buildRequest()
      );

      assert.equal(output.plannerNotes, "retry-ok");
      assert.equal(calls, 2);
    }
  );
});

test("OpenAIModelClient retries once on the alternate transport when the endpoint is unsupported", async () => {
  let calls = 0;
  await withMockFetch(
    (async (input: unknown) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(String(input), "https://mock.local/responses");
        return buildMockResponse({
          ok: false,
          status: 400,
          payload: {
            error: {
              message: "Responses endpoint is not supported for this model on this endpoint."
            }
          }
        });
      }

      assert.equal(String(input), "https://mock.local/chat/completions");
      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"transport-fallback\",\"actions\":[]}"
              }
            }
          ]
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseUrl: "https://mock.local",
        transportMode: "responses",
        compatibilityStrict: false
      });

      const output = await client.completeJson<{ plannerNotes: string; actions: unknown[] }>({
        ...buildRequest(),
        model: "gpt-4.1-mini"
      });

      assert.equal(output.plannerNotes, "transport-fallback");
      assert.equal(calls, 2);
    }
  );
});

test("OpenAIModelClient can fall back to json_object mode when compatibility fallback is enabled", async () => {
  let calls = 0;
  await withMockFetch(
    (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const requestBody = parseRequestBody(init);
      if (calls === 1) {
        assert.equal((requestBody.response_format as { type?: string }).type, "json_schema");
        return buildMockResponse({
          ok: false,
          status: 400,
          payload: {
            error: {
              message: "response_format json_schema is not supported by this model."
            }
          }
        });
      }

      assert.equal((requestBody.response_format as { type?: string }).type, "json_object");
      return buildMockResponse({
        ok: true,
        status: 200,
        payload: {
          choices: [
            {
              message: {
                content: "{\"plannerNotes\":\"json-object-fallback\",\"actions\":[]}"
              }
            }
          ]
        }
      });
    }) as typeof fetch,
    async () => {
      const client = new OpenAIModelClient({
        apiKey: "test-key",
        baseUrl: "https://mock.local",
        allowJsonObjectCompatibilityFallback: true
      });

      const output = await client.completeJson<{ plannerNotes: string; actions: unknown[] }>(
        buildRequest()
      );

      assert.equal(output.plannerNotes, "json-object-fallback");
      assert.equal(calls, 2);
    }
  );
});
