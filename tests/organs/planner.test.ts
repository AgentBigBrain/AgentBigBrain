/**
 * @fileoverview Tests planner behavior under strict model-only planning and fail-fast error semantics.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

function lastItem<TItem>(items: readonly TItem[]): TItem | undefined {
  return items[items.length - 1];
}

import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { SqlitePlannerFailureStore } from "../../src/core/plannerFailureStore";
import { Stage685PlaybookPlanningContext } from "../../src/core/stage6_85PlaybookRuntime";
import { JudgmentPattern } from "../../src/core/judgmentPatterns";
import { TaskRequest, WorkflowPattern } from "../../src/core/types";
import {
  ModelClient,
  PlannerModelOutput,
  ResponseSynthesisModelOutput,
  StructuredCompletionRequest
} from "../../src/models/types";
import { buildAutonomousExecutionInput } from "../../src/interfaces/conversationRuntime/managerContracts";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { SkillRegistryStore } from "../../src/organs/skillRegistry/skillRegistryStore";
import {
  HOST_TEST_DESKTOP_DIR,
  HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR,
  HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_INDEX_HTML,
  HOST_TEST_PORTFOLIO_DEMO_DIR
} from "../support/windowsPathFixtures";

class PlannerFailureModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
   * Implements `completeJson` behavior within class PlannerFailureModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(_request: StructuredCompletionRequest): Promise<T> {
    throw new Error("forced planner failure");
  }
}

class RespondWithoutMessageModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly calls: string[] = [];

  /**
   * Implements `getCalls` behavior within class RespondWithoutMessageModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  getCalls(): string[] {
    return this.calls.slice();
  }

  /**
   * Implements `completeJson` behavior within class RespondWithoutMessageModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.calls.push(request.schemaName);

    if (request.schemaName === "planner_v1") {
      const output: PlannerModelOutput = {
        plannerNotes: "model planner result",
        actions: [
          {
            type: "respond",
            description: "Respond to user without explicit message."
          }
        ]
      };
      return output as T;
    }

    if (request.schemaName === "response_v1") {
      const output: ResponseSynthesisModelOutput = {
        message: "hello"
      };
      return output as T;
    }

    throw new Error(`Unexpected schema: ${request.schemaName}`);
  }
}

class InvalidPlannerActionsModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
   * Implements `completeJson` behavior within class InvalidPlannerActionsModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner returned unsupported actions",
      actions: [
        {
          type: "not_a_valid_action",
          description: "invalid action type"
        }
      ]
    } as T;
  }
}

class PlannerRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  /**
   * Implements `getPlannerCallCount` behavior within class PlannerRepairModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
   * Implements `completeJson` behavior within class PlannerRepairModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "invalid planner output on first call"
      } as T;
    }

    return {
      plannerNotes: "repaired output",
      action: {
        type: "response",
        message: "We discussed your recent prompts and my replies."
      }
    } as T;
  }
}

class AliasActionModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly calls: string[] = [];

  /**
   * Implements `getCalls` behavior within class AliasActionModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  getCalls(): string[] {
    return this.calls.slice();
  }

  /**
   * Implements `completeJson` behavior within class AliasActionModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.calls.push(request.schemaName);

    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "alias output",
      actions: [
        {
          type: "response",
          message: "hello from alias"
        }
      ]
    } as T;
  }
}

class PlaybookContextAwareModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerRequest: StructuredCompletionRequest | null = null;

  /**
 * Implements `getPlannerRequest` behavior within class PlaybookContextAwareModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerRequest(): StructuredCompletionRequest | null {
    return this.plannerRequest;
  }

  /**
 * Implements `completeJson` behavior within class PlaybookContextAwareModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }
    this.plannerRequest = request;
    return {
      plannerNotes: "planner output with playbook context",
      actions: [
        {
          type: "respond",
          description: "respond",
          params: {
            message: "playbook-aware response"
          }
        }
      ]
    } as T;
  }
}

class MarkdownGuidedStaticSiteModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerRequest: StructuredCompletionRequest | null = null;

  /**
 * Initializes class MarkdownGuidedStaticSiteModelClient dependencies and runtime state.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  constructor(
    private readonly outputPath: string,
    private readonly expectedGuidanceSnippet: string
  ) {}

  /**
 * Implements `getPlannerRequest` behavior within class MarkdownGuidedStaticSiteModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerRequest(): StructuredCompletionRequest | null {
    return this.plannerRequest;
  }

  /**
 * Implements `completeJson` behavior within class MarkdownGuidedStaticSiteModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerRequest = request;
    assert.match(request.systemPrompt, /Markdown Skill Guidance/i);
    assert.match(request.systemPrompt, /static-site-generation/i);
    assert.match(request.systemPrompt, /single self-contained `index\.html`/i);
    assert.match(request.systemPrompt, new RegExp(this.expectedGuidanceSnippet, "i"));
    assert.match(request.systemPrompt, /use the Markdown body for procedure/i);

    const output: PlannerModelOutput = {
      plannerNotes: "Used Markdown Skill Guidance: static-site-generation.",
      actions: [
        {
          type: "write_file",
          description: "Create a self-contained static HTML page from Markdown guidance.",
          params: {
            path: this.outputPath,
            content: [
              "<!doctype html>",
              "<html lang=\"en\">",
              "<head>",
              "  <meta charset=\"utf-8\">",
              "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
              "  <title>Markdown Guided Static Site</title>",
              "  <style>body{font-family:Arial,sans-serif;margin:2rem;line-height:1.5}</style>",
              "</head>",
              "<body data-build-path=\"markdown-skill-guided\">",
              "  <main>",
              "    <h1>Markdown Guided Static Site</h1>",
              "    <p>This page was planned from reusable Markdown skill guidance.</p>",
              "  </main>",
              "</body>",
              "</html>"
            ].join("\n")
          }
        }
      ]
    };
    return output as T;
  }
}

class MarkdownGuidedFrameworkModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerRequest: StructuredCompletionRequest | null = null;

  /**
 * Initializes class MarkdownGuidedFrameworkModelClient dependencies and runtime state.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  constructor(
    private readonly packageJsonPath: string,
    private readonly expectedFrameworkGuidanceSnippet: string,
    private readonly expectedNextGuidanceSnippet: string
  ) {}

  /**
 * Implements `getPlannerRequest` behavior within class MarkdownGuidedFrameworkModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerRequest(): StructuredCompletionRequest | null {
    return this.plannerRequest;
  }

  /**
 * Implements `completeJson` behavior within class MarkdownGuidedFrameworkModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerRequest = request;
    assert.match(request.systemPrompt, /Markdown Skill Guidance/i);
    assert.match(request.systemPrompt, /framework-generation/i);
    assert.match(request.systemPrompt, /nextjs-generation/i);
    assert.match(request.systemPrompt, new RegExp(this.expectedFrameworkGuidanceSnippet, "i"));
    assert.match(request.systemPrompt, new RegExp(this.expectedNextGuidanceSnippet, "i"));
    assert.match(request.systemPrompt, /use the Markdown body for procedure/i);

    const output: PlannerModelOutput = {
      plannerNotes: "Used Markdown Skill Guidance: framework-generation and nextjs-generation.",
      actions: [
        {
          type: "write_file",
          description: "Create framework package metadata from Markdown guidance.",
          params: {
            path: this.packageJsonPath,
            content: JSON.stringify(
              {
                scripts: {
                  build: "next build",
                  dev: "next dev"
                },
                dependencies: {
                  next: "latest",
                  react: "latest",
                  "react-dom": "latest"
                }
              },
              null,
              2
            )
          }
        }
      ]
    };
    return output as T;
  }
}

class EmptyResponseSynthesisModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
   * Implements `completeJson` behavior within class EmptyResponseSynthesisModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      return {
        plannerNotes: "planner result without respond payload",
        actions: [
          {
            type: "respond",
            description: "respond without message"
          }
        ]
      } as T;
    }

    if (request.schemaName === "response_v1") {
      return {
        message: "   "
      } as T;
    }

    throw new Error(`Unexpected schema: ${request.schemaName}`);
  }
}

class DeterministicInvalidPlannerModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class DeterministicInvalidPlannerModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class DeterministicInvalidPlannerModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    return {
      plannerNotes: "always invalid planner output",
      actions: [
        {
          type: "invalid_action",
          description: "unsupported"
        }
      ]
    } as T;
  }
}

class FailureResetPlannerModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly outcomes: Array<"fail" | "success">;
  private currentOutcome: "fail" | "success" | null = null;
  private plannerCallCount = 0;

  /**
 * Initializes class FailureResetPlannerModelClient dependencies and runtime state.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  constructor(outcomes: Array<"fail" | "success">) {
    this.outcomes = outcomes.slice();
  }

  /**
 * Implements `getPlannerCallCount` behavior within class FailureResetPlannerModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class FailureResetPlannerModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    const isRepairCall = request.userPrompt.includes("\"invalidPlannerOutput\"");
    if (!isRepairCall) {
      this.currentOutcome = this.outcomes.shift() ?? "success";
      if (this.currentOutcome === "success") {
        return {
          plannerNotes: "success output",
          actions: [
            {
              type: "respond",
              message: "success"
            }
          ]
        } as T;
      }
      return {
        plannerNotes: "initial fail output",
        actions: []
      } as T;
    }

    if (this.currentOutcome === "fail") {
      return {
        plannerNotes: "repair still fails",
        actions: []
      } as T;
    }

    throw new Error("Unexpected repair request for success outcome.");
  }
}

class MissingCreateSkillThenRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class MissingCreateSkillThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class MissingCreateSkillThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass incorrectly treated request as conversation-only",
        actions: [
          {
            type: "respond",
            message: "I can help with that."
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair includes required create skill action",
      actions: [
        {
          type: "create_skill",
          description: "Create requested stage6 skill.",
          params: {
            name: "stage6_live_gate",
            code: "export function stage6Gate(input: string): string { return input.trim(); }"
          }
        }
      ]
    } as T;
  }
}

class MissingCreateSkillAfterRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class MissingCreateSkillAfterRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "never emits create_skill",
      actions: [
        {
          type: "respond",
          message: "Still conversational."
        }
      ]
    } as T;
  }
}

class PlaybookContextAwareExecutableModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerRequest: StructuredCompletionRequest | null = null;

  getPlannerRequest(): StructuredCompletionRequest | null {
    return this.plannerRequest;
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }
    this.plannerRequest = request;
    const parsedUserPrompt = JSON.parse(request.userPrompt) as {
      currentUserRequest?: string;
    };
    const currentUserRequest = parsedUserPrompt.currentUserRequest ?? "";

    if (/verify the homepage ui/i.test(currentUserRequest)) {
      return {
        plannerNotes: "planner output with live browser verification actions for prompt inspection",
        actions: [
          {
            type: "shell_command",
            description: "Scaffold the requested React app.",
            params: {
              command: "npm create vite@latest portfolio-demo -- --template react",
              cwd: HOST_TEST_DESKTOP_DIR
            }
          },
          {
            type: "start_process",
            description: "Start the local dev server for live verification.",
            params: {
              command: "npm run dev",
              cwd: HOST_TEST_PORTFOLIO_DEMO_DIR
            }
          },
          {
            type: "probe_http",
            description: "Wait for the local homepage to respond.",
            params: {
              url: "http://127.0.0.1:4173",
              expectedStatus: 200,
              timeoutMs: 5000
            }
          },
          {
            type: "verify_browser",
            description: "Verify the homepage in a browser.",
            params: {
              url: "http://127.0.0.1:4173",
              expectedTitle: "Portfolio Demo",
              expectedText: "Managed process ready",
              timeoutMs: 5000
            }
          }
        ]
      } as T;
    }

    if (/run the app/i.test(currentUserRequest)) {
      return {
        plannerNotes: "planner output with live readiness actions for prompt inspection",
        actions: [
          {
            type: "shell_command",
            description: "Scaffold the requested React app.",
            params: {
              command: "npm create vite@latest portfolio-demo -- --template react",
              cwd: HOST_TEST_DESKTOP_DIR
            }
          },
          {
            type: "start_process",
            description: "Start the local dev server for live verification.",
            params: {
              command: "npm run dev",
              cwd: HOST_TEST_PORTFOLIO_DEMO_DIR
            }
          },
          {
            type: "probe_http",
            description: "Wait for the local homepage to respond.",
            params: {
              url: "http://127.0.0.1:4173",
              expectedStatus: 200,
              timeoutMs: 5000
            }
          }
        ]
      } as T;
    }

    if (/organize the sample-company project folders/i.test(currentUserRequest)) {
      return {
        plannerNotes: "planner output with finite local organization shell move",
        actions: [
          {
            type: "shell_command",
            description: "Create the destination, move matching sample-company folders, and prove the result.",
            params: {
              command: [
                "$destination = Join-Path 'C:\\Users\\testuser\\OneDrive\\Desktop' 'sample-web-projects'",
                "New-Item -ItemType Directory -Path $destination -Force | Out-Null",
                "$moved = Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory -Filter 'sample-company*' | Where-Object { $_.Name -ne 'sample-web-projects' }",
                "$moved | Move-Item -Destination $destination -Force",
                "$destContents = Get-ChildItem -Path $destination -Directory | Select-Object -ExpandProperty Name",
                "$rootRemaining = Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory -Filter 'sample-company*' | Where-Object { $_.Name -ne 'sample-web-projects' } | Select-Object -ExpandProperty Name",
                "Write-Output ('MOVED_TO_DEST=' + (($moved | Select-Object -ExpandProperty Name) -join ','))",
                "Write-Output ('DEST_CONTENTS=' + ($destContents -join ','))",
                "Write-Output ('ROOT_REMAINING_MATCHES=' + ($rootRemaining -join ','))"
              ].join('; ')
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "planner output with executable action for prompt inspection",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the requested workspace.",
          params: {
            command: "npm create vite@latest portfolio-demo -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        }
      ]
    } as T;
  }
}

class ExecutionStyleBuildRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass incorrectly responded with guidance only",
        actions: [
          {
            type: "respond",
            message: "Here are the steps you can follow manually."
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair emits executable build step",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the requested React app.",
          params: {
            command: "npm create vite@latest portfolio-demo -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        }
      ]
    } as T;
  }
}

class FailingIfCalledDesktopRuntimeSweepModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      this.plannerCallCount += 1;
    }
    throw new Error("Planner model should not be called for eager deterministic desktop runtime process sweep fallback.");
  }
}

class InspectionOnlyBuildRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass only inspected the workspace",
        actions: [
          {
            type: "list_directory",
            description: "Inspect the target workspace.",
            params: {
              path: HOST_TEST_DESKTOP_DIR
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair emits concrete build action",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the requested React app.",
          params: {
            command: "npm create vite@latest portfolio-demo -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        }
      ]
    } as T;
  }
}

class InspectionOnlyBuildFailureModelClient implements ModelClient {
  readonly backend = "mock" as const;

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner keeps returning inspection-only actions",
      actions: [
        {
          type: "list_directory",
          description: "Inspect the target workspace.",
          params: {
            path: HOST_TEST_DESKTOP_DIR
          }
        }
      ]
    } as T;
  }
}

class LiveVerificationRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;
  private readonly plannerRequests: StructuredCompletionRequest[] = [];

  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  getPlannerRequests(): readonly StructuredCompletionRequest[] {
    return this.plannerRequests.slice();
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    this.plannerRequests.push(request);
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass only planned finite build work",
        actions: [
          {
            type: "shell_command",
            description: "Scaffold the requested React app.",
            params: {
              command: "npm create vite@latest portfolio-demo -- --template react",
              cwd: HOST_TEST_DESKTOP_DIR
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair adds live verification proof",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the requested React app.",
          params: {
            command: "npm create vite@latest portfolio-demo -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        },
        {
          type: "start_process",
          description: "Start the local dev server.",
          params: {
            command: "npm run dev",
            cwd: HOST_TEST_PORTFOLIO_DEMO_DIR
          }
        },
        {
          type: "probe_http",
          description: "Wait for the local homepage to respond.",
          params: {
            url: "http://127.0.0.1:4173",
            expectedStatus: 200,
            timeoutMs: 5000
          }
        }
      ]
    } as T;
  }
}

class BrowserVerificationFailureModelClient implements ModelClient {
  readonly backend = "mock" as const;

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner omits verify_browser despite explicit UI verification request",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the requested React app.",
          params: {
            command: "npm create vite@latest portfolio-demo -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        },
        {
          type: "start_process",
          description: "Start the local dev server.",
          params: {
            command: "npm run dev",
            cwd: HOST_TEST_PORTFOLIO_DEMO_DIR
          }
        },
        {
          type: "probe_http",
          description: "Wait for the local homepage to respond.",
          params: {
            url: "http://127.0.0.1:4173",
            expectedStatus: 200,
            timeoutMs: 5000
          }
        }
      ]
    } as T;
  }
}

class ExecutionStyleBuildRespondOnlyModelClient implements ModelClient {
  readonly backend = "mock" as const;

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner never emits executable action",
      actions: [
        {
          type: "respond",
          message: "You can run the scaffolding command yourself."
        }
      ]
    } as T;
  }
}

class MissingRunSkillThenRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class MissingRunSkillThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class MissingRunSkillThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass incorrectly responded conversationally",
        actions: [
          {
            type: "respond",
            message: "The requested skill appears unavailable."
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair includes required run_skill action",
      actions: [
        {
          type: "run_skill",
          description: "Run requested skill.",
          params: {
            name: "non_existent_skill",
            input: "smoke probe"
          }
        }
      ]
    } as T;
  }
}

class MissingRunSkillAfterRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class MissingRunSkillAfterRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "never emits run_skill",
      actions: [
        {
          type: "respond",
          message: "The requested skill is unavailable."
        }
      ]
    } as T;
  }
}

class MissingVerifyBrowserThenRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class MissingVerifyBrowserThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class MissingVerifyBrowserThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass drifted into file mutation",
        actions: [
          {
            type: "write_file",
            description: "Rewrite the homepage file.",
            params: {
              path: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_INDEX_HTML,
              content: "<title>Playwright Proof Smoke</title>"
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair includes explicit browser proof",
      actions: [
        {
          type: "verify_browser",
          description: "Verify the homepage UI in a real browser.",
          params: {
            url: "http://localhost:8000",
            expectedTitle: "Playwright Proof Smoke",
            expectedText: "Browser proof works"
          }
        }
      ]
    } as T;
  }
}

class MissingVerifyBrowserAfterRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class MissingVerifyBrowserAfterRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "never emits verify_browser",
      actions: [
        {
          type: "write_file",
          description: "Rewrite the homepage file.",
          params: {
            path: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_INDEX_HTML,
            content: "<title>Playwright Proof Smoke</title>"
          }
        }
      ]
    } as T;
  }
}

class MissingStartProcessThenRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class MissingStartProcessThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class MissingStartProcessThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass drifted into file mutation",
        actions: [
          {
            type: "write_file",
            description: "Create the homepage file.",
            params: {
              path: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_INDEX_HTML,
              content: "<title>Playwright Proof Smoke</title>"
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair includes explicit managed-process start",
      actions: [
        {
          type: "start_process",
          description: "Start the local HTTP server.",
          params: {
            command: "python -m http.server 8000",
            cwd: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR
          }
        }
      ]
    } as T;
  }
}

class MissingFrameworkScaffoldThenRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass drifted into source-file writes only",
        actions: [
          {
            type: "write_file",
            description: "Write the React source entry file.",
            params: {
              path: path.join(HOST_TEST_PORTFOLIO_DEMO_DIR, "src", "App.jsx"),
              content: "export default function App() { return <main>Sample City</main>; }"
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair includes a real scaffold-capable toolchain step",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the requested React app.",
          params: {
            command: "npm create vite@latest portfolio-demo -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        }
      ]
    } as T;
  }
}

class NonInPlaceFrameworkScaffoldThenRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "first pass tries to recreate the named folder from the Desktop root",
        actions: [
          {
            type: "shell_command",
            description: "Scaffold or reuse the React app.",
            params: {
              command: [
                `$desktop = '${HOST_TEST_DESKTOP_DIR}'`,
                "$app = Join-Path $desktop 'Sample City'",
                "if (!(Test-Path (Join-Path $app 'package.json'))) {",
                "  Set-Location $desktop",
                "  npm create vite@latest 'Sample City' -- --template react",
                "}",
                "Set-Location $app",
                "npm install"
              ].join("; ")
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair scaffolds in place inside the exact requested folder",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold or repair the React app in place.",
          params: {
            command: [
              `$app = '${HOST_TEST_PORTFOLIO_DEMO_DIR}'`,
              "if (!(Test-Path (Join-Path $app 'package.json'))) {",
              "  Set-Location $app",
              "  npm create vite@latest . -- --template react",
              "}",
              "Set-Location $app",
              "npm install"
            ].join("; ")
          }
        }
      ]
    } as T;
  }
}

class TrackedArtifactEditPreviewModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    return {
      plannerNotes: "edit the tracked artifact and reopen the same local preview",
      actions: [
        {
          type: "write_file",
          description: "Update the tracked landing page artifact.",
          params: {
            path: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
            content: "<section class=\"hero-slider\">updated</section>"
          }
        },
        {
          type: "open_browser",
          description: "Reopen the same local file preview after the edit.",
          params: {
            url: "file:///C:/Users/testuser/Desktop/sample-company/index.html"
          }
        }
      ]
    } as T;
  }
}

class CheckProcessRecoveryModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class CheckProcessRecoveryModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner returns explicit check_process recovery action",
      actions: [
        {
          type: "check_process",
          description: "Inspect the managed process lease.",
          params: {
            leaseId: "proc_recovery_1"
          }
        }
      ]
    } as T;
  }
}

class NonExplicitRunSkillThenRepairModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class NonExplicitRunSkillThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class NonExplicitRunSkillThenRepairModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    this.plannerCallCount += 1;
    if (this.plannerCallCount === 1) {
      return {
        plannerNotes: "non-explicit run_skill output",
        actions: [
          {
            type: "run_skill",
            description: "Run a random skill.",
            params: {
              name: "random_skill"
            }
          }
        ]
      } as T;
    }

    return {
      plannerNotes: "repair output with respond action",
      actions: [
        {
          type: "respond",
          message: "I can outline a deterministic plan without running a skill."
        }
      ]
    } as T;
  }
}

class NonExplicitRunSkillOnlyModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private plannerCallCount = 0;
  private responseCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class NonExplicitRunSkillOnlyModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `getResponseCallCount` behavior within class NonExplicitRunSkillOnlyModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getResponseCallCount(): number {
    return this.responseCallCount;
  }

  /**
 * Implements `completeJson` behavior within class NonExplicitRunSkillOnlyModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      this.plannerCallCount += 1;
      return {
        plannerNotes: "planner returned non-explicit run_skill only output",
        actions: [
          {
            type: "run_skill",
            description: "Run workflow skill.",
            params: {
              name: "workflow_skill"
            }
          }
        ]
      } as T;
    }

    if (request.schemaName === "response_v1") {
      this.responseCallCount += 1;
      return {
        message: "I can continue with a safe response-only plan."
      } as T;
    }

    throw new Error(`Unexpected schema: ${request.schemaName}`);
  }
}

class TopLevelCreateSkillFieldsModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class TopLevelCreateSkillFieldsModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner emits top-level create_skill payload fields",
      actions: [
        {
          type: "create_skill",
          description: "Create requested skill.",
          name: "stage6_live_gate",
          code: "export function stage6_live_gate(input: string): string { return input.trim(); }"
        }
      ]
    } as T;
  }
}

class MissingCreateSkillParamsModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class MissingCreateSkillParamsModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner emitted create_skill without params",
      actions: [
        {
          type: "create_skill",
          description: "Create requested stage6 skill.",
          params: {}
        }
      ]
    } as T;
  }
}

class CommentOnlyCreateSkillCodeModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class CommentOnlyCreateSkillCodeModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "planner_v1") {
      throw new Error(`Unexpected schema: ${request.schemaName}`);
    }

    return {
      plannerNotes: "planner emitted comment-only skill code placeholder",
      actions: [
        {
          type: "create_skill",
          description: "Create requested skill.",
          params: {
            name: "agentic_ai",
            code: "// Skill code to provide information and resources about agentic AI."
          }
        }
      ]
    } as T;
  }
}

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: "task_planner_1",
    agentId: "main-agent",
    goal: "Handle user request safely and efficiently.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Implements `withPlannerClient` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withPlannerClient(
  modelClient: ModelClient,
  callback: (planner: PlannerOrgan) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const planner = new PlannerOrgan(modelClient, memoryStore);
    await callback(planner);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("planner backfills missing respond message using model response synthesis", async () => {
  const modelClient = new RespondWithoutMessageModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask("say hello"), "mock-planner");
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "respond");
    assert.equal(plan.actions[0].params.message, "hello");
  });
  assert.equal(modelClient.getCalls().includes("response_v1"), true);
});

test("planner throws when planner model fails", async () => {
  await withPlannerClient(new PlannerFailureModelClient(), async (planner) => {
    await assert.rejects(
      planner.plan(buildTask("say hello"), "mock-planner"),
      /forced planner failure/i
    );
  });
});

test("planner builds a static site through Markdown skill guidance without deterministic static HTML fallback", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-md-static-site-"));
  try {
    const outputPath = path.join(tempDir, "index.html");
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const expectedGuidanceSnippet = "Keep generated assets inspectable";
    const skillRegistry = new SkillRegistryStore(path.join(tempDir, "runtime-skills"));
    const staticSiteGuidance = await skillRegistry.listApplicableGuidance(
      "Build a simple static html site without a framework or local server.",
      3
    );
    const staticSiteGuidanceEntry = staticSiteGuidance.find(
      (entry) => entry.name === "static-site-generation"
    );
    assert.ok(staticSiteGuidanceEntry);
    assert.equal(staticSiteGuidanceEntry.origin, "builtin");
    assert.match(staticSiteGuidanceEntry.guidance, new RegExp(expectedGuidanceSnippet, "i"));

    const modelClient = new MarkdownGuidedStaticSiteModelClient(
      outputPath,
      expectedGuidanceSnippet
    );
    const planner = new PlannerOrgan(
      modelClient,
      memoryStore,
      undefined,
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4000,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    );

    const plan = await planner.plan(
      buildTask(
        "static_html_build: Build a simple static HTML landing page in " +
          "C:\\Users\\testuser\\Desktop\\Markdown Skill Site as a single self-contained " +
          "index.html. Do not use a framework, dependency install, local server, or browser."
      ),
      "mock-planner",
      "mock-planner",
      {
        skillGuidance: staticSiteGuidance
      }
    );

    assert.ok(modelClient.getPlannerRequest());
    assert.match(plan.plannerNotes ?? "", /Markdown Skill Guidance: static-site-generation/i);
    assert.doesNotMatch(plan.plannerNotes ?? "", /deterministic_static_html_build_fallback/i);

    const writeAction = plan.actions.find((action) => action.type === "write_file");
    assert.ok(writeAction);
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const outcome = await executor.executeWithOutcome(writeAction);
    assert.equal(outcome.status, "success");

    const html = await readFile(outputPath, "utf8");
    assert.match(html, /data-build-path="markdown-skill-guided"/);
    assert.match(html, /planned from reusable Markdown skill guidance/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner fails closed for static HTML requests without model-planned governed actions", async () => {
  await withPlannerClient(new InvalidPlannerActionsModelClient(), async (planner) => {
    await assert.rejects(
      planner.plan(
        buildTask(
          "static_html_build: Build a simple static HTML landing page on my Desktop as " +
            "a single self-contained index.html. Do not use a framework, dependency install, " +
            "local server, or browser."
        ),
        "mock-planner"
      ),
      /Planner model returned no valid actions/i
    );
  });
});

test("planner builds a Next.js app through Markdown skill guidance without framework fallback", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-md-framework-"));
  try {
    const packageJsonPath = path.join(tempDir, "package.json");
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const expectedFrameworkGuidanceSnippet = "Inspect First";
    const expectedNextGuidanceSnippet = "App Router, Pages Router";
    const skillRegistry = new SkillRegistryStore(path.join(tempDir, "runtime-skills"));
    const frameworkGuidance = await skillRegistry.listApplicableGuidance(
      "Build a Next.js framework landing page and prove it with the normal build script.",
      5
    );
    assert.ok(frameworkGuidance.some((entry) => entry.name === "framework-generation"));
    assert.ok(frameworkGuidance.some((entry) => entry.name === "nextjs-generation"));

    const modelClient = new MarkdownGuidedFrameworkModelClient(
      packageJsonPath,
      expectedFrameworkGuidanceSnippet,
      expectedNextGuidanceSnippet
    );
    const planner = new PlannerOrgan(
      modelClient,
      memoryStore,
      undefined,
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4000,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    );

    const plan = await planner.plan(
      buildTask(
        "framework_app_build: Build a Next.js landing page called Markdown Skill Framework " +
          "on my Desktop. Use Next.js conventions, run build proof, and do not open a browser."
      ),
      "mock-planner",
      "mock-planner",
      {
        skillGuidance: frameworkGuidance
      }
    );

    assert.ok(modelClient.getPlannerRequest());
    assert.match(plan.plannerNotes ?? "", /Markdown Skill Guidance: framework-generation and nextjs-generation/i);
    assert.doesNotMatch(plan.plannerNotes ?? "", /deterministic_framework_build_fallback/i);
    assert.equal(plan.actions[0]?.type, "write_file");
    assert.equal(plan.actions[0]?.params.path, packageJsonPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner fails closed instead of generating framework page content when model planning fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-timeout-fallback-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const planner = new PlannerOrgan(
      new PlannerFailureModelClient(),
      memoryStore,
      undefined,
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4000,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    );

    await assert.rejects(
      planner.plan(
        buildTask(
          "Please create a Next.js landing page called Sample City on my Desktop. It should have a flying sample in the hero, feel polished and modern, and work as a single-page landing page. After you finish, start it locally, open it in my browser, and leave it up for me to view."
        ),
        "mock-planner"
      ),
      /forced planner failure/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner fails closed instead of generating framework scaffold actions when model planning fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-workspace-prep-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const planner = new PlannerOrgan(
      new PlannerFailureModelClient(),
      memoryStore,
      undefined,
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4000,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    );

    await assert.rejects(
      planner.plan(
        buildTask(
          "Can you get a new Next.js landing-page workspace started on my desktop and call it Sample City Showcase? Just get the workspace ready for edits with the dependencies installed. Do not run it or open anything yet."
        ),
        "mock-planner"
      ),
      /forced planner failure/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner fails closed for tracked framework content continuations when model planning fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-framework-continuation-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const planner = new PlannerOrgan(
      new PlannerFailureModelClient(),
      memoryStore,
      undefined,
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4000,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    );

    const wrappedInput = [
      "You are in an ongoing conversation with the same user.",
      "Recent conversation context (oldest to newest):",
      "- user: Can you get a new Next.js landing-page workspace started on my desktop and call it Sample City Showcase? Just get the workspace ready for edits with the dependencies installed. Do not run it or open anything yet.",
      "- assistant: I ran the command successfully.",
      "",
      "Current tracked workspace in this chat:",
      "- Root path: C:\\Users\\testuser\\Desktop\\Sample City Showcase",
      "",
      "Current user request:",
      "Great. Now turn that Sample City Showcase workspace into the real landing page. Keep it calm and modern, avoid blue, put a small flying sample in the hero, use four main sections, add a clear call to action and a footer menu, then build it. Stop once the source and build proof are there, but do not run it or open anything yet."
    ].join("\n");

    await assert.rejects(
      planner.plan(buildTask(wrappedInput), "mock-planner"),
      /forced planner failure/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner does not use stale workspace context to generate a fresh autonomous framework page fallback", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-framework-autonomous-fresh-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const planner = new PlannerOrgan(
      new PlannerFailureModelClient(),
      memoryStore,
      undefined,
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4000,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    );

    const wrappedInput = [
      "[AUTONOMOUS_LOOP_GOAL] {",
      "\"goal\":\"I want you to create a nextjs landing page, with 4 sections called \\\"Detroit City\\\" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it. This means you have to run it and leave it open.\",",
      "\"initialExecutionInput\":\"You are in an ongoing conversation with the same user.\\nUse recent context to resolve references like 'another', 'same style', and 'as before'.\\n\\nLatest durable work handoff in this chat:\\n- Status: completed\\n- Goal: Earlier Detroit City run\\n- Summary: The prior run stopped before the preview was usable.\\n\\nCurrent tracked workspace in this chat:\\n- Label: Detroit City workspace\\n- Root path: C:\\\\Users\\\\testuser\\\\Desktop\\\\Detroit City\\n- Preview URL: http://127.0.0.1:3000\\n- Still controllable: no\\n- Ownership state: stale\\n\\nCurrent user request:\\nI want you to create a nextjs landing page, with 4 sections called \\\"Detroit City\\\" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it. This means you have to run it and leave it open.\"",
      "}"
    ].join("");

    await assert.rejects(
      planner.plan(buildTask(wrappedInput), "mock-planner"),
      /forced planner failure/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner throws when planner returns no valid actions", async () => {
  await withPlannerClient(new InvalidPlannerActionsModelClient(), async (planner) => {
    await assert.rejects(
      planner.plan(buildTask("tell me about space"), "mock-planner"),
      /Planner model returned no valid actions/i
    );
  });
});

test("planner throws when response synthesis returns empty message", async () => {
  await withPlannerClient(new EmptyResponseSynthesisModelClient(), async (planner) => {
    await assert.rejects(
      planner.plan(buildTask("say hello"), "mock-planner"),
      /Response synthesis returned an empty message/i
    );
  });
});

test("planner retries once with repair prompt when first output has no usable actions", async () => {
  const modelClient = new PlannerRepairModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask("what have we talked about today?"), "mock-planner");
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "respond");
    assert.equal(plan.actions[0].params.message, "We discussed your recent prompts and my replies.");
    assert.ok(plan.plannerNotes.includes("repair=true"));
  });
});

test("planner normalizes alias action type and top-level message fields", async () => {
  const modelClient = new AliasActionModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask("say hello"), "mock-planner");
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "respond");
    assert.equal(plan.actions[0].params.message, "hello from alias");
  });
  assert.equal(modelClient.getCalls().includes("response_v1"), false);
});

test("planner forwards deterministic stage 6.85 playbook selection context into planner prompts", async () => {
  const modelClient = new PlaybookContextAwareExecutableModelClient();
  const playbookSelection: Stage685PlaybookPlanningContext = {
    selectedPlaybookId: "playbook_stage685_a_build",
    selectedPlaybookName: "Candidate playbook for Build deterministic backup CLI",
    fallbackToPlanner: false,
    reason: "Deterministic playbook match selected from explicit score components.",
    requestedTags: ["build", "cli", "verify"],
    requiredInputSchema: "build_cli_v1",
    registryValidated: true,
    scoreSummary: [
      {
        playbookId: "playbook_stage685_a_build",
        score: 1.107775
      }
    ]
  };

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Build and test a deterministic TypeScript CLI scaffold."),
      "mock-planner",
      "mock-planner",
      {
        playbookSelection
      }
    );
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "shell_command");
  });

  const plannerRequest = modelClient.getPlannerRequest();
  assert.ok(plannerRequest);
  assert.match(plannerRequest.systemPrompt, /deterministic stage 6\.85 playbook match is available/i);
  assert.match(plannerRequest.systemPrompt, /deterministic high-risk action guardrail/i);
  assert.doesNotMatch(plannerRequest.systemPrompt, /do not emit shell_command/i);
  assert.match(plannerRequest.systemPrompt, /do not emit start_process/i);
  assert.match(plannerRequest.systemPrompt, /do not emit .*verify_browser/i);
  assert.match(plannerRequest.systemPrompt, /do not emit .*self_modify/i);

  const parsedUserPrompt = JSON.parse(plannerRequest.userPrompt) as Record<string, unknown>;
  const parsedPlaybookSelection = parsedUserPrompt.playbookSelection as {
    selectedPlaybookId?: string;
    fallbackToPlanner?: boolean;
  };
  assert.equal(parsedPlaybookSelection.selectedPlaybookId, "playbook_stage685_a_build");
  assert.equal(parsedPlaybookSelection.fallbackToPlanner, false);
});

test("planner execution-style build prompts allow finite shell planning without explicit shell-name phrasing", async () => {
  const modelClient = new PlaybookContextAwareExecutableModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Create a React app on my Desktop and execute now."),
      "mock-planner"
    );
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "shell_command");
  });

  const plannerRequest = modelClient.getPlannerRequest();
  assert.ok(plannerRequest);
  assert.match(plannerRequest.systemPrompt, /deterministic high-risk action guardrail/i);
  assert.doesNotMatch(plannerRequest.systemPrompt, /do not emit shell_command/i);
  assert.match(plannerRequest.systemPrompt, /do not emit start_process/i);
  assert.match(plannerRequest.systemPrompt, /do not emit .*verify_browser/i);
  assert.match(plannerRequest.systemPrompt, /do not emit .*self_modify/i);
  assert.match(plannerRequest.systemPrompt, /Execution-style build request detected/i);
  assert.match(
    plannerRequest.systemPrompt,
    /prefer concrete build or proof actions .*write_file.*shell_command.*start_process.*probe_http.*verify_browser/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /Include at least one executable non-respond action and do not replace the plan with guidance-only respond output/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /Read_file, list_directory, check_process, or stop_process do not satisfy this requirement by themselves/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /When you write user-facing text, keep it human-first: plain language first, brief explanation second, and a concrete next step when relevant/i
  );
});

test("planner organization prompts allow finite shell planning without explicit shell-name phrasing", async () => {
  const modelClient = new PlaybookContextAwareExecutableModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask(
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
      ),
      "mock-planner"
    );
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "shell_command");
  });

  const plannerRequest = modelClient.getPlannerRequest();
  assert.ok(plannerRequest);
  assert.doesNotMatch(plannerRequest.systemPrompt, /do not emit shell_command/i);
  assert.match(plannerRequest.systemPrompt, /local workspace-organization goal/i);
  assert.match(
    plannerRequest.systemPrompt,
    /bounded local folder organization, finite shell_command steps are allowed/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /create the destination folder if it is missing, then move only the matching project folders/i
  );
});

test("planner uses deterministic desktop runtime process sweep fallback before model planning for explicit Desktop sample-folder server shutdown requests", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-runtime-sweep-eager-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const modelClient = new FailingIfCalledDesktopRuntimeSweepModelClient();
    const planner = new PlannerOrgan(
      modelClient,
      memoryStore,
      undefined,
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4000,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    );

    const plan = await planner.plan(
      buildTask(
        "Look at all the folders on the desktop that start with sample and Sample, stop the servers that are running in the folders do this end to end"
      ),
      "mock-planner"
    );

    assert.equal(modelClient.getPlannerCallCount(), 0);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0]?.type, "stop_folder_runtime_processes");
    assert.match(
      plan.plannerNotes ?? "",
      /deterministic_desktop_runtime_process_sweep_fallback=stop_folder_runtime_processes/i
    );
    assert.equal(plan.actions[0]?.params.rootPath, "C:\\Users\\testuser\\Desktop");
    assert.equal(plan.actions[0]?.params.selectorMode, "starts_with");
    assert.equal(plan.actions[0]?.params.selectorTerm, "sample");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner live-verification build prompts can allow managed process planning without explicit shell-name phrasing", async () => {
  const modelClient = new PlaybookContextAwareExecutableModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask(
        "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now."
      ),
      "mock-planner"
    );
    assert.equal(plan.actions.some((action) => action.type === "shell_command"), true);
    assert.equal(plan.actions.some((action) => action.type === "start_process"), true);
    assert.equal(plan.actions.some((action) => action.type === "probe_http"), true);
    assert.equal(plan.actions.some((action) => action.type === "verify_browser"), true);
  });

  const plannerRequest = modelClient.getPlannerRequest();
  assert.ok(plannerRequest);
  assert.doesNotMatch(plannerRequest.systemPrompt, /do not emit shell_command/i);
  assert.doesNotMatch(plannerRequest.systemPrompt, /do not emit start_process/i);
  assert.match(plannerRequest.systemPrompt, /Deterministic build-task strategy:/i);
  assert.match(plannerRequest.systemPrompt, /prefer finite proof steps before any live session/i);
  assert.match(
    plannerRequest.systemPrompt,
    /do not use long-running dev-server or watch commands/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /Only use managed-process actions .*start_process\/check_process\/stop_process/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /Use probe_port or probe_http only for loopback-local readiness checks/i
  );
  assert.doesNotMatch(plannerRequest.systemPrompt, /do not emit verify_browser/i);
  assert.match(plannerRequest.systemPrompt, /Live-run verification intent detected/i);
  assert.match(
    plannerRequest.systemPrompt,
    /pair start_process with probe_port or probe_http/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /same plan must contain the local proof chain needed to finish truthfully/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /use verify_browser with params\.url and any available expectedTitle\/expectedText hints/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /instead of claiming the app was running or the UI was verified/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /Repair must include at least one executable non-respond action|Include at least one executable non-respond action/i
  );
  assert.match(
    plannerRequest.systemPrompt,
    /Read_file, list_directory, check_process, or stop_process can support the plan, but they do not satisfy an execution-style build request by themselves/i
  );
});

test("planner repairs execution-style build requests when first plan is guidance-only respond output", async () => {
  const modelClient = new ExecutionStyleBuildRepairModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Create a React app on my Desktop and execute now."),
      "mock-planner"
    );
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "shell_command");
    assert.ok(plan.plannerNotes.includes("repair=true"));
  });
});

test("planner fails closed when execution-style build request never yields an executable action", async () => {
  await withPlannerClient(new ExecutionStyleBuildRespondOnlyModelClient(), async (planner) => {
    await assert.rejects(
      planner.plan(buildTask("Create a React app on my Desktop and execute now."), "mock-planner"),
      /no executable non-respond actions for execution-style build request/i
    );
  });
});

test("planner repairs inspection-only execution-style build requests into concrete execution", async () => {
  const modelClient = new InspectionOnlyBuildRepairModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Create a React app on my Desktop and execute now."),
      "mock-planner"
    );
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "shell_command");
    assert.ok(plan.plannerNotes.includes("repair=true"));
  });
});

test("planner fails closed when execution-style build request only yields inspection-only actions", async () => {
  await withPlannerClient(new InspectionOnlyBuildFailureModelClient(), async (planner) => {
    await assert.rejects(
      planner.plan(buildTask("Create a React app on my Desktop and execute now."), "mock-planner"),
      /inspection-only actions for execution-style build request/i
    );
  });
});

test("planner repairs live-verification build requests that omit live proof actions", async () => {
  const modelClient = new LiveVerificationRepairModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Create a React app on my Desktop, run the app, and tell me if it worked. Execute now."),
      "mock-planner"
    );
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.some((action) => action.type === "start_process"), true);
    assert.equal(plan.actions.some((action) => action.type === "probe_http"), true);
    assert.ok(plan.plannerNotes.includes("repair=true"));
  });

  const repairRequest = modelClient.getPlannerRequests()[1];
  assert.ok(repairRequest);
  assert.match(
    repairRequest.systemPrompt,
    /prior plan failed because it omitted live-verification actions/i
  );
  assert.match(
    repairRequest.systemPrompt,
    /complete local proof chain needed to finish truthfully/i
  );
  assert.match(
    repairRequest.systemPrompt,
    /Do not return helper-file creation by itself as the repaired plan/i
  );
});

test("planner fails closed when explicit browser verification request omits verify_browser", async () => {
  await withPlannerClient(new BrowserVerificationFailureModelClient(), async (planner) => {
    await assert.rejects(
      planner.plan(
        buildTask("Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now."),
        "mock-planner"
      ),
      /no verify_browser action for explicit browser\/UI verification request/i
    );
  });
});

test("planner injects deterministic execution environment block into planner prompts", async () => {
  const modelClient = new PlaybookContextAwareModelClient();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-env-context-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const planner = new PlannerOrgan(modelClient, memoryStore, undefined, {
      platform: "linux",
      shellKind: "bash",
      invocationMode: "inline_command",
      commandMaxChars: 2048,
      desktopPath: "/home/testuser/Desktop",
      documentsPath: "/home/testuser/Documents",
      downloadsPath: "/home/testuser/Downloads"
    });
    await planner.plan(buildTask("Give me a short response."), "mock-planner");

    const plannerRequest = modelClient.getPlannerRequest();
    assert.ok(plannerRequest);
    assert.match(plannerRequest.systemPrompt, /Execution Environment:/i);
    assert.match(plannerRequest.systemPrompt, /platform:\s+linux/i);
    assert.match(plannerRequest.systemPrompt, /shellKind:\s+bash/i);
    assert.match(plannerRequest.systemPrompt, /invocationMode:\s+inline_command/i);
    assert.match(plannerRequest.systemPrompt, /commandMaxChars:\s+2048/i);
    assert.match(plannerRequest.systemPrompt, /must be valid for this shellKind/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner persists first-principles packet and prompt guidance for high-risk requests", async () => {
  const modelClient = new PlaybookContextAwareModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Delete stale production token credentials and remove legacy secret files before deploy."),
      "mock-planner"
    );
    const packet = plan.firstPrinciples;
    assert.ok(packet);
    assert.equal(packet.required, true);
    assert.equal(packet.triggerReasons.some((reason) => reason.startsWith("risk_pattern:")), true);
    assert.ok(packet.rubric);
    assert.equal(packet.validation?.valid, true);
    assert.equal(
      packet.rubric.facts.some((fact) => fact.startsWith("task.goal=")),
      true
    );
  });

  const plannerRequest = modelClient.getPlannerRequest();
  assert.ok(plannerRequest);
  assert.match(plannerRequest.systemPrompt, /First-Principles Rubric \(required\):/i);
  assert.match(plannerRequest.systemPrompt, /triggerReasons:/i);
  assert.match(
    plannerRequest.systemPrompt,
    /Use this rubric as the mandatory planning baseline before emitting actions\./i
  );
});

test("planner keeps first-principles packet optional for low-risk short requests", async () => {
  const modelClient = new PlaybookContextAwareModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask("Say hello."), "mock-planner");
    const packet = plan.firstPrinciples;
    assert.ok(packet);
    assert.equal(packet.required, false);
    assert.deepEqual(packet.triggerReasons, []);
    assert.equal(packet.rubric, null);
    assert.equal(packet.validation, null);
  });

  const plannerRequest = modelClient.getPlannerRequest();
  assert.ok(plannerRequest);
  assert.doesNotMatch(plannerRequest.systemPrompt, /First-Principles Rubric \(required\):/i);
});

test("planner injects only distilled lessons from retrieval quarantine into planner prompts", async () => {
  const modelClient = new PlaybookContextAwareModelClient();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-distilled-lessons-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    await memoryStore.appendLesson(
      "Use deterministic sandbox guards before any risky file side effect.",
      "task_lesson_001"
    );
    const planner = new PlannerOrgan(modelClient, memoryStore);
    const plan = await planner.plan(
      buildTask("Provide a deterministic summary response."),
      "mock-planner"
    );
    assert.equal(plan.actions.length, 1);

    const plannerRequest = modelClient.getPlannerRequest();
    assert.ok(plannerRequest);
    assert.match(plannerRequest.systemPrompt, /Relevant Distilled Lessons:/i);
    assert.doesNotMatch(plannerRequest.systemPrompt, /Relevant Lessons:/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner suppresses quarantined private-range lesson content instead of failing the task", async () => {
  const modelClient = new PlaybookContextAwareModelClient();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-quarantine-block-"));
  try {
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    await memoryStore.appendLesson(
      "Do not send payloads to localhost endpoints because that bypasses network policy.",
      "task_lesson_002"
    );
    const planner = new PlannerOrgan(modelClient, memoryStore);
    const plan = await planner.plan(
      buildTask("Provide a deterministic summary response."),
      "mock-planner"
    );

    assert.equal(plan.actions.length, 1);
    const plannerRequest = modelClient.getPlannerRequest();
    assert.ok(plannerRequest);
    assert.doesNotMatch(plannerRequest.systemPrompt, /Relevant Distilled Lessons:/i);
    assert.doesNotMatch(
      plannerRequest.systemPrompt,
      /Do not send payloads to localhost endpoints because that bypasses network policy\./i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner injects workflow and judgment learning hints into prompt guidance", async () => {
  const modelClient = new PlaybookContextAwareModelClient();
  const workflowHints: readonly WorkflowPattern[] = [
    {
      id: "workflow_hint_1",
      workflowKey: "respond+read_file:deterministic_summary",
      status: "active",
      confidence: 0.82,
      firstSeenAt: "2026-03-03T00:00:00.000Z",
      lastSeenAt: "2026-03-03T00:10:00.000Z",
      supersededAt: null,
      domainLane: "workflow",
      successCount: 4,
      failureCount: 1,
      suppressedCount: 0,
      contextTags: ["deterministic", "summary"]
    }
  ];
  const judgmentHints: readonly JudgmentPattern[] = [
    {
      id: "judgment_hint_1",
      sourceTaskId: "task_prior",
      contextFingerprint: "ctx_hash",
      optionsFingerprint: "options_hash",
      choiceFingerprint: "choice_hash",
      rationaleFingerprint: "rationale_hash",
      riskPosture: "conservative",
      confidence: 0.74,
      status: "active",
      createdAt: "2026-03-03T00:00:00.000Z",
      lastUpdatedAt: "2026-03-03T00:12:00.000Z",
      supersededAt: null,
      outcomeHistory: [
        {
          id: "signal_1",
          signalType: "objective",
          score: 0.5,
          recordedAt: "2026-03-03T00:12:00.000Z"
        }
      ]
    }
  ];

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Provide a deterministic summary response."),
      "mock-planner",
      "mock-planner",
      {
        workflowHints,
        judgmentHints
      }
    );
    assert.deepEqual(plan.learningHints, {
      workflowHintCount: 1,
      judgmentHintCount: 1
    });
  });

  const plannerRequest = modelClient.getPlannerRequest();
  assert.ok(plannerRequest);
  assert.match(plannerRequest.systemPrompt, /Workflow Learning Hints:/i);
  assert.match(plannerRequest.systemPrompt, /Judgment Learning Hints:/i);
  assert.match(plannerRequest.systemPrompt, /Prefer high-confidence active workflow patterns/i);
  assert.match(plannerRequest.systemPrompt, /prefer lower-risk options/i);
});

test("planner synthesizes deterministic workspace-recovery inspection when repair still returns no valid actions", async () => {
  const modelClient = new DeterministicInvalidPlannerModelClient();
  const taskInput = [
    "[WORKSPACE_RECOVERY_INSPECT_FIRST]",
    "A folder move was blocked because the target folders are still in use.",
    "Use inspect_workspace_resources or inspect_path_holders as the main non-respond action for this step; list_directory alone is not enough.",
    "Blocked folder paths: C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
    "",
    "Workspace recovery context for this chat:",
    "- Preferred workspace root: C:\\Users\\testuser\\Desktop\\sample-company",
    "- Preferred preview URL: http://127.0.0.1:4173/",
    "- Exact tracked browser session ids: browser_session:sample-page",
    "- Exact tracked preview lease ids: proc_preview_sample"
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(taskInput), "mock-planner");

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0]?.type, "inspect_path_holders");
    assert.equal(
      plan.actions[0]?.params.path,
      "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1"
    );
    assert.match(plan.plannerNotes ?? "", /deterministic_workspace_recovery_fallback=inspect_path_holders/i);
  });
});

test("planner synthesizes deterministic explicit inspect_path_holders actions when repair still returns no valid actions", async () => {
  const modelClient = new DeterministicInvalidPlannerModelClient();
  const taskInput =
    "Execute inspect_path_holders on `C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1` and `C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-2` now, then report the holders.";

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(taskInput), "mock-planner");

    assert.deepEqual(
      plan.actions.map((action) => ({
        type: action.type,
        path: action.params.path
      })),
      [
        {
          type: "inspect_path_holders",
          path: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1"
        },
        {
          type: "inspect_path_holders",
          path: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-2"
        }
      ]
    );
    assert.match(plan.plannerNotes ?? "", /deterministic_explicit_runtime_fallback=inspect_path_holders/i);
  });
});

test("planner keeps exact blocked paths when explicit workspace-recovery inspection requests mention multiple Windows paths", async () => {
  const modelClient = new DeterministicInvalidPlannerModelClient();
  const taskInput =
    "Continue workspace-recovery for the same goal. First run inspect_path_holders (or inspect_workspace_resources) on the remaining blocked paths: 1) C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1773407921176 and 2) C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1773414171194. If exact tracked preview/runtime holders are found, stop only those exact tracked holders, then retry the organization task: move every Desktop folder whose name begins with \"sample\" into C:\\Users\\testuser\\Desktop\\sample-folder. If inspection finds only likely untracked holders, stop and report that user confirmation is required before shutting them down. Do not stop unrelated apps by name.";

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(taskInput), "mock-planner");

    assert.deepEqual(
      plan.actions.map((action) => ({
        type: action.type,
        path: action.params.path
      })),
      [
        {
          type: "inspect_path_holders",
          path: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1773407921176"
        },
        {
          type: "inspect_path_holders",
          path: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1773414171194"
        }
      ]
    );
    assert.match(plan.plannerNotes ?? "", /deterministic_explicit_runtime_fallback=inspect_path_holders/i);
  });
});

test("planner synthesizes tracked inspect_workspace_resources from wrapped autonomous runtime inspection requests", async () => {
  const modelClient = new DeterministicInvalidPlannerModelClient();
  const currentUserRequest =
    'did you make sure you shut down "Detroit City Two" so that the server is no longer running? Please do this end to end - check and make sure.';
  const wrappedExecutionInput = buildAutonomousExecutionInput(
    currentUserRequest,
    [
      "You are in an ongoing conversation with the same user.",
      "",
      "Current tracked workspace in this chat:",
      "- Root path: C:\\Users\\testuser\\Desktop\\Detroit City Two",
      "- Preview URL: http://127.0.0.1:3000/",
      "- Preview process lease: proc_detroit_two",
      "",
      "Tracked browser sessions:",
      "- Browser window: sessionId=browser_session:detroit_two; url=http://127.0.0.1:3000/; status=closed; visibility=visible; controller=playwright_managed; control=unavailable; linkedPreviewLease=proc_detroit_two; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\Detroit City Two",
      "",
      "Current user request:",
      currentUserRequest
    ].join("\n")
  );

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedExecutionInput), "mock-planner");

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0]?.type, "inspect_workspace_resources");
    assert.equal(
      plan.actions[0]?.params.rootPath,
      "C:\\Users\\testuser\\Desktop\\Detroit City Two"
    );
    assert.equal(plan.actions[0]?.params.previewUrl, "http://127.0.0.1:3000/");
    assert.equal(
      plan.actions[0]?.params.browserSessionId,
      "browser_session:detroit_two"
    );
    assert.equal(plan.actions[0]?.params.previewProcessLeaseId, "proc_detroit_two");
    assert.match(
      plan.plannerNotes ?? "",
      /deterministic_explicit_runtime_fallback=inspect_workspace_resources/i
    );
  });
});

test("planner uses deterministic explicit runtime fallback on planner failures for wrapped autonomous runtime inspection requests", async () => {
  const currentUserRequest =
    "please inspect and see if Detroit City Two is still running, do this end to end";
  const wrappedExecutionInput = buildAutonomousExecutionInput(
    currentUserRequest,
    [
      "You are in an ongoing conversation with the same user.",
      "",
      "Current tracked workspace in this chat:",
      "- Root path: C:\\Users\\testuser\\Desktop\\Detroit City Two",
      "- Preview URL: http://127.0.0.1:3000/",
      "- Preview process lease: proc_detroit_two",
      "",
      "Tracked browser sessions:",
      "- Browser window: sessionId=browser_session:detroit_two; url=http://127.0.0.1:3000/; status=closed; visibility=visible; controller=playwright_managed; control=unavailable; linkedPreviewLease=proc_detroit_two; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\Detroit City Two",
      "",
      "Current user request:",
      currentUserRequest
    ].join("\n")
  );

  await withPlannerClient(new PlannerFailureModelClient(), async (planner) => {
    const plan = await planner.plan(buildTask(wrappedExecutionInput), "mock-planner");

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0]?.type, "inspect_workspace_resources");
    assert.equal(
      plan.actions[0]?.params.rootPath,
      "C:\\Users\\testuser\\Desktop\\Detroit City Two"
    );
    assert.equal(plan.actions[0]?.params.previewUrl, "http://127.0.0.1:3000/");
    assert.equal(plan.actions[0]?.params.previewProcessLeaseId, "proc_detroit_two");
    assert.match(
      plan.plannerNotes ?? "",
      /deterministic_explicit_runtime_fallback=inspect_workspace_resources/i
    );
  });
});

test("planner activates deterministic cooldown after repeated failing fingerprints", async () => {
  const modelClient = new DeterministicInvalidPlannerModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    await assert.rejects(
      planner.plan(buildTask("repeat failing ask"), "mock-planner"),
      /Planner model returned no valid actions/i
    );
    await assert.rejects(
      planner.plan(buildTask("repeat failing ask"), "mock-planner"),
      /Planner model returned no valid actions/i
    );
    const beforeCooldownCalls = modelClient.getPlannerCallCount();
    await assert.rejects(
      planner.plan(buildTask("repeat failing ask"), "mock-planner"),
      /Planner failure cooldown active/i
    );
    assert.equal(modelClient.getPlannerCallCount(), beforeCooldownCalls);
  });
});

test("planner cooldown persists across planner restarts when sqlite failure store is used", async () => {
  const modelClient = new DeterministicInvalidPlannerModelClient();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-cooldown-"));
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");

  try {
    const memoryStoreA = new SemanticMemoryStore(path.join(tempDir, "semantic_memory_a.json"));
    const plannerA = new PlannerOrgan(
      modelClient,
      memoryStoreA,
      new SqlitePlannerFailureStore(sqlitePath)
    );

    await assert.rejects(
      plannerA.plan(buildTask("repeat persistent failing ask"), "mock-planner"),
      /Planner model returned no valid actions/i
    );
    await assert.rejects(
      plannerA.plan(buildTask("repeat persistent failing ask"), "mock-planner"),
      /Planner model returned no valid actions/i
    );

    const memoryStoreB = new SemanticMemoryStore(path.join(tempDir, "semantic_memory_b.json"));
    const plannerB = new PlannerOrgan(
      modelClient,
      memoryStoreB,
      new SqlitePlannerFailureStore(sqlitePath)
    );
    const beforeCooldownCalls = modelClient.getPlannerCallCount();
    await assert.rejects(
      plannerB.plan(buildTask("repeat persistent failing ask"), "mock-planner"),
      /Planner failure cooldown active/i
    );
    assert.equal(modelClient.getPlannerCallCount(), beforeCooldownCalls);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("planner clears failure cooldown state after a successful run", async () => {
  const modelClient = new FailureResetPlannerModelClient(["fail", "success", "fail"]);
  await withPlannerClient(modelClient, async (planner) => {
    await assert.rejects(
      planner.plan(buildTask("same fingerprint"), "mock-planner"),
      /Planner model returned no valid actions/i
    );

    const successPlan = await planner.plan(buildTask("same fingerprint"), "mock-planner");
    assert.equal(successPlan.actions.length, 1);
    assert.equal(successPlan.actions[0].type, "respond");

    await assert.rejects(
      planner.plan(buildTask("same fingerprint"), "mock-planner"),
      /Planner model returned no valid actions/i
    );
    assert.equal(modelClient.getPlannerCallCount() >= 5, true);
  });
});

test("planner repairs wrapped create skill requests when first plan misses create_skill", async () => {
  const modelClient = new MissingCreateSkillThenRepairModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "Create skill stage6_live_gate for promotion control proof."
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedInput), "mock-planner");
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "create_skill");
    assert.equal(plan.actions[0].params.name, "stage6_live_gate");
  });
});

test("planner fails closed when explicit create skill intent never yields create_skill action", async () => {
  const modelClient = new MissingCreateSkillAfterRepairModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "Create skill stage6_live_gate for promotion control proof."
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    await assert.rejects(
      planner.plan(buildTask(wrappedInput), "mock-planner"),
      /missing required create_skill action/i
    );
  });
});

test("planner repairs explicit run-skill requests when first plan misses run_skill", async () => {
  const modelClient = new MissingRunSkillThenRepairModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "Use skill non_existent_skill with input: smoke probe."
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedInput), "mock-planner");
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "run_skill");
    assert.equal(plan.actions[0].params.name, "non_existent_skill");
  });
});

test("planner fails closed when explicit run-skill intent never yields run_skill action", async () => {
  const modelClient = new MissingRunSkillAfterRepairModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "Use skill non_existent_skill with input: smoke probe."
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    await assert.rejects(
      planner.plan(buildTask(wrappedInput), "mock-planner"),
      /missing required run_skill action/i
    );
  });
});

test("planner accepts tracked artifact-edit follow-ups that reopen the same local file preview", async () => {
  const modelClient = new TrackedArtifactEditPreviewModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Tracked artifact-edit follow-up:",
    "- Preferred workspace root: C:\\Users\\testuser\\Desktop\\sample-company",
    "- Preferred primary artifact: C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    "- Preferred preview target: file:///C:/Users/testuser/Desktop/sample-company/index.html",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page."
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedInput), "mock-planner");
    assert.equal(modelClient.getPlannerCallCount(), 1);
    assert.equal(plan.actions.length, 2);
    assert.equal(plan.actions[0].type, "write_file");
    assert.equal(plan.actions[1].type, "open_browser");
    assert.equal(
      plan.actions[1].params.url,
      "file:///C:/Users/testuser/Desktop/sample-company/index.html"
    );
  });
});

test("planner repairs explicit verify_browser subtasks when first plan drifts into unrelated actions", async () => {
  const modelClient = new MissingVerifyBrowserThenRepairModelClient();

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask(
        'verify_browser url=http://localhost:8000 expect_title="Playwright Proof Smoke" expect_content="Browser proof works"'
      ),
      "mock-planner"
    );

    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "verify_browser");
    assert.equal(plan.actions[0].params.url, "http://localhost:8000");
  });
});

test("planner fails closed when explicit verify_browser subtasks never yield verify_browser", async () => {
  const modelClient = new MissingVerifyBrowserAfterRepairModelClient();

  await withPlannerClient(modelClient, async (planner) => {
    await assert.rejects(
      planner.plan(
        buildTask(
          'verify_browser url=http://localhost:8000 expect_title="Playwright Proof Smoke" expect_content="Browser proof works"'
        ),
        "mock-planner"
      ),
      /missing required verify_browser action/i
    );
  });
});

test("planner repairs explicit start_process subtasks when first plan drifts into unrelated actions", async () => {
  const modelClient = new MissingStartProcessThenRepairModelClient();

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask(
        `start_process cmd="python -m http.server 8000" cwd="${HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR}"`
      ),
      "mock-planner"
    );

    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "start_process");
    assert.equal(plan.actions[0].params.command, "python -m http.server 8000");
  });
});

test("planner repairs fresh framework-app requests when first plan only writes source files", async () => {
  const modelClient = new MissingFrameworkScaffoldThenRepairModelClient();

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Create a React app on my Desktop and execute now."),
      "mock-planner"
    );

    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "shell_command");
    assert.match(String(plan.actions[0].params.command), /create vite@latest/i);
  });
});

test("planner fails closed for named framework-app scaffolds that use unsafe package identifiers", async () => {
  const modelClient = new NonInPlaceFrameworkScaffoldThenRepairModelClient();

  await withPlannerClient(modelClient, async (planner) => {
    await assert.rejects(
      planner.plan(
        buildTask("Create a React app on my Desktop in a folder called Sample City and execute now."),
        "mock-planner"
      ),
      /not package-safe/i
    );
    assert.equal(modelClient.getPlannerCallCount(), 2);
  });
});

test("planner accepts check_process recovery subtasks without falsely requiring verify_browser", async () => {
  await withPlannerClient(new CheckProcessRecoveryModelClient(), async (planner) => {
    const plan = await planner.plan(
      buildTask(
        'check_process leaseId="proc_recovery_1". Managed process lease proc_recovery_1 started, but localhost was not ready yet. If the lease is still running, retry probe_port or probe_http once. Only continue to page-level proof after readiness passes.'
      ),
      "mock-planner"
    );

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "check_process");
    assert.equal(plan.actions[0].params.leaseId, "proc_recovery_1");
  });
});

test("planner strips non-explicit run_skill actions and repairs with request-relevant output", async () => {
  const modelClient = new NonExplicitRunSkillThenRepairModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Research deterministic sandboxing controls and provide distilled findings."),
      "mock-planner"
    );
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "respond");
    assert.match(String(plan.actions[0].params.message), /deterministic plan/i);
  });
});

test("planner falls back to synthesized respond when repair still yields only non-explicit run_skill actions", async () => {
  const modelClient = new NonExplicitRunSkillOnlyModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Research deterministic sandboxing controls and provide distilled findings."),
      "mock-planner"
    );
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(modelClient.getResponseCallCount(), 1);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "respond");
    assert.match(String(plan.actions[0].params.message), /safe response-only plan/i);
    assert.match(plan.plannerNotes, /non_explicit_run_skill_fallback=respond/i);
  });
});

test("planner allows explicit conversational use-skill requests to keep run_skill actions", async () => {
  const modelClient = new NonExplicitRunSkillOnlyModelClient();
  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(
      buildTask("Use skill stage6_reuse_skill with input: hello stage 6"),
      "mock-planner"
    );
    assert.equal(modelClient.getPlannerCallCount(), 1);
    assert.equal(modelClient.getResponseCallCount(), 0);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "run_skill");
    assert.equal(plan.actions[0].params.name, "workflow_skill");
  });
});

test("planner maps top-level create_skill name/code fields into params", async () => {
  const modelClient = new TopLevelCreateSkillFieldsModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "Create skill stage6_live_gate for promotion control proof."
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedInput), "mock-planner");
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "create_skill");
    assert.equal(plan.actions[0].params.name, "stage6_live_gate");
    assert.match(
      String(plan.actions[0].params.code),
      /stage6_live_gate/
    );
  });
});

test("planner backfills missing create_skill name without synthesizing executable code", async () => {
  const modelClient = new MissingCreateSkillParamsModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "Create skill stage6_live_gate for promotion control proof."
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedInput), "mock-planner");
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "create_skill");
    assert.equal(plan.actions[0].params.name, "stage6_live_gate");
    assert.equal(plan.actions[0].params.code, undefined);
  });
});

test("planner derives non-placeholder create_skill name from natural-language intent phrase", async () => {
  const modelClient = new MissingCreateSkillParamsModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "create a skill to learn about agentic ai"
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedInput), "mock-planner");
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "create_skill");
    assert.equal(plan.actions[0].params.name, "agentic_ai");
    assert.notEqual(plan.actions[0].params.name, "to");
    assert.equal(plan.actions[0].params.code, undefined);
  });
});

test("planner removes placeholder create_skill code instead of replacing it", async () => {
  const modelClient = new CommentOnlyCreateSkillCodeModelClient();
  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: earlier unrelated prompt",
    "- assistant: earlier unrelated response",
    "Current user request:",
    "create a skill to learn about agentic ai"
  ].join("\n");

  await withPlannerClient(modelClient, async (planner) => {
    const plan = await planner.plan(buildTask(wrappedInput), "mock-planner");
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "create_skill");
    assert.equal(plan.actions[0].params.name, "agentic_ai");
    assert.equal(plan.actions[0].params.code, undefined);
  });
});
