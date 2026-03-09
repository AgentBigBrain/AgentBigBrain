/**
 * @fileoverview Tests planner behavior under strict model-only planning and fail-fast error semantics.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SemanticMemoryStore } from "../../src/core/semanticMemory";
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
import { PlannerOrgan } from "../../src/organs/planner";
import {
  HOST_TEST_DESKTOP_DIR,
  HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR,
  HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_INDEX_HTML,
  HOST_TEST_ROBINHOOD_MOCK_DIR
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
              command: "npm create vite@latest robinhood-mock -- --template react",
              cwd: HOST_TEST_DESKTOP_DIR
            }
          },
          {
            type: "start_process",
            description: "Start the local dev server for live verification.",
            params: {
              command: "npm run dev",
              cwd: HOST_TEST_ROBINHOOD_MOCK_DIR
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
              expectedTitle: "Robinhood Mock",
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
              command: "npm create vite@latest robinhood-mock -- --template react",
              cwd: HOST_TEST_DESKTOP_DIR
            }
          },
          {
            type: "start_process",
            description: "Start the local dev server for live verification.",
            params: {
              command: "npm run dev",
              cwd: HOST_TEST_ROBINHOOD_MOCK_DIR
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

    return {
      plannerNotes: "planner output with executable action for prompt inspection",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the requested workspace.",
          params: {
            command: "npm create vite@latest robinhood-mock -- --template react",
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
            command: "npm create vite@latest robinhood-mock -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        }
      ]
    } as T;
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
            command: "npm create vite@latest robinhood-mock -- --template react",
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
              command: "npm create vite@latest robinhood-mock -- --template react",
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
            command: "npm create vite@latest robinhood-mock -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        },
        {
          type: "start_process",
          description: "Start the local dev server.",
          params: {
            command: "npm run dev",
            cwd: HOST_TEST_ROBINHOOD_MOCK_DIR
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
            command: "npm create vite@latest robinhood-mock -- --template react",
            cwd: HOST_TEST_DESKTOP_DIR
          }
        },
        {
          type: "start_process",
          description: "Start the local dev server.",
          params: {
            command: "npm run dev",
            cwd: HOST_TEST_ROBINHOOD_MOCK_DIR
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
    /do not use long-running dev-server commands .*npm start.*npm run dev/i
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
      commandMaxChars: 2048
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
    assert.doesNotMatch(plannerRequest.systemPrompt, /localhost/i);
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

test("planner deterministically backfills missing create_skill params from explicit request", async () => {
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
    assert.match(
      String(plan.actions[0].params.code),
      /@fileoverview Auto-generated skill scaffold/
    );
    assert.match(
      String(plan.actions[0].params.code),
      /normalizedInput/
    );
    assert.match(
      String(plan.actions[0].params.code),
      /ok:\s*boolean/
    );
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
    assert.match(
      String(plan.actions[0].params.code),
      /agentic_ai/
    );
  });
});

test("planner replaces placeholder create_skill code with executable scaffold", async () => {
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
    assert.match(
      String(plan.actions[0].params.code),
      /@fileoverview Auto-generated skill scaffold/
    );
    assert.match(
      String(plan.actions[0].params.code),
      /export function agentic_ai/
    );
  });
});
