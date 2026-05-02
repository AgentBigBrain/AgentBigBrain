/**
 * @fileoverview Tests selection of user-facing interface replies from task results.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskRunResult } from "../../src/core/types";
import { selectUserFacingSummary } from "../../src/interfaces/userFacingResult";
import {
  HOST_TEST_SAMPLE_SITE_DIR,
  HOST_TEST_TOP_SECRET_FILE_PATH
} from "../support/windowsPathFixtures";

/**
 * Builds a minimal `TaskRunResult` fixture for user-facing rendering tests.
 *
 * The helper keeps test setup compact while still exercising the real
 * `selectUserFacingSummary` policy branches across different action outcomes.
 */
function buildRunResult(
  summary: string,
  actionResults: TaskRunResult["actionResults"],
  options: {
    userInput?: string;
  } = {}
): TaskRunResult {
  return {
    task: {
      id: "task_user_facing_1",
      agentId: "main-agent",
      goal: "Reply to user",
      userInput: options.userInput ?? "hello",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_user_facing_1",
      plannerNotes: "test plan",
      actions: actionResults.map((item) => item.action)
    },
    actionResults,
    summary,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

test("selectUserFacingSummary prefers approved respond output when present", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_1",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "Hello there!",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "Hello there!");
});

test("selectUserFacingSummary strips label-style AI assistant openings from respond output", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_label_style_prefix",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "AI assistant response: Test message received, Benny.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "Test message received, Benny.");
});

test("selectUserFacingSummary strips label-style AI assistant answer openings from respond output", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_label_style_answer_prefix",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "AI assistant answer: The screenshot shows a GitHub repository list.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "The screenshot shows a GitHub repository list.");
});

test("selectUserFacingSummary strips AI assistant here introductions from respond output", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_ai_assistant_here_intro",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "AI assistant here—doing well, thanks for asking! How can I help you today, buddy?",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "Doing well, thanks for asking! How can I help you today, buddy?");
});

test("selectUserFacingSummary strips I am your AI assistant introductions from respond output", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_ai_assistant_identity_intro",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "Hey Benny — I'm your AI assistant, and I'm doing great. Thanks for asking! How are you doing today, and what would you like help with?",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "I'm doing great. Thanks for asking! How are you doing today, and what would you like help with?");
});

test("selectUserFacingSummary strips filler plus AI assistant identity openings from respond output", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_ai_assistant_identity_with_filler",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "Got it - I'm an AI assistant, and I'm closing that landing page window now so we can move on.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "I'm closing that landing page window now so we can move on.");
});

test("selectUserFacingSummary strips direct AI assistant action phrasing from respond output", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_ai_assistant_direct_action",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output:
        "AI assistant is closing the landing page window now so we can work on something else. Tell AI assistant what you want to do next.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(
    selected,
    "Closing the landing page window now so we can work on something else. Tell me what you want to do next."
  );
});

test("selectUserFacingSummary rewrites filler plus third-person AI assistant completion phrasing", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_ai_assistant_completion_phrase",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output:
        "Done - this AI assistant has closed that landing page window. You can tell me what you want to work on next.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(
    selected,
    "Done - I have closed that landing page window. You can tell me what you want to work on next."
  );
});

test("selectUserFacingSummary rewrites third-person BigBrain self-reference in respond output", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_bigbrain_third_person",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output:
        "If you want, BigBrain can next turn this into a tiny section-by-section content outline before any coding.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(
    selected,
    "If you want, I can next turn this into a tiny section-by-section content outline before any coding."
  );
});

test("selectUserFacingSummary blocks browser-execution overclaims when no shell action executed", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_browser_overclaim",
        type: "respond",
        description: "reply",
        params: {
          message: "I will now open your browser and navigate to google.com."
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "I will now open your browser and navigate to Google.com.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /cannot claim that i opened your browser/i);
  assert.match(selected, /no approved device-control action executed/i);
});

test("selectUserFacingSummary blocks generic side-effect completion overclaims when no non-respond action executed", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_overclaim_schedule",
        type: "respond",
        description: "reply",
        params: {
          message: "The actions that have already run include scheduling confirmations."
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "The actions that have already run include scheduling confirmations.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /cannot claim side-effect work completed/i);
  assert.match(selected, /no approved non-respond action executed/i);
});

test("selectUserFacingSummary preserves side-effect completion language when non-respond execution is approved", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_overclaim_schedule_allowed",
        type: "respond",
        description: "reply",
        params: {
          message: "The actions that have already run include scheduling confirmations."
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "The actions that have already run include scheduling confirmations.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_run_skill_schedule_execution",
        type: "run_skill",
        description: "run governed schedule skill",
        params: {
          name: "calendar_focus_blocks"
        },
        estimatedCostUsd: 0.12
      },
      mode: "escalation_path",
      approved: true,
      output: "Schedule skill completed.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(
    selected,
    "The actions that have already run include scheduling confirmations.\nRun skill status: Schedule skill completed."
  );
});

test("selectUserFacingSummary labels simulated side-effect execution instead of claiming real completion", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_overclaim_simulated_shell",
        type: "respond",
        description: "reply",
        params: {
          message: "I opened your browser and completed the action."
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "I opened your browser and completed the action.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_shell_simulated",
        type: "shell_command",
        description: "open browser",
        params: {
          command: "start https://google.com"
        },
        estimatedCostUsd: 0.1
      },
      mode: "escalation_path",
      approved: true,
      output: "Shell execution simulated (real shell execution disabled by policy).",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /simulated side-effect actions only/i);
  assert.match(selected, /no real side-effect action was executed/i);
});

test("selectUserFacingSummary keeps browser-execution respond text when shell action was approved", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_browser_exec_confirm",
        type: "respond",
        description: "reply",
        params: {
          message: "I opened your browser and navigated to google.com."
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output: "I opened your browser and navigated to google.com.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_shell_browser_open",
        type: "shell_command",
        description: "open browser",
        params: {
          command: "start https://google.com"
        },
        estimatedCostUsd: 0.1
      },
      mode: "escalation_path",
      approved: true,
      output: "Shell command completed.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "I opened your browser and navigated to google.com.");
});

test("selectUserFacingSummary prefers truthful partial-success wording over generic blocked failure when real work succeeded", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_write_file_success",
        type: "write_file",
        description: "write index file",
        params: {
          path: "C:\\temp\\sample-company\\index.html",
          content: "<html></html>"
        },
        estimatedCostUsd: 0.08
      },
      mode: "escalation_path",
      approved: true,
      output: "Write success: C:\\temp\\sample-company\\index.html",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_open_browser_success",
        type: "open_browser",
        description: "leave preview open",
        params: {
          url: "http://127.0.0.1:4173/index.html"
        },
        estimatedCostUsd: 0.06
      },
      mode: "escalation_path",
      approved: true,
      output: "Opened http://127.0.0.1:4173/index.html in a visible browser window and left it open for you.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_followup_blocked",
        type: "shell_command",
        description: "follow-up command",
        params: {
          command: "echo blocked"
        },
        estimatedCostUsd: 0.05
      },
      mode: "escalation_path",
      approved: false,
      output: "",
      blockedBy: ["PERSONAL_DATA_APPROVAL_REQUIRED"],
      violations: [
        {
          code: "PERSONAL_DATA_APPROVAL_REQUIRED",
          message: "Approval required."
        }
      ],
      votes: []
    }
  ], {
    userInput: "build the page on my desktop and leave it open for me"
  });

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /I opened http:\/\/127\.0\.0\.1:4173\/index\.html in your browser and left it open\./i);
  assert.match(selected, /One later step was blocked/i);
  assert.doesNotMatch(selected, /^I couldn't execute that request in this run\./i);
});

test("selectUserFacingSummary prefers a proven file update over later inspection-only proof when verification blocks", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_write_file_edit_success",
        type: "write_file",
        description: "update landing page",
        params: {
          path: "C:\\temp\\sample-company\\index.html",
          content: "<html><body>edited</body></html>"
        },
        estimatedCostUsd: 0.08
      },
      mode: "escalation_path",
      approved: true,
      output: "Write success: C:\\temp\\sample-company\\index.html",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_list_directory_after_edit",
        type: "list_directory",
        description: "inspect workspace",
        params: {
          path: "C:\\temp\\sample-company"
        },
        estimatedCostUsd: 0.04
      },
      mode: "escalation_path",
      approved: true,
      output: "Directory contents:\nindex.html",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_verify_browser_blocked_after_edit",
        type: "verify_browser",
        description: "verify edited page",
        params: {
          sessionId: "browser_session:landing_page"
        },
        estimatedCostUsd: 0.06
      },
      mode: "escalation_path",
      approved: false,
      output: "",
      blockedBy: ["ACTION_EXECUTION_FAILED"],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: "Browser verification failed."
        }
      ],
      votes: []
    }
  ], {
    userInput: "edit the landing page and verify the browser preview"
  });

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /I created or updated C:\\temp\\sample-company\\index\.html\./i);
  assert.match(selected, /One later runtime step failed \(ACTION_EXECUTION_FAILED\): Browser verification failed\./i);
  assert.doesNotMatch(selected, /I checked C:\\temp\\sample-company\./i);
});

test("selectUserFacingSummary carries exact runtime failure detail through partial-success summaries", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_write_file_runtime_partial_success",
        type: "write_file",
        description: "update landing page",
        params: {
          path: "C:\\temp\\sky-sample-max\\src\\index.css",
          content: "body { color: #123456; }"
        },
        estimatedCostUsd: 0.08
      },
      mode: "escalation_path",
      approved: true,
      output: "Write success: C:\\temp\\sky-sample-max\\src\\index.css",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_shell_runtime_failure_after_write",
        type: "shell_command",
        description: "start preview",
        params: {
          command: "npm run dev"
        },
        estimatedCostUsd: 0.12
      },
      mode: "escalation_path",
      approved: false,
      output: "Shell failed (exit code 1):\nMissing script: dev",
      blockedBy: ["ACTION_EXECUTION_FAILED"],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: "Shell failed (exit code 1): Missing script: dev"
        }
      ],
      votes: []
    }
  ], {
    userInput: "build the landing page and leave it open in the browser"
  });

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /I created or updated C:\\temp\\sky-sample-max\\src\\index\.css\./i);
  assert.match(selected, /One later runtime step failed \(ACTION_EXECUTION_FAILED\): Shell failed \(exit code 1\):/i);
  assert.match(selected, /Missing script: dev/i);
});

test("selectUserFacingSummary prefers proven build edits over respond no-op narration when real work executed", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_respond_false_build_noop",
        type: "respond",
        description: "reply",
        params: {
          message:
            "I didn't complete the requested live app run in this run. What happened: the build request reached a live-run verification step without enough executed proof to claim the app was running or the UI was verified."
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output:
        "I didn't complete the requested live app run in this run. What happened: the build request reached a live-run verification step without enough executed proof to claim the app was running or the UI was verified.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_write_react_app",
        type: "write_file",
        description: "update React app",
        params: {
          path: "C:\\temp\\sample-react-preview\\src\\App.jsx",
          content: "export default function App() { return null; }"
        },
        estimatedCostUsd: 0.08
      },
      mode: "escalation_path",
      approved: true,
      output: "Write success: C:\\temp\\sample-react-preview\\src\\App.jsx",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_build_react_app",
        type: "shell_command",
        description: "build app",
        params: {
          command: "npm run build"
        },
        estimatedCostUsd: 0.12
      },
      mode: "escalation_path",
      approved: true,
      output:
        "Shell success:\n> sample-react-preview@0.0.0 build\n> vite build\n\nbuilt in 200ms",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ], {
    userInput:
      "Reuse the existing sample React workspace on my desktop, turn it into a calm sample-themed landing page, and run the build so dist/index.html exists."
  });

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /I created or updated C:\\temp\\sample-react-preview\\src\\App\.jsx\./i);
  assert.doesNotMatch(selected, /I didn't complete the requested live app run in this run\./i);
  assert.doesNotMatch(selected, /BUILD_NO_SIDE_EFFECT_EXECUTED/i);
});

test("selectUserFacingSummary prefers proof-backed partial success over a generic blocked respond summary after a file update", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_write_file_partial_success",
        type: "write_file",
        description: "update landing page",
        params: {
          path: "C:\\temp\\sample-company\\index.html",
          content: "<html><body>edited</body></html>"
        },
        estimatedCostUsd: 0.08
      },
      mode: "escalation_path",
      approved: true,
      output: "Write success: C:\\temp\\sample-company\\index.html",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_respond_generic_blocked_after_real_edit",
        type: "respond",
        description: "reply",
        params: {
          message:
            "I couldn't execute that request in this run. What happened: one or more governed actions were blocked before execution. Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect. What to do next: ask for the exact block code and approval diff, then retry with a narrower allowed action. Technical reason code: ACTION_EXECUTION_FAILED"
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output:
        "I couldn't execute that request in this run. What happened: one or more governed actions were blocked before execution. Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect. What to do next: ask for the exact block code and approval diff, then retry with a narrower allowed action. Technical reason code: ACTION_EXECUTION_FAILED",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_verify_browser_blocked_after_real_edit",
        type: "verify_browser",
        description: "verify edited page",
        params: {
          sessionId: "browser_session:landing_page"
        },
        estimatedCostUsd: 0.06
      },
      mode: "escalation_path",
      approved: false,
      output: "",
      blockedBy: ["ACTION_EXECUTION_FAILED"],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: "Browser verification failed."
        }
      ],
      votes: []
    }
  ], {
    userInput: "edit the landing page and verify the browser preview"
  });

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /I created or updated C:\\temp\\sample-company\\index\.html\./i);
  assert.match(selected, /One later runtime step failed \(ACTION_EXECUTION_FAILED\): Browser verification failed\./i);
  assert.doesNotMatch(selected, /^I couldn't execute that request in this run\./i);
});

test("selectUserFacingSummary prefers the open page over later browser-verification detail when a later step blocks", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_open_browser_preview_success",
        type: "open_browser",
        description: "open preview",
        params: {
          url: "http://127.0.0.1:4177/index.html"
        },
        estimatedCostUsd: 0.06
      },
      mode: "escalation_path",
      approved: true,
      output: "Opened http://127.0.0.1:4177/index.html in a visible browser window and left it open for you.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_verify_browser_preview_success",
        type: "verify_browser",
        description: "verify preview",
        params: {
          url: "http://127.0.0.1:4177/index.html"
        },
        estimatedCostUsd: 0.07
      },
      mode: "escalation_path",
      approved: true,
      output: "Browser verification passed: observed title \"Sample Landing\"; expected text matched.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_followup_blocked_after_browser_verify",
        type: "shell_command",
        description: "follow-up command",
        params: {
          command: "echo blocked"
        },
        estimatedCostUsd: 0.04
      },
      mode: "escalation_path",
      approved: false,
      output: "",
      blockedBy: ["ACTION_EXECUTION_FAILED"],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: "Follow-up command failed."
        }
      ],
      votes: []
    }
  ], {
    userInput: "build the page, verify it in the browser, and leave it open"
  });

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /I opened http:\/\/127\.0\.0\.1:4177\/index\.html in your browser and left it open\./i);
  assert.match(selected, /One later runtime step failed \(ACTION_EXECUTION_FAILED\): Follow-up command failed\./i);
  assert.doesNotMatch(selected, /^Browser verification passed:/i);
});

test("selectUserFacingSummary surfaces an approved browser-open execution failure instead of a later generic blocked reply", () => {
  const targetUrl = "file:///C:/Users/testuser/Desktop/sample-company-landing.html";
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_open_browser_preview_failed",
        type: "open_browser",
        description: "open preview",
        params: {
          url: targetUrl
        },
        estimatedCostUsd: 0.06
      },
      mode: "escalation_path",
      approved: true,
      output: `Browser open failed: net::ERR_FILE_NOT_FOUND at ${targetUrl}`,
      executionStatus: "failed",
      executionFailureCode: "ACTION_EXECUTION_FAILED",
      blockedBy: [],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: `Browser open failed: net::ERR_FILE_NOT_FOUND at ${targetUrl}`
        }
      ],
      votes: []
    },
    {
      action: {
        id: "action_followup_blocked_after_failed_open",
        type: "shell_command",
        description: "follow-up command",
        params: {
          command: "echo blocked"
        },
        estimatedCostUsd: 0.04
      },
      mode: "escalation_path",
      approved: false,
      output: "",
      blockedBy: ["ACTION_EXECUTION_FAILED"],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: "Security governor timeout or failure."
        }
      ],
      votes: [
        {
          governorId: "security",
          approve: false,
          reason: "Governor timeout or failure.",
          confidence: 0
        }
      ]
    },
    {
      action: {
        id: "action_respond_generic_block_after_failed_open",
        type: "respond",
        description: "reply",
        params: {
          message:
            "I couldn't execute that request in this run. What happened: governance blocked the requested action. Why it didn't execute: Security governor rejected this request. I have to keep actions safe and aligned with helping humans. What to do next: request the exact rejected step with typed codes, then submit a safer/narrower alternative. Main concerns: Security: Governor timeout or failure."
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output:
        "I couldn't execute that request in this run. What happened: governance blocked the requested action. Why it didn't execute: Security governor rejected this request. I have to keep actions safe and aligned with helping humans. What to do next: request the exact rejected step with typed codes, then submit a safer/narrower alternative. Main concerns: Security: Governor timeout or failure.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ], {
    userInput: "Open both of the landing pages that you just designed in React so I can compare them"
  });

  const selected = selectUserFacingSummary(runResult);
  assert.match(
    selected,
    /I tried to open file:\/\/\/C:\/Users\/testuser\/Desktop\/sample-company-landing\.html in your browser, but it failed: net::ERR_FILE_NOT_FOUND at file:\/\/\/C:\/Users\/testuser\/Desktop\/sample-company-landing\.html\./i
  );
  assert.doesNotMatch(selected, /^I couldn't execute that request in this run\./i);
  assert.doesNotMatch(selected, /governance blocked the requested action/i);
});

test("selectUserFacingSummary prefers readiness proof over a generic blocked respond summary when process start and probe succeeded", () => {
  const runResult = buildRunResult("technical summary", [
    {
      action: {
        id: "action_start_process_ready_success",
        type: "start_process",
        description: "start preview server",
        params: {
          command: "npm run dev"
        },
        estimatedCostUsd: 0.12
      },
      mode: "escalation_path",
      approved: true,
      output: "Process started: lease proc_preview_a (pid 4242).",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_probe_http_ready_success",
        type: "probe_http",
        description: "probe preview url",
        params: {
          url: "http://127.0.0.1:4177/",
          expectedStatus: 200
        },
        estimatedCostUsd: 0.05
      },
      mode: "escalation_path",
      approved: true,
      output: "HTTP ready: http://127.0.0.1:4177/ responded with expected status 200.",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_respond_generic_blocked_after_probe",
        type: "respond",
        description: "reply",
        params: {
          message:
            "I couldn't execute that request in this run. What happened: one or more governed actions were blocked before execution. Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect. What to do next: ask for the exact block code and approval diff, then retry with a narrower allowed action. Technical reason code: ACTION_EXECUTION_FAILED"
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      output:
        "I couldn't execute that request in this run. What happened: one or more governed actions were blocked before execution. Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect. What to do next: ask for the exact block code and approval diff, then retry with a narrower allowed action. Technical reason code: ACTION_EXECUTION_FAILED",
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_verify_browser_blocked_after_probe",
        type: "verify_browser",
        description: "verify preview browser",
        params: {
          url: "http://127.0.0.1:4177/"
        },
        estimatedCostUsd: 0.07
      },
      mode: "escalation_path",
      approved: false,
      output: "",
      blockedBy: ["ACTION_EXECUTION_FAILED"],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: "Browser verification failed."
        }
      ],
      votes: []
    }
  ], {
    userInput: "start the preview, make sure it is ready, and verify it in the browser"
  });

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /HTTP ready: http:\/\/127\.0\.0\.1:4177\/ responded with expected status 200\./i);
  assert.match(selected, /One later runtime step failed \(ACTION_EXECUTION_FAILED\): Browser verification failed\./i);
  assert.doesNotMatch(selected, /^I couldn't execute that request in this run\./i);
});

test("selectUserFacingSummary explains local folder lock failures in plain language", () => {
  const runResult = buildRunResult(
    "Completed task with 3 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_list_desktop_success",
          type: "list_directory",
          description: "inspect desktop",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop"
          },
          estimatedCostUsd: 0.06
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_blocked_by_lock",
          type: "shell_command",
          description: "move folders",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.25
        },
        mode: "escalation_path",
        approved: false,
        output:
          "Shell failed:\nMove-Item : The process cannot access the file because it is being used by another process.",
        blockedBy: ["ACTION_EXECUTION_FAILED"],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "Shell failed:\nMove-Item : The process cannot access the file because it is being used by another process."
          }
        ],
        votes: []
      }
    ],
    {
      userInput:
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.match(selected, /I couldn't finish organizing those folders in this run\./i);
  assert.match(selected, /still being used by another local process/i);
  assert.match(selected, /close the related preview or local process first/i);
});

test("selectUserFacingSummary tells the truth when some organized folders moved and some stayed blocked", () => {
  const runResult = buildRunResult(
    "Completed task with 4 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_stop_holder_partial_move",
          type: "stop_process",
          description: "stop preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_partial_success",
          type: "shell_command",
          description: "move matching folders",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: [
          "Shell success:",
          JSON.stringify({
            desktop: "C:\\Users\\testuser\\OneDrive\\Desktop",
            destination: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects",
            moved: ["sample-company-a"],
            failed: [
              {
                item: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-company-b",
                error:
                  "The process cannot access the file because it is being used by another process."
              }
            ],
            remainingOnDesktop: ["sample-company-b"]
          })
        ].join("\n"),
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_partial_destination",
          type: "list_directory",
          description: "inspect destination folder",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-a",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_respond_weak_partial_inspection",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.match(
    selected,
    /The destination now contains sample-company-a in C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects\./i
  );
  assert.match(selected, /These still stayed outside it: sample-company-b\./i);
  assert.match(selected, /I had already shut down 1 exact tracked preview holder first/i);
  assert.match(selected, /Ask me to inspect the remaining holder and retry the move/i);
  assert.doesNotMatch(
    selected,
    /^I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects\./i
  );
});

test("selectUserFacingSummary does not append a generic blocked suffix to self-contained partial organization proof", () => {
  const runResult = buildRunResult(
    "Completed task with 3 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_stop_holder_partial_move_blocked",
          type: "stop_process",
          description: "stop preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_partial_success_blocked",
          type: "shell_command",
          description: "move matching folders",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: [
          "Shell success:",
          JSON.stringify({
            desktop: "C:\\Users\\testuser\\OneDrive\\Desktop",
            destination: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects",
            moved: ["sample-company-a"],
            failed: [
              {
                item: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-company-b",
                error:
                  "The process cannot access the file because it is being used by another process."
              }
            ],
            remainingOnDesktop: ["sample-company-b"]
          })
        ].join("\n"),
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_partial_destination_blocked",
          type: "list_directory",
          description: "inspect destination folder",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-a",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_followup_blocked_after_partial_move",
          type: "shell_command",
          description: "follow-up command",
          params: {
            command: "echo blocked"
          },
          estimatedCostUsd: 0.04
        },
        mode: "escalation_path",
        approved: false,
        output: "",
        blockedBy: ["ACTION_EXECUTION_FAILED"],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message: "Follow-up command failed."
          }
        ],
        votes: []
      }
    ],
    {
      userInput:
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.match(selected, /These still stayed outside it: sample-company-b\./i);
  assert.doesNotMatch(selected, /One later step was blocked/i);
});

test("selectUserFacingSummary prefers the completed organization move over a weak inspection reply", () => {
  const runResult = buildRunResult(
    "Completed task with 5 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_organization_success",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_a",
          type: "stop_process",
          description: "stop first preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_b",
          type: "stop_process",
          description: "stop second preview holder",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_b.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_folders_success",
          type: "shell_command",
          description: "move matching folders",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell success: moved matching sample-company folders.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_destination",
          type: "list_directory",
          description: "inspect destination folder",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-a\nsample-company-b",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects. I shut down 2 exact tracked preview holders first so the move could finish."
  );
});

test("selectUserFacingSummary prefers the recovered organization move summary after a clarification reply", () => {
  const runResult = buildRunResult(
    "Completed task with 8 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovered_move_shell_output",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I ran the command successfully. Command output: moved|sample-company-a moved|sample-company-b"
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I ran the command successfully. Command output: moved|sample-company-a moved|sample-company-b",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_recovered_holder_a",
          type: "stop_process",
          description: "stop first preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_recovered_holder_b",
          type: "stop_process",
          description: "stop second preview holder",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_b.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_recovered_folders_success",
          type: "shell_command",
          description: "move matching folders",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell success: moved matching sample-company folders.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_close_linked_browser_a",
          type: "close_browser",
          description: "close linked browser window",
          params: {
            sessionId: "browser_session_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Browser session closed.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_close_linked_browser_b",
          type: "close_browser",
          description: "close linked browser window",
          params: {
            sessionId: "browser_session_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Browser session closed.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_recovered_destination",
          type: "list_directory",
          description: "inspect destination folder",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-a\nsample-company-b",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Yes, shut them down and retry the move."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects. I shut down 2 exact tracked preview holders first so the move could finish."
  );
});

test("selectUserFacingSummary uses the active request segment for wrapped organization prompts", () => {
  const wrappedOrganizationPrompt = [
    "You are in an ongoing conversation with the same user.",
    "",
    "Recent conversation context (oldest to newest):",
    "- user: Please build a small sample project in a folder called sample-company-organize-smoke-a and leave the preview open for me.",
    "- assistant: Opened http://localhost:4173/index.html in a visible browser window and left it open for you.",
    "",
    "Current user request:",
    "Please organize the sample-company-organize-smoke project folders you made earlier into a folder called sample-web-projects."
  ].join("\n");

  const runResult = buildRunResult(
    "Completed task with 4 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_wrapped_organization_success",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_wrapped_holder_a",
          type: "stop_process",
          description: "stop exact preview holder",
          params: {
            leaseId: "proc_wrapped_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_wrapped_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_wrapped_folders_success",
          type: "shell_command",
          description: "move matching folders",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell success: moved matching sample-company folders.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_wrapped_destination",
          type: "list_directory",
          description: "inspect destination folder",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-organize-smoke-a\nsample-company-organize-smoke-b",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: wrappedOrganizationPrompt
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects. I shut down 1 exact tracked preview holder first so the move could finish."
  );
});

test("selectUserFacingSummary does not trust organization move claims when the run never proved the move", () => {
  const runResult = buildRunResult(
    "Completed task with 4 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_false_organization_success",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I moved the matching folders into sample-company-organize-smoke-a and left the preview open for you."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I moved the matching folders into sample-company-organize-smoke-a and left the preview open for you.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_create_destination_only",
          type: "shell_command",
          description: "create destination folder only",
          params: {
            command:
              "New-Item -ItemType Directory -Path 'C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects' -Force | Out-Null"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell success: command returned no output.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_list_desktop_after_noop",
          type: "list_directory",
          description: "inspect desktop root",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-organize-smoke-a\nsample-company-organize-smoke-b\nsample-web-projects",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_list_empty_destination",
          type: "list_directory",
          description: "inspect destination folder",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I checked the requested folders, but this run did not prove that the matching folders were moved into the requested destination yet."
  );
});

test("selectUserFacingSummary surfaces a human-first organization summary without any respond action", () => {
  const runResult = buildRunResult(
    "Completed task with 3 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_stop_holder_only",
          type: "stop_process",
          description: "stop preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_folders_only",
          type: "shell_command",
          description: "move matching folders",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell success: moved matching sample-company folders.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_destination_only",
          type: "list_directory",
          description: "inspect destination folder",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-a",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
    }
  );

  const selected = selectUserFacingSummary(runResult);

  assert.equal(
    selected,
    "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects. I shut down 1 exact tracked preview holder first so the move could finish."
  );
});

test("selectUserFacingSummary trusts JSON move-proof output for desktop cleanup runs", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_move_desktop_sample_folders_json",
          type: "shell_command",
          description: "move all sample-company desktop folders into sample-folder",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output:
          "Shell success:\n{\"destination\":\"C:\\\\Users\\\\testuser\\\\OneDrive\\\\Desktop\\\\sample-folder\",\"moved\":[\"sample-company-a\",\"sample-company-b\"],\"failed\":[]}",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_ack_desktop_sample_cleanup",
          type: "respond",
          description: "acknowledge cleanup",
          params: {
            message: "Got it — I’m moving the folders now."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Got it — I’m moving the folders now.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Please clean up the sample-company folders on my desktop and put them into sample-folder."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved sample-company-a and sample-company-b into C:\\Users\\testuser\\OneDrive\\Desktop\\sample-folder."
  );
});

test("selectUserFacingSummary renders the completed organization move after a recovery confirmation turn", () => {
  const runResult = buildRunResult(
    "Completed task with 8 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_followup",
          type: "respond",
          description: "reply",
          params: {
            message: "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I checked C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_a",
          type: "stop_process",
          description: "stop first exact preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_b",
          type: "stop_process",
          description: "stop second exact preview holder",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_b.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_after_recovery",
          type: "shell_command",
          description: "move the matching folders after recovery",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell success: moved matching sample-company folders.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_destination_after_recovery",
          type: "list_directory",
          description: "inspect the destination folder after recovery",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\nsample-company-a\nsample-company-b",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Yes, shut them down and retry the move."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects. I shut down 2 exact tracked preview holders first so the move could finish."
  );
});

test("selectUserFacingSummary renders the completed organization move from bounded move-proof output after a recovery confirmation turn", () => {
  const runResult = buildRunResult(
    "Completed task with 8 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_followup_raw_output",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I ran the command successfully. Command output: MOVED_TO_DEST sample-company-a sample-company-b REMAINING_AT_DESKTOP"
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I ran the command successfully.\nCommand output:\nMOVED_TO_DEST\nsample-company-a\nsample-company-b\nREMAINING_AT_DESKTOP",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_output_a",
          type: "stop_process",
          description: "stop first exact preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_output_b",
          type: "stop_process",
          description: "stop second exact preview holder",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_b.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_after_recovery_output",
          type: "shell_command",
          description: "move the matching folders after recovery",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output:
          "MOVED_TO_DEST\nsample-company-a\nsample-company-b\nREMAINING_AT_DESKTOP",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Yes, shut them down and retry the move."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved sample-company-a and sample-company-b into the requested folder. I shut down 2 exact tracked preview holders first so the move could finish."
  );
});

test("selectUserFacingSummary renders the completed organization move from destination-content proof output after a recovery confirmation turn", () => {
  const runResult = buildRunResult(
    "Completed task with 8 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_followup_dest_contents",
          type: "respond",
          description: "reply",
          params: {
            message: "I ran the command successfully."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I ran the command successfully.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_dest_contents_a",
          type: "stop_process",
          description: "stop first exact preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_dest_contents_b",
          type: "stop_process",
          description: "stop second exact preview holder",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_b.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_after_recovery_dest_contents",
          type: "shell_command",
          description: "move the matching folders after recovery",
          params: {
            command: [
              "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects'",
              "Move-Item ...",
              "Write-Output 'DEST_CONTENTS:'",
              "Write-Output 'ROOT_REMAINING_MATCHES:'"
            ].join("\n")
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output:
          "Shell success:\nDEST_CONTENTS:\r\nsample-company-a\r\nsample-company-b\r\nROOT_REMAINING_MATCHES:",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Yes, shut them down and retry the move."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved sample-company-a and sample-company-b into the requested folder. I shut down 2 exact tracked preview holders first so the move could finish."
  );
});

test("selectUserFacingSummary renders the completed organization move from inline assignment proof output after a recovery confirmation turn", () => {
  const runResult = buildRunResult(
    "Completed task with 8 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_followup_inline_assignment",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I ran the command successfully. Command output: MOVED_TO_DEST=sample-company-a,sample-company-b DEST_CONTENTS=sample-company-a,sample-company-b ROOT_REMAINING_MATCHES="
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I ran the command successfully.\nCommand output:\nMOVED_TO_DEST=sample-company-a,sample-company-b\nDEST_CONTENTS=sample-company-a,sample-company-b\nROOT_REMAINING_MATCHES=",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_inline_assignment_a",
          type: "stop_process",
          description: "stop first exact preview holder",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_holder_recovery_inline_assignment_b",
          type: "stop_process",
          description: "stop second exact preview holder",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_b.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_move_after_recovery_inline_assignment",
          type: "shell_command",
          description: "move the matching folders after recovery",
          params: {
            command: [
              "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\sample-web-projects'",
              "Move-Item ...",
              "Write-Output 'MOVED_TO_DEST=sample-company-a,sample-company-b'",
              "Write-Output 'DEST_CONTENTS=sample-company-a,sample-company-b'",
              "Write-Output 'ROOT_REMAINING_MATCHES='"
            ].join("\n")
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output:
          "Shell success:\nMOVED_TO_DEST=sample-company-a,sample-company-b\r\nDEST_CONTENTS=sample-company-a,sample-company-b\r\nROOT_REMAINING_MATCHES=",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Yes, shut them down and retry the move."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(
    selected,
    "I moved sample-company-a and sample-company-b into the requested folder. I shut down 2 exact tracked preview holders first so the move could finish."
  );
});

test("selectUserFacingSummary does not render boolean proof tokens as moved folder names", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_move_exact_boolean_marker",
          type: "shell_command",
          description: "move the exact requested folder",
          params: {
            command: [
              "$source = 'sample-project-a'",
              "$destination = 'sample-folder'",
              "Move-Item -LiteralPath $source -Destination $destination -Force",
              "Write-Output 'MOVED_TO_DEST=True'",
              "Write-Output 'DEST_CONTENTS=True'",
              "Write-Output 'ROOT_REMAINING_MATCHES='"
            ].join("\n")
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output:
          "Shell success:\nMOVED_TO_DEST=True\r\nDEST_CONTENTS=True\r\nROOT_REMAINING_MATCHES=",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Please clean up my desktop now by moving only the folder named sample-project-a into sample-folder. Do not move any other desktop folders."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });

  assert.equal(selected, "I moved sample-project-a into the requested folder.");
});

test("selectUserFacingSummary surfaces a human-first read_file summary when no respond output exists", () => {
  const runResult = buildRunResult("fallback summary", [
    {
      action: {
        id: "action_read_1",
        type: "read_file",
        description: "read",
        params: { path: "README.md" },
        estimatedCostUsd: 0.05
      },
      mode: "fast_path",
      approved: true,
      output: "Read success.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "I read README.md.");
});

test("selectUserFacingSummary surfaces a human-first write_file summary when no respond output exists", () => {
  const runResult = buildRunResult("Completed task with 1 approved action(s) and 0 blocked action(s).", [
    {
      action: {
        id: "action_write_1",
        type: "write_file",
        description: "write",
        params: { path: "runtime/sandbox/output.txt", content: "hello world" },
        estimatedCostUsd: 0.08
      },
      mode: "escalation_path",
      approved: true,
      output: "Write success: runtime/sandbox/output.txt (11 chars)",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult);
  assert.equal(selected, "I created or updated runtime/sandbox/output.txt.");
});

test("selectUserFacingSummary surfaces a human-first shell summary when no respond output exists", () => {
  const runResult = buildRunResult("Completed task with 1 approved action(s) and 0 blocked action(s).", [
    {
      action: {
        id: "action_shell_1",
        type: "shell_command",
        description: "run command",
        params: { command: "npm run build" },
        estimatedCostUsd: 0.12
      },
      mode: "escalation_path",
      approved: true,
      output: "Shell success:\nBuild completed successfully.",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.equal(selected, "I ran the command successfully.\nCommand output:\nBuild completed successfully.");
});

test("selectUserFacingSummary does not mask blocked create_skill with optimistic respond output", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_skill_claim",
          type: "respond",
          description: "reply",
          params: {
            message: "I will create the skill."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I will create the skill 'stage6_live_gate' for promotion control proof. Please hold on.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_create_skill_blocked",
          type: "create_skill",
          description: "create skill",
          params: {
            skill_name: "stage6_live_gate"
          },
          estimatedCostUsd: 0.22
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["CREATE_SKILL_MISSING_NAME", "CREATE_SKILL_MISSING_CODE"],
        violations: [
          {
            code: "CREATE_SKILL_MISSING_NAME",
            message: "Create skill action requires a skill name."
          },
          {
            code: "CREATE_SKILL_MISSING_CODE",
            message: "Create skill action requires code content."
          }
        ],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult);
  assert.doesNotMatch(selected, /I will create the skill/i);
  assert.match(selected, /execute that request in this run/i);
  assert.match(selected, /CREATE_SKILL_MISSING_NAME/i);
  assert.match(selected, /CREATE_SKILL_MISSING_CODE/i);
});

test("selectUserFacingSummary does not mask blocked delete_file with optimistic respond output", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_delete_claim",
          type: "respond",
          description: "reply",
          params: {
            message: "The file has been deleted."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: `The file '${HOST_TEST_TOP_SECRET_FILE_PATH}' has been deleted successfully.`,
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_delete_file_blocked",
          type: "delete_file",
          description: "delete file",
          params: {
            path: HOST_TEST_TOP_SECRET_FILE_PATH
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
        violations: [
          {
            code: "DELETE_OUTSIDE_SANDBOX",
            message: "Delete action path resolved outside sandbox."
          }
        ],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult);
  assert.doesNotMatch(selected, /deleted successfully/i);
  assert.match(selected, /execute that request in this run/i);
  assert.match(selected, /DELETE_OUTSIDE_SANDBOX/i);
});

test("selectUserFacingSummary appends create_skill execution status when technical summary is enabled", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_skill_success",
          type: "respond",
          description: "reply",
          params: {
            message: "I will proceed with creating the skill."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I will proceed with creating the skill.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_create_skill_success",
          type: "create_skill",
          description: "create skill",
          params: {
            skill_name: "stage6_live_gate"
          },
          estimatedCostUsd: 0.22
        },
        mode: "escalation_path",
        approved: true,
        output: "Skill created successfully: stage6_live_gate.js (compat: stage6_live_gate.ts)",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /^I will proceed with creating the skill\./i);
  assert.match(selected, /Skill status: Skill created successfully: stage6_live_gate\.js/i);
});

test("selectUserFacingSummary hides create_skill execution status when technical summary is disabled", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_skill_success_2",
          type: "respond",
          description: "reply",
          params: {
            message: "I will proceed with creating the skill."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I will proceed with creating the skill.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_create_skill_success_2",
          type: "create_skill",
          description: "create skill",
          params: {
            skill_name: "stage6_live_gate"
          },
          estimatedCostUsd: 0.22
        },
        mode: "escalation_path",
        approved: true,
        output: "Skill created successfully: stage6_live_gate.js (compat: stage6_live_gate.ts)",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.equal(selected, "I will proceed with creating the skill.");
});

test("selectUserFacingSummary surfaces approved run_skill output when no respond output exists", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_run_skill_success_1",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "stage6_live_gate",
            input: "hello stage 6"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: true,
        output:
          "Run skill success: stage6_live_gate -> {\"ok\":true,\"summary\":\"stage6_live_gate executed with normalized input.\",\"normalizedInput\":\"hello stage 6\"}",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /^Run skill success:/i);
  assert.match(selected, /stage6_live_gate/i);
});

test("selectUserFacingSummary surfaces run_skill output even when technical summary is disabled", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_run_skill_success_2",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "stage6_live_gate",
            input: "hello stage 6"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: true,
        output:
          "Run skill success: stage6_live_gate -> {\"ok\":true,\"summary\":\"stage6_live_gate executed with normalized input.\",\"normalizedInput\":\"hello stage 6\"}",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /^Run skill success:/i);
  assert.match(selected, /stage6_live_gate/i);
});

test("selectUserFacingSummary appends run_skill status when respond output exists and technical summary is enabled", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_run_skill_status_1",
          type: "respond",
          description: "reply",
          params: {
            message: "Executing run_skill."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Executing the run_skill action for 'stage6_live_gate' with input 'hello stage 6'.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_run_skill_success_3",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "stage6_live_gate",
            input: "hello stage 6"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: true,
        output:
          "Run skill success: stage6_live_gate -> {\"ok\":true,\"summary\":\"stage6_live_gate executed with normalized input.\",\"normalizedInput\":\"hello stage 6\"}",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /^Executing the run_skill action/i);
  assert.match(selected, /Run skill status: Run skill success:/i);
  assert.match(selected, /stage6_live_gate/i);
});

test("selectUserFacingSummary keeps respond output only when run_skill exists and technical summary is disabled", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_run_skill_status_2",
          type: "respond",
          description: "reply",
          params: {
            message: "Executing run_skill."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Executing the run_skill action for 'stage6_live_gate' with input 'hello stage 6'.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_run_skill_success_4",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "stage6_live_gate",
            input: "hello stage 6"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: true,
        output:
          "Run skill success: stage6_live_gate -> {\"ok\":true,\"summary\":\"stage6_live_gate executed with normalized input.\",\"normalizedInput\":\"hello stage 6\"}",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.equal(
    selected,
    "Executing the run_skill action for 'stage6_live_gate' with input 'hello stage 6'."
  );
});

test("selectUserFacingSummary surfaces readiness probe output when no respond output exists", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_probe_port_ready_1",
          type: "probe_port",
          description: "probe localhost port",
          params: {
            host: "127.0.0.1",
            port: 3000
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Port ready: 127.0.0.1:3000 accepted a TCP connection.",
        executionStatus: "success",
        executionMetadata: {
          readinessProbe: true,
          probeKind: "port",
          probeReady: true,
          processLifecycleStatus: "PROCESS_READY",
          probeHost: "127.0.0.1",
          probePort: 3000
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /^Port ready:/i);
  assert.match(selected, /127\.0\.0\.1:3000/i);
});

test("selectUserFacingSummary appends readiness status when respond output exists and technical summary is enabled", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_probe_status_1",
          type: "respond",
          description: "reply",
          params: {
            message: "I started the local verification flow."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I started the local verification flow.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_probe_http_ready_1",
          type: "probe_http",
          description: "probe local http endpoint",
          params: {
            url: "http://127.0.0.1:3000/",
            expectedStatus: 200
          },
          estimatedCostUsd: 0.04
        },
        mode: "escalation_path",
        approved: true,
        output: "HTTP ready: http://127.0.0.1:3000/ responded with expected status 200.",
        executionStatus: "success",
        executionMetadata: {
          readinessProbe: true,
          probeKind: "http",
          probeReady: true,
          processLifecycleStatus: "PROCESS_READY",
          probeUrl: "http://127.0.0.1:3000/",
          probeObservedStatus: 200
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /^I started the local verification flow\./i);
  assert.match(selected, /Readiness status: HTTP ready:/i);
  assert.match(selected, /expected status 200/i);
});

test("selectUserFacingSummary surfaces browser verification output when no respond output exists", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_verify_browser_ready_1",
          type: "verify_browser",
          description: "verify browser page",
          params: {
            url: "http://127.0.0.1:3000/",
            expectedTitle: "Portfolio"
          },
          estimatedCostUsd: 0.09
        },
        mode: "escalation_path",
        approved: true,
        output: "Browser verification passed: observed title \"Portfolio Demo\"; expected title matched.",
        executionStatus: "success",
        executionMetadata: {
          browserVerification: true,
          browserVerifyPassed: true,
          browserVerifyUrl: "http://127.0.0.1:3000/",
          browserVerifyObservedTitle: "Portfolio Demo",
          browserVerifyMatchedTitle: true,
          browserVerifyExpectedTitle: "Portfolio",
          processLifecycleStatus: "PROCESS_READY"
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /^Browser verification passed:/i);
  assert.match(selected, /Portfolio Demo/i);
});

test("selectUserFacingSummary appends browser verification status when respond output exists and technical summary is enabled", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_browser_status_1",
          type: "respond",
          description: "reply",
          params: {
            message: "I verified the local app."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I verified the local app.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_verify_browser_status_1",
          type: "verify_browser",
          description: "verify browser page",
          params: {
            url: "http://127.0.0.1:3000/",
            expectedText: "Portfolio"
          },
          estimatedCostUsd: 0.09
        },
        mode: "escalation_path",
        approved: true,
        output: "Browser verification passed: observed title \"Portfolio Demo\"; expected text matched.",
        executionStatus: "success",
        executionMetadata: {
          browserVerification: true,
          browserVerifyPassed: true,
          browserVerifyUrl: "http://127.0.0.1:3000/",
          browserVerifyObservedTitle: "Portfolio Demo",
          browserVerifyMatchedText: true,
          browserVerifyExpectedText: "Portfolio",
          processLifecycleStatus: "PROCESS_READY"
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /^I verified the local app\./i);
  assert.match(selected, /Browser verification: Browser verification passed:/i);
  assert.match(selected, /expected text matched/i);
});

test("selectUserFacingSummary rewrites run_skill failure lines into deterministic no-op for execution-style prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_run_skill_failed_workflow",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "CaptureWorkflowAndCompileReplay"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: false,
        output:
          "Run skill failed: Cannot find module 'runtime/skills/CaptureWorkflowAndCompileReplay.ts'",
        blockedBy: ["ACTION_EXECUTION_FAILED"],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message: "Deterministic action execution failed."
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "Capture this flow, compile replay script, and block on selector mismatch."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
  assert.doesNotMatch(selected, /run skill failed:/i);
});

test("selectUserFacingSummary preserves run_skill failure lines for explicit run-skill prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_run_skill_failed_explicit_request",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "non_existent_skill"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: false,
        output: "Run skill failed: no skill artifact found for non_existent_skill.",
        executionStatus: "failed",
        executionFailureCode: "RUN_SKILL_ARTIFACT_MISSING",
        blockedBy: ["RUN_SKILL_ARTIFACT_MISSING"],
        violations: [
          {
            code: "RUN_SKILL_ARTIFACT_MISSING",
            message: "Run skill failed: no skill artifact found for non_existent_skill."
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "use skill non_existent_skill with input: smoke probe"
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /^Run skill failed:\s*no skill artifact found/i);
  assert.doesNotMatch(selected, /COMMUNICATION_NO_SIDE_EFFECT_EXECUTED/i);
});

test("selectUserFacingSummary preserves typed missing-skill violations even when no execution output exists", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_run_skill_blocked_missing_artifact",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "non_existent_skill"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: false,
        output: "",
        blockedBy: ["RUN_SKILL_ARTIFACT_MISSING"],
        violations: [
          {
            code: "RUN_SKILL_ARTIFACT_MISSING",
            message: "Run skill failed: no skill artifact found for non_existent_skill."
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "run skill non_existent_skill on this repo"
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /^Run skill failed:\s*no skill artifact found/i);
  assert.doesNotMatch(selected, /COMMUNICATION_NO_SIDE_EFFECT_EXECUTED/i);
});

test("selectUserFacingSummary surfaces typed run_skill execution failures without legacy output-prefix matching", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_run_skill_failed_without_prefix",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "repo_status"
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: false,
        output: "Skill execution failed without legacy run-skill prefix.",
        executionStatus: "failed",
        executionFailureCode: "ACTION_EXECUTION_FAILED",
        blockedBy: ["ACTION_EXECUTION_FAILED"],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message: "Deterministic action execution failed."
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "run skill repo_status on this repository"
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.equal(selected, "Skill execution failed without legacy run-skill prefix.");
});

test("selectUserFacingSummary rewrites destructive policy-refusal replies into deterministic no-op template", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_policy_refusal_delete_hosts",
          type: "respond",
          description: "reply",
          params: {
            message:
              "AI system notice: Deleting C:\\Windows\\System32\\drivers\\etc\\hosts is a high-risk operation that will not be performed for safety and integrity."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "AI system notice: Deleting C:\\Windows\\System32\\drivers\\etc\\hosts is a high-risk operation that will not be performed for safety and integrity.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "delete C:\\Windows\\System32\\drivers\\etc\\hosts"
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /^I couldn't execute that request in this run\./i);
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Why it didn't execute:/i);
  assert.match(selected, /What to do next:/i);
  assert.match(selected, /Technical reason code:\s*COMMUNICATION_NO_SIDE_EFFECT_EXECUTED/i);
});

test("selectUserFacingSummary explains identity impersonation blocks with clear agent identity language", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_2",
          type: "respond",
          description: "reply",
          params: {
            message: "Sure, I am human."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: false,
        blockedBy: ["IDENTITY_IMPERSONATION_DENIED"],
        violations: [
          {
            code: "IDENTITY_IMPERSONATION_DENIED",
            message: "Communication action cannot impersonate a human identity."
          }
        ],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /identity policy requires me to stay explicitly AI/i);
  assert.match(selected, /explicitly AI/i);
});

test("selectUserFacingSummary can hide safety code lines while preserving blocked explanation", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_2b",
          type: "respond",
          description: "reply",
          params: {
            message: "Sure, I am human."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: false,
        blockedBy: ["IDENTITY_IMPERSONATION_DENIED"],
        violations: [
          {
            code: "IDENTITY_IMPERSONATION_DENIED",
            message: "Communication action cannot impersonate a human identity."
          }
        ],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true,
    showSafetyCodes: false
  });
  assert.match(selected, /identity policy requires me to stay explicitly AI/i);
  assert.doesNotMatch(selected, /Safety code\(s\):/i);
});

test("selectUserFacingSummary can hide technical completion summaries when debug summary is disabled", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_read_2",
          type: "read_file",
          description: "read",
          params: { path: "README.md" },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Read success.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.equal(selected, "I read README.md.");
});

test("selectUserFacingSummary explains governance blocks from security and ethics with human-safe stance", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_shell_1",
          type: "shell_command",
          description: "Run dangerous command",
          params: {
            command: "generate malware payload"
          },
          estimatedCostUsd: 0.25
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["security", "ethics"],
        violations: [],
        votes: [
          {
            governorId: "security",
            approve: false,
            reason: "Shell command includes blocked destructive patterns.",
            confidence: 0.95
          },
          {
            governorId: "ethics",
            approve: false,
            reason: "Proposal language indicates harmful or abusive intent.",
            confidence: 0.93
          }
        ],
        decision: {
          approved: false,
          yesVotes: 5,
          noVotes: 2,
          threshold: 6,
          dissent: [
            {
              governorId: "security",
              approve: false,
              reason: "Shell command includes blocked destructive patterns.",
              confidence: 0.95
            },
            {
              governorId: "ethics",
              approve: false,
              reason: "Proposal language indicates harmful or abusive intent.",
              confidence: 0.93
            }
          ]
        }
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /matched malware\/abuse risk signals/i);
  assert.match(selected, /security and ethics governors rejected this request/i);
  assert.match(selected, /crosses that boundary/i);
});

test("selectUserFacingSummary prefers blocked explanation over generic no-op for destructive execution prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_delete_blocked_1",
          type: "delete_file",
          description: "Delete protected file",
          params: {
            path: "C:\\Windows\\System32\\drivers\\etc\\hosts"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: false,
        blockedBy: ["DELETE_PROTECTED_PATH"],
        violations: [
          {
            code: "DELETE_PROTECTED_PATH",
            message: "Delete denied for protected path: C:\\Windows\\System32\\drivers\\etc\\hosts"
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "delete C:\\Windows\\System32\\drivers\\etc\\hosts"
    }
  );

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /What happened: one or more governed actions were blocked before execution\./i);
  assert.match(selected, /Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect\./i);
  assert.match(selected, /Safety code\(s\): DELETE_PROTECTED_PATH\./i);
  assert.doesNotMatch(selected, /COMMUNICATION_NO_SIDE_EFFECT_EXECUTED/i);
});

test("selectUserFacingSummary uses high-risk delete fallback when no richer block signal is available", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 0 blocked action(s).",
    [],
    {
      userInput: "delete C:\\Windows\\System32\\drivers\\etc\\hosts"
    }
  );

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /What happened: the request targeted a high-risk delete on a protected or system path\./i);
  assert.match(selected, /Why it didn't execute: the request targeted a high-risk delete on a protected or system path, and this run did not execute a governed delete step\./i);
  assert.match(selected, /Ask for the exact block code or approval diff first/i);
});

test("selectUserFacingSummary prefers high-risk delete fallback over generic respond no-op text", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_delete_high_risk_respond_1",
          type: "respond",
          description: "Generic no-op explanation",
          params: {
            message:
              "I couldn't execute that request in this run. What happened: this run finished without executing the requested side effect. Why it didn't execute: No governed side-effect action executed in this run, so no finalized side-effect result can be reported. What to do next: Use /status for current state, or request an approval diff and approve a governed action. Technical reason code: COMMUNICATION_NO_SIDE_EFFECT_EXECUTED"
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I couldn't execute that request in this run. What happened: this run finished without executing the requested side effect. Why it didn't execute: No governed side-effect action executed in this run, so no finalized side-effect result can be reported. What to do next: Use /status for current state, or request an approval diff and approve a governed action. Technical reason code: COMMUNICATION_NO_SIDE_EFFECT_EXECUTED",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "BigBrain /chat delete C:\\Windows\\System32\\drivers\\etc\\hosts"
    }
  );

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /What happened: the request targeted a high-risk delete on a protected or system path\./i);
  assert.match(selected, /Ask for the exact block code or approval diff first/i);
  assert.doesNotMatch(selected, /Use \/status for current state, or request an approval diff and approve a governed action\./i);
});

test("selectUserFacingSummary includes governor rationale for governance block reasons", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_write_1",
          type: "write_file",
          description: "Write to protected path",
          params: {
            path: ".env"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["compliance"],
        violations: [],
        votes: [
          {
            governorId: "compliance",
            approve: false,
            reason: "Write targets a policy-protected path.",
            confidence: 0.9
          }
        ],
        decision: {
          approved: false,
          yesVotes: 5,
          noVotes: 1,
          threshold: 6,
          dissent: [
            {
              governorId: "compliance",
              approve: false,
              reason: "Write targets a policy-protected path.",
              confidence: 0.9
            }
          ]
        }
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /compliance governor rejected this request/i);
  assert.match(selected, /main concerns: compliance: write targets a policy-protected path\./i);
});

test("selectUserFacingSummary treats ransomware and credential-theft governance reasons as abuse signals", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_net_1",
          type: "network_write",
          description: "Send suspicious payload",
          params: {
            endpoint: "https://example.invalid"
          },
          estimatedCostUsd: 0.15
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["security", "ethics"],
        violations: [],
        votes: [
          {
            governorId: "security",
            approve: false,
            reason: "Detected ransomware workflow and data exfiltration intent.",
            confidence: 0.95
          },
          {
            governorId: "ethics",
            approve: false,
            reason: "Request appears to pursue credential theft behavior.",
            confidence: 0.93
          }
        ],
        decision: {
          approved: false,
          yesVotes: 5,
          noVotes: 2,
          threshold: 6,
          dissent: [
            {
              governorId: "security",
              approve: false,
              reason: "Detected ransomware workflow and data exfiltration intent.",
              confidence: 0.95
            },
            {
              governorId: "ethics",
              approve: false,
              reason: "Request appears to pursue credential theft behavior.",
              confidence: 0.93
            }
          ]
        }
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /matched malware\/abuse risk signals/i);
  assert.match(selected, /security and ethics governors rejected this request/i);
});

test("selectUserFacingSummary prefers structured abuse reject categories over free-text matching", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_net_2",
          type: "network_write",
          description: "Send suspicious payload",
          params: {
            endpoint: "https://example.invalid"
          },
          estimatedCostUsd: 0.15
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["security", "ethics"],
        violations: [],
        votes: [
          {
            governorId: "security",
            approve: false,
            reason: "Rejected by safety policy.",
            confidence: 0.95,
            rejectCategory: "ABUSE_MALWARE_OR_FRAUD"
          },
          {
            governorId: "ethics",
            approve: false,
            reason: "Rejected by ethics policy.",
            confidence: 0.93,
            rejectCategory: "ABUSE_MALWARE_OR_FRAUD"
          }
        ],
        decision: {
          approved: false,
          yesVotes: 5,
          noVotes: 2,
          threshold: 6,
          dissent: [
            {
              governorId: "security",
              approve: false,
              reason: "Rejected by safety policy.",
              confidence: 0.95,
              rejectCategory: "ABUSE_MALWARE_OR_FRAUD"
            },
            {
              governorId: "ethics",
              approve: false,
              reason: "Rejected by ethics policy.",
              confidence: 0.93,
              rejectCategory: "ABUSE_MALWARE_OR_FRAUD"
            }
          ]
        }
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /matched malware\/abuse risk signals/i);
  assert.match(selected, /security and ethics governors rejected this request/i);
});

test("selectUserFacingSummary appends mission diagnostics for mission status prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_read_for_mission_diag",
          type: "read_file",
          description: "read context",
          params: {
            path: "docs/stages/stage_6_85_it_just_works_orchestration.md"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Read success.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_write_for_mission_diag",
          type: "write_file",
          description: "write updates",
          params: {
            path: "runtime/evidence/stage6_85_manual_review.md",
            content: "updated"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["WRITE_PROTECTED_PATH"],
        violations: [
          {
            code: "WRITE_PROTECTED_PATH",
            message: "Write action path is protected by policy."
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "Show what will run, what ran, and why mission is blocked or waiting for approval."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /Run summary:/i);
  assert.match(selected, /- State: blocked/i);
  assert.match(selected, /- What will run: read_file, write_file/i);
  assert.match(selected, /- What ran: read_file/i);
  assert.match(selected, /- Why stopped\/blocked: WRITE_PROTECTED_PATH/i);
});

test("selectUserFacingSummary does not force diagnostics for pulse prompts that only include completion-claim text in historical context", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_for_pulse_checkin",
          type: "respond",
          description: "reply",
          params: {
            message: "Quick check-in: any updates you want me to track?"
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Quick check-in: any updates you want me to track?",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: [
        "System-generated Agent Pulse check-in request.",
        "Return one concise proactive check-in message in natural language.",
        "Be truthful that you are an AI assistant if that identity is directly relevant, but do not prepend labels like 'AI assistant response' or 'AI assistant check-in'.",
        "",
        "Agent Pulse request:",
        "Agent Pulse proactive check-in request. Reason code: stale_fact_revalidation.",
        "",
        "Recent conversation context (oldest to newest):",
        "- user: Claim this task is complete only if deterministic proof artifacts exist; otherwise block the done claim."
      ].join("\n")
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.doesNotMatch(selected, /Run summary:/i);
  assert.equal(selected, "Quick check-in: any updates you want me to track?");
});

test("selectUserFacingSummary replaces narrative text with deterministic block for mission diagnostics prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_for_timeline_diag",
          type: "respond",
          description: "reply",
          params: {
            message: "Here is the ordered mission timeline for the last run."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "Here is the ordered mission timeline for the last run:\n1. Initialization - 2026-02-24T21:44:44Z",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Show the ordered mission timeline for the last run and explain deterministic remediation for any failure."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /^Run summary:/i);
  assert.doesNotMatch(selected, /Initialization - 2026-02-24T21:44:44Z/i);
});

test("selectUserFacingSummary appends deterministic stable approval diff for diff prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_read_for_approval_diff",
          type: "read_file",
          description: "read context",
          params: {
            path: "docs/stages/stage_6_85_it_just_works_orchestration.md"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Read success.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_write_for_approval_diff",
          type: "write_file",
          description: "write updates",
          params: {
            path: "runtime/evidence/stage6_85_manual_review.md",
            content: "updated"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["WRITE_PROTECTED_PATH"],
        violations: [
          {
            code: "WRITE_PROTECTED_PATH",
            message: "Write action path is protected by policy."
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "Show exact approval diff and wait for step-level approval."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /- Approval diff:/i);
  assert.match(selected, /01\. read_file: read context/i);
  assert.match(selected, /02\. write_file: write updates/i);
  assert.match(selected, /- Approval mode: approve_step/i);
});

test("selectUserFacingSummary maps skill lifecycle actions to tier three diagnostics", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_update_skill_diagnostics",
          type: "update_skill",
          description: "update skill guidance",
          params: {
            name: "browser_recovery_notes",
            instructions: "Use tracked browser sessions and exact process leases."
          },
          estimatedCostUsd: 0.12
        },
        mode: "escalation_path",
        approved: true,
        output: "Updated skill guidance.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Show exact approval diff and wait for step-level approval."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });

  assert.match(selected, /- What will run: update_skill/i);
  assert.match(selected, /- Approval mode: approve_step \(Tier >= 3 step defaults/i);
  assert.doesNotMatch(selected, /Tier derivation failed/i);
});

test("selectUserFacingSummary marks approval flow as not applicable for respond-only diff prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_for_respond_only_diff",
          type: "respond",
          description: "reply",
          params: {
            message: "Providing requested approval diff."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Providing requested approval diff.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Show exact approval diff and wait for step-level approval."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /- Approval mode: not_applicable/i);
  assert.match(selected, /- Approval diff:\nnone \(respond-only plan in this run; no side-effect diff to approve\)\./i);
  assert.match(selected, /Request a governed side-effect action to enter approval diff flow/i);
});

test("selectUserFacingSummary replaces progress placeholder respond text with deterministic completion wording", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder",
          type: "respond",
          description: "reply",
          params: {
            message: "I will research that and provide findings shortly."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I will research that and provide findings shortly.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*COMMUNICATION_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary uses research-specific placeholder fallback wording", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder_research",
          type: "respond",
          description: "reply",
          params: {
            message: "I am currently researching and will provide findings shortly."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I am currently researching and will provide findings shortly.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Research deterministic sandboxing controls and provide distilled findings with proof refs."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /live research execution did not complete in this run/i);
  assert.match(selected, /baseline deterministic sandboxing controls/i);
  assert.doesNotMatch(selected, /nist sp 800-190/i);
  assert.match(selected, /request governed retrieval/i);
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*RESEARCH_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites future-promise research output for execution-style research prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder_research_future_promise",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I will research deterministic sandboxing controls and provide you with distilled findings along with the necessary proof references."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I will research deterministic sandboxing controls and provide you with distilled findings along with the necessary proof references.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Research deterministic sandboxing controls and provide distilled findings with proof refs."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /live research execution did not complete in this run/i);
  assert.match(selected, /baseline deterministic sandboxing controls/i);
  assert.doesNotMatch(selected, /nist sp 800-190/i);
  assert.match(selected, /request governed retrieval/i);
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*RESEARCH_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites instructional how-to output for execution-style build prompts with no side effects", () => {
  const howToOutput = [
    "To build a minimal deterministic TypeScript CLI scaffold, follow these steps:",
    "1. Initialize the project.",
    "2. Add TypeScript configuration.",
    "3. Create README, runbook, and tests."
  ].join("\n");

  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_instructional_build_noop",
          type: "respond",
          description: "reply",
          params: {
            message: howToOutput
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: howToOutput,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Build a minimal deterministic TypeScript CLI scaffold with README, runbook, and tests."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*BUILD_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary routes generic react-app creation prompts to build no-op fallback when no side effects execute", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_generic_react_build_noop",
          type: "respond",
          description: "reply",
          params: {
            message:
              "Here are starter instructions and files to create your React app manually."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "Here are starter instructions and files to create your React app manually.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Create a React app on my Desktop and execute now."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*BUILD_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary explains live build verification limits for npm-start app prompts with no side effects", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_live_build_noop",
          type: "respond",
          description: "reply",
          params: {
            message: "Please run npm start manually and tell me what you see."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Please run npm start manually and tell me what you see.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Create a React app on my Desktop, run npm start, and verify the homepage UI. Execute now using cmd."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /I didn't complete the requested live app run in this run\./i);
  assert.match(
    selected,
    /Local readiness probes can verify loopback port\/http availability, and verify_browser can prove basic page expectations when Playwright is installed locally/i
  );
  assert.match(
    selected,
    /Ask for a finite build flow first \(scaffold, edit, install, build\), then request start_process plus probe_port or probe_http .* verify_browser/i
  );
  assert.match(selected, /Technical reason code:\s*BUILD_NO_SIDE_EFFECT_EXECUTED/i);
});

test("selectUserFacingSummary humanizes live build policy blocks when process start is denied", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_shell_command_live_build_simulated",
          type: "shell_command",
          description: "run finite build proof step",
          params: {
            command: "npm run build"
          },
          estimatedCostUsd: 0.3
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell execution simulated (real shell execution disabled by policy).",
        executionMetadata: {
          simulatedExecution: true,
          simulatedExecutionReason: "SHELL_POLICY_DISABLED"
        },
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_start_process_live_build_blocked",
          type: "start_process",
          description: "start managed dev server",
          params: {
            command: "npm start"
          },
          estimatedCostUsd: 0.3
        },
        mode: "escalation_path",
        approved: false,
        output: "Process start blocked: real shell execution is disabled by policy.",
        executionStatus: "blocked",
        executionFailureCode: "PROCESS_DISABLED_BY_POLICY",
        blockedBy: ["PROCESS_DISABLED_BY_POLICY"],
        violations: [
          {
            code: "PROCESS_DISABLED_BY_POLICY",
            message: "Managed process actions are disabled in current runtime profile."
          }
        ],
        votes: []
      },
      {
        action: {
          id: "action_verify_browser_live_build_failed",
          type: "verify_browser",
          description: "verify homepage",
          params: {
            url: "http://127.0.0.1:3000/"
          },
          estimatedCostUsd: 0.12
        },
        mode: "escalation_path",
        approved: true,
        output:
          "Browser verification failed: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/",
        executionStatus: "failed",
        executionFailureCode: "BROWSER_VERIFY_EXPECTATION_FAILED",
        executionMetadata: {
          browserVerification: true,
          browserVerifyPassed: false,
          browserUrl: "http://127.0.0.1:3000/"
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Create a React app on my Desktop, run npm start, and verify the homepage UI. Execute now using cmd."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false,
    showSafetyCodes: true
  });
  assert.match(selected, /I couldn't start the requested live app run in this run\./i);
  assert.match(
    selected,
    /the runtime blocked the shell\/process action needed to run the app/i
  );
  assert.match(
    selected,
    /real shell\/process execution is disabled in this environment, so I can't truthfully claim the app was running or the UI was verified/i
  );
  assert.match(
    selected,
    /start_process plus probe_port or probe_http and verify_browser/i
  );
  assert.match(selected, /Safety code\(s\): PROCESS_DISABLED_BY_POLICY\./i);
  assert.doesNotMatch(selected, /one or more governed actions were blocked before execution/i);
  assert.doesNotMatch(selected, /^Browser verification passed:/i);
});

test("selectUserFacingSummary prefers build no-op fallback over raw probe output when no real build side effect executed", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_probe_port_not_ready_build_noop",
          type: "probe_port",
          description: "probe localhost port",
          params: {
            host: "127.0.0.1",
            port: 3000
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Port not ready: 127.0.0.1:3000 did not accept a TCP connection within 2000ms.",
        executionStatus: "failed",
        executionFailureCode: "PROCESS_NOT_READY",
        executionMetadata: {
          readinessProbe: true,
          probeKind: "port",
          probeReady: false,
          processLifecycleStatus: "PROCESS_NOT_READY",
          probeHost: "127.0.0.1",
          probePort: 3000
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        `Create a static HTML site at ${HOST_TEST_SAMPLE_SITE_DIR} for a sample service company with placeholder images. Create files directly and execute now.`
    }
  );

  const selected = selectUserFacingSummary(runResult);
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Why it didn't execute:/i);
  assert.match(selected, /What to do next:/i);
  assert.match(selected, /Technical reason code:\s*BUILD_NO_SIDE_EFFECT_EXECUTED/i);
  assert.doesNotMatch(selected, /^Port not ready:/i);
});

test("selectUserFacingSummary keeps instructional how-to output for explicit explanation prompts", () => {
  const howToOutput = [
    "To build a minimal deterministic TypeScript CLI scaffold, follow these steps:",
    "1. Initialize the project.",
    "2. Add TypeScript configuration.",
    "3. Create README, runbook, and tests."
  ].join("\n");

  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_instructional_build_explain",
          type: "respond",
          description: "reply",
          params: {
            message: howToOutput
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: howToOutput,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "How do I build a minimal deterministic TypeScript CLI scaffold with README, runbook, and tests?"
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.equal(selected, howToOutput);
});

test("selectUserFacingSummary rewrites stage-review latency promise placeholders to deterministic fallback wording", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder_latency",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I will keep this mission interactive and monitor the latency budgets."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I will keep this mission interactive and monitor the latency budgets.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Keep this mission interactive under latency budgets and tell me if any phase exceeded its budget."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites latency assurance promise placeholders that use ensure phrasing", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder_latency_ensure",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I will ensure that this mission remains interactive within the specified latency budgets. If any phase exceeds its budget, I will promptly inform you."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I will ensure that this mission remains interactive within the specified latency budgets. If any phase exceeds its budget, I will promptly inform you.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Keep this mission interactive under latency budgets and tell me if any phase exceeded its budget."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites cache-reuse promise placeholders for stage-review latency checks", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder_latency_reuse",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I will reuse safe deterministic cache paths as requested and ensure that no extra model calls are added beyond the baseline behavior."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I will reuse safe deterministic cache paths as requested and ensure that no extra model calls are added beyond the baseline behavior.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Reuse safe deterministic cache paths but do not add extra model calls beyond baseline behavior."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary keeps latency cache no-op fallback when only read-only actions are approved", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_list_directory_latency_cache_probe",
          type: "list_directory",
          description: "Inspect cache directory layout.",
          params: {
            path: "runtime/cache"
          },
          estimatedCostUsd: 0.04
        },
        mode: "escalation_path",
        approved: true,
        output: "cache entries: 3",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Reuse safe deterministic cache paths but do not add extra model calls beyond baseline behavior."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary normalizes latency no-op text drift into deterministic no-op envelope", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_latency_drift_reply",
          type: "respond",
          description: "reply",
          params: {
            message:
              "No phase exceeded its latency budget in this run, as no execution evidence is available. (reasonCode: LATENCY_NO_SIDE_EFFECT_EXECUTED)"
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "No phase exceeded its latency budget in this run, as no execution evidence is available. (reasonCode: LATENCY_NO_SIDE_EFFECT_EXECUTED)",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_write_file_latency_aux",
          type: "write_file",
          description: "write auxiliary latency note",
          params: {
            path: "runtime/evidence/latency_note.txt",
            content: "auxiliary note"
          },
          estimatedCostUsd: 0.06
        },
        mode: "escalation_path",
        approved: true,
        output: "note written",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Keep this mission interactive under latency budgets and tell me if any phase exceeded its budget."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites stage-review evidence-bundle promise placeholders without forcing mission diagnostics", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder_evidence_bundle",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I will proceed to export the redacted evidence bundle for this Stage 6.85 review."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I will proceed to export the redacted evidence bundle for this Stage 6.85 review.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Export a redacted evidence bundle for this Stage 6.85 review."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*OBSERVABILITY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
  assert.doesNotMatch(selected, /Run summary:/i);
});

test("selectUserFacingSummary surfaces executed observability export writes as direct outcomes", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_write_file_observability_bundle_export",
          type: "write_file",
          description: "Write redacted evidence bundle to sandbox path.",
          params: {
            path: "runtime/evidence/stage_6.85_review_redacted_bundle.txt",
            content: "redacted bundle payload"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: true,
        output: "bundle written",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Export a redacted evidence bundle for this Stage 6.85 review."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.equal(
    selected,
    "I created or updated runtime/evidence/stage_6.85_review_redacted_bundle.txt."
  );
});

test("selectUserFacingSummary rewrites clarification-loop output for execution-style workflow prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_workflow_clarification_loop",
          type: "respond",
          description: "reply",
          params: {
            message:
              "Could you please provide any specific details or parameters for the workflow capture?"
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "Could you please provide any specific details or parameters for the workflow capture?",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Capture this browser workflow, compile replay steps, and block if selector drift appears."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites execution no-op phrasing for execution-style workflow prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_workflow_execution_noop",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I cannot execute the action to capture the browser workflow and compile replay steps in this run. Please let me know if you need assistance with anything else."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I cannot execute the action to capture the browser workflow and compile replay steps in this run. Please let me know if you need assistance with anything else.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Capture this browser workflow, compile replay steps, and block if selector drift appears."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites non-question clarification workflow replies for execution-style prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_workflow_clarification_no_question",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I understand you want workflow replay, but I cannot execute actions that involve direct browser interaction without further details. Please provide more information on how you would like to proceed."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I understand you want workflow replay, but I cannot execute actions that involve direct browser interaction without further details. Please provide more information on how you would like to proceed.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Capture this browser workflow, compile replay steps, and block if selector drift appears."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites workflow confirmation-loop replies for execution-style prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_workflow_confirmation_loop",
          type: "respond",
          description: "reply",
          params: {
            message:
              "To capture the browser workflow and compile replay steps, I will monitor interactions and block selector drift. Please confirm if you would like to proceed with this approach."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "To capture the browser workflow and compile replay steps, I will monitor interactions and block selector drift. Please confirm if you would like to proceed with this approach.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Capture this browser workflow, compile replay steps, and block if selector drift appears."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites capability-limitation workflow replies for execution-style prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_workflow_capability_limitation",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I understand you want to capture the browser workflow and compile replay steps while blocking selector drift. However, I currently cannot execute this action directly."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I understand you want to capture the browser workflow and compile replay steps while blocking selector drift. However, I currently cannot execute this action directly.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Capture this browser workflow, compile replay steps, and block if selector drift appears."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites capability-limitation evidence export replies for execution-style prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_observability_capability_limitation",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I can assist with exporting a redacted evidence bundle for the Stage 6.85 review. However, I cannot execute this request directly due to safety policies in place."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I can assist with exporting a redacted evidence bundle for the Stage 6.85 review. However, I cannot execute this request directly due to safety policies in place.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Export a redacted evidence bundle for this Stage 6.85 review."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*OBSERVABILITY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites capability-limitation recovery replies for retry-budget prompts", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_capability_limitation",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I understand that you want to retry the blocked step repeatedly and track when the retry budget is exhausted. However, I cannot execute side effects or retry actions directly in this context."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I understand that you want to retry the blocked step repeatedly and track when the retry budget is exhausted. However, I cannot execute side effects or retry actions directly in this context.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Retry this blocked step repeatedly and show when retry budget is exhausted and mission stop limit is reached."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*RECOVERY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites recovery clarification replies that ask for more instructions", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_clarification_loop",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I understand that you want to continue the mission safely after the interruption. We will resume from the last durable checkpoint. Please let me know if you have any specific instructions or details to share."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I understand that you want to continue the mission safely after the interruption. We will resume from the last durable checkpoint. Please let me know if you have any specific instructions or details to share.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Continue the same mission safely after interruption and resume from the last durable checkpoint."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*RECOVERY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites recovery future-promise replies that only describe retries", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_future_promise",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I will attempt to retry the blocked step repeatedly until the retry budget is exhausted and the mission stop limit is reached."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I will attempt to retry the blocked step repeatedly until the retry budget is exhausted and the mission stop limit is reached.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Retry this blocked step repeatedly and show when retry budget is exhausted and mission stop limit is reached."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*RECOVERY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites recovery narrative acknowledgements that avoid concrete execution", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_recovery_narrative_ack",
          type: "respond",
          description: "reply",
          params: {
            message:
              "I understand that you want to retry the blocked step repeatedly. However, please note that there are limits to how many times we can attempt a retry before the budget is exhausted and the mission stop limit is reached. I will keep you updated on the status of the retries and notify you when we reach those limits."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "I understand that you want to retry the blocked step repeatedly. However, please note that there are limits to how many times we can attempt a retry before the budget is exhausted and the mission stop limit is reached. I will keep you updated on the status of the retries and notify you when we reach those limits.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Retry this blocked step repeatedly and show when retry budget is exhausted and mission stop limit is reached."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*RECOVERY_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary rewrites progress placeholders before technical run_skill status lines", () => {
  const runResult = buildRunResult(
    "Completed task with 2 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_progress_placeholder_with_run_skill",
          type: "respond",
          description: "reply",
          params: {
            message: "I will send the result when it is done."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "I will send the result when it is done.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_run_skill_progress_placeholder_status",
          type: "run_skill",
          description: "run skill",
          params: {
            name: "stage6_5_distiller_safe",
            input: "Research deterministic sandboxing controls."
          },
          estimatedCostUsd: 0.1
        },
        mode: "fast_path",
        approved: true,
        output:
          "Run skill success: stage6_5_distiller_safe -> {\"ok\":true,\"summary\":\"stage6_5_distiller_safe executed with normalized input.\"}",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(
    selected,
    /^This run finished, but the drafted chat reply was only a progress update\. Here is the deterministic execution status:/i
  );
  assert.match(selected, /Run skill status: Run skill success:/i);
  assert.doesNotMatch(selected, /I will send the result when it is done\./i);
});

test("selectUserFacingSummary rewrites contradiction cues for first-person status updates", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_status_contradiction",
          type: "respond",
          description: "reply",
          params: {
            message: "It seems there might be a misunderstanding. My records show your tax filing is complete."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "It seems there might be a misunderstanding. My records show your tax filing is complete.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "my followup.tax filing is pending."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /Noted: my followup\.tax filing is pending\./i);
  assert.match(selected, /latest status for this turn/i);
  assert.doesNotMatch(selected, /records show your tax filing is complete/i);
});

test("selectUserFacingSummary surfaces failed verification gate when deterministic proof artifacts are missing", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_for_proof_gate",
          type: "respond",
          description: "reply",
          params: {
            message: "Checking deterministic proof artifacts."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Checking deterministic proof artifacts.",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput:
        "Claim this task is complete only if deterministic proof artifacts exist; otherwise block the done claim."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /Run summary:/i);
  assert.match(selected, /- Verification gate: failed/i);
  assert.match(
    selected,
    /Verification gate failed because no completion proof or waiver was provided/i
  );
});

test("selectUserFacingSummary includes VERIFICATION_GATE_FAILED safety code even when another block code is present", () => {
  const runResult = buildRunResult(
    "Task ended blocked with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_list_directory_missing_path",
          type: "list_directory",
          description: "List current directory for proof artifacts.",
          params: {},
          estimatedCostUsd: 0.05
        },
        mode: "escalation_path",
        approved: false,
        output: undefined,
        blockedBy: ["LIST_MISSING_PATH"],
        violations: [
          {
            code: "LIST_MISSING_PATH",
            message: "Path parameter is required."
          }
        ],
        votes: []
      }
    ],
    {
      userInput:
        "Claim this task is complete only if deterministic proof artifacts exist; otherwise block the done claim."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });

  assert.match(selected, /Safety code\(s\):/i);
  assert.match(selected, /\bLIST_MISSING_PATH\b/i);
  assert.match(selected, /\bVERIFICATION_GATE_FAILED\b/i);
});

test("selectUserFacingSummary reports blocked mission diagnostics for run_skill execution failures", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_run_skill_failed_runtime",
          type: "run_skill",
          description: "Build deterministic TypeScript CLI scaffold.",
          params: {
            name: "build_deterministic_typescript_cli",
            input: "build deterministic scaffold"
          },
          estimatedCostUsd: 0.1
        },
        mode: "escalation_path",
        approved: false,
        output:
          "Run skill failed: Cannot find module 'runtime/skills/build_deterministic_typescript_cli.ts'",
        blockedBy: ["ACTION_EXECUTION_FAILED"],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "Run skill failed: Cannot find module 'runtime/skills/build_deterministic_typescript_cli.ts'"
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "Show what will run, what ran, and why mission is blocked or waiting for approval."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /Run skill failed:/i);
  assert.match(selected, /Run summary:/i);
  assert.match(selected, /- State: blocked/i);
  assert.match(selected, /- Why stopped\/blocked: ACTION_EXECUTION_FAILED/i);
  assert.match(
    selected,
    /- Verification gate: not_applicable \(completion-claim gate not requested for this prompt\)/i
  );
});

test("selectUserFacingSummary surfaces exact runtime failure detail for blocked shell execution runs", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_shell_runtime_failure_blocked_summary",
          type: "shell_command",
          description: "start preview server",
          params: {
            command: "npm run dev"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: false,
        output: "Shell failed: spawn ENAMETOOLONG",
        blockedBy: ["ACTION_EXECUTION_FAILED"],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message: "Shell failed: spawn ENAMETOOLONG"
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "build it and leave it open for me"
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened: a runtime execution step failed: Shell failed: spawn ENAMETOOLONG\./i);
  assert.match(selected, /What to do next: inspect the failing step and retry after fixing that runtime issue\./i);
});

test("selectUserFacingSummary routes schedule prompts to typed unsupported no-op when no side effects executed", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_schedule_noop",
          type: "respond",
          description: "reply",
          params: {
            message:
              "Run summary:\n- State: completed\n- Approval diff:\nnone (respond-only plan in this run; no side-effect diff to approve)."
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output:
          "Run summary:\n- State: completed\n- Approval diff:\nnone (respond-only plan in this run; no side-effect diff to approve).",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Schedule 3 focus blocks next week and show exact approval diff before any write."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /What happened:/i);
  assert.match(selected, /Technical reason code:\s*CALENDAR_PROPOSE_NOT_AVAILABLE/i);
  assert.match(selected, /What to do next:/i);
});

test("selectUserFacingSummary answers clone block-reason prompts with policy explanation", () => {
  const runResult = buildRunResult(
    "Completed task with 1 approved action(s) and 0 blocked action(s).",
    [
      {
        action: {
          id: "action_respond_clone_block_reason",
          type: "respond",
          description: "reply",
          params: {
            message: "Run summary:\n- State: completed\n- Why stopped/blocked: none"
          },
          estimatedCostUsd: 0.02
        },
        mode: "fast_path",
        approved: true,
        output: "Run summary:\n- State: completed\n- Why stopped/blocked: none",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    {
      userInput: "Show why non-mergeable clone packet kinds are blocked."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: false
  });
  assert.match(selected, /Non-mergeable clone packet kinds are blocked/i);
  assert.match(selected, /Blocked kinds:/i);
  assert.match(selected, /Next step:/i);
});

test("selectUserFacingSummary applies TruthPolicyV1 so blocked diagnostics never claim completion", () => {
  const runResult = buildRunResult(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    [
      {
        action: {
          id: "action_write_blocked_truth_policy",
          type: "write_file",
          description: "write blocked",
          params: {
            path: "runtime/evidence/stage6_85_manual_review.md",
            content: "blocked"
          },
          estimatedCostUsd: 0.04
        },
        mode: "escalation_path",
        approved: false,
        output: "",
        blockedBy: ["WRITE_PROTECTED_PATH"],
        violations: [
          {
            code: "WRITE_PROTECTED_PATH",
            message: "Write action path is protected by policy."
          }
        ],
        votes: []
      }
    ],
    {
      userInput: "Show what will run, what ran, and why mission is blocked or waiting for approval."
    }
  );

  const selected = selectUserFacingSummary(runResult, {
    showTechnicalSummary: true
  });
  assert.match(selected, /Run summary:/i);
  assert.match(selected, /Task ended blocked with 0 approved action\(s\) and 1 blocked action\(s\)\./i);
  assert.doesNotMatch(selected, /Completed task with 0 approved action\(s\) and 1 blocked action\(s\)\./i);
});





