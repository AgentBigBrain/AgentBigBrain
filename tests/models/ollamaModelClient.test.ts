import assert from "node:assert/strict";
import test from "node:test";

import { OllamaModelClient } from "../../src/models/ollamaModelClient";
import type { PlannerModelOutput } from "../../src/models/types";

function buildOllamaResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      message: { content },
      prompt_eval_count: 2,
      eval_count: 3
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

test("OllamaModelClient retries once when local JSON mode returns malformed planner JSON", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: unknown[] = [];
  let callCount = 0;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    callCount += 1;
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
    if (callCount === 1) {
      return buildOllamaResponse('{"plannerNotes":"bad","actions":[{"type":"respond"}');
    }
    return buildOllamaResponse(
      JSON.stringify({
        plannerNotes: "valid retry",
        actions: [
          {
            type: "respond",
            description: "Reply to the user.",
            params: { message: "Done." }
          }
        ]
      })
    );
  };

  try {
    const client = new OllamaModelClient({
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 1_000
    });
    const output = await client.completeJson<PlannerModelOutput>({
      model: "phi4-mini:latest",
      schemaName: "planner_v1",
      systemPrompt: "Return planner JSON.",
      userPrompt: JSON.stringify({ currentUserRequest: "build the page" }),
      temperature: 0
    });

    assert.equal(output.plannerNotes, "valid retry");
    assert.equal(output.actions.length, 1);
    assert.equal(callCount, 2);
    assert.equal(
      (requestBodies[0] as { format?: { type?: string } }).format?.type,
      "object"
    );
    assert.match(
      JSON.stringify(requestBodies[1]),
      /previous response was rejected|valid planner_v1 JSON/i
    );
    assert.deepEqual(client.getUsageSnapshot(), {
      calls: 2,
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
      billingMode: "local",
      estimatedSpendUsd: 0
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaModelClient fails closed when retry output is still malformed", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (): Promise<Response> => {
    callCount += 1;
    return buildOllamaResponse('{"plannerNotes":"bad","actions":[');
  };

  try {
    const client = new OllamaModelClient({
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 1_000
    });
    await assert.rejects(
      client.completeJson<PlannerModelOutput>({
        model: "phi4-mini:latest",
        schemaName: "planner_v1",
        systemPrompt: "Return planner JSON.",
        userPrompt: JSON.stringify({ currentUserRequest: "build the page" }),
        temperature: 0
      }),
      /invalid structured JSON for planner_v1 after 2 attempt/i
    );
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
