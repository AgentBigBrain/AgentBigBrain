/**
 * @fileoverview Covers user-facing recent-action, waiting-state, and destination recall rendering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskRunResult } from "../../src/core/types";
import {
  deriveConversationLedgersFromTaskRunResult,
  renderConversationStatusOrRecall
} from "../../src/interfaces/conversationRuntime/recentActionLedger";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import {
  buildConversationBrowserSessionFixture,
  buildConversationJobFixture
} from "../helpers/conversationFixtures";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-recent-action-ledger",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-12T00:00:00.000Z"
    }),
    ...overrides
  };
}

test("renderConversationStatusOrRecall answers what just happened using the latest concrete action", () => {
  const session = buildSession({
    recentActions: [
      {
        id: "task-summary",
        kind: "task_summary",
        label: "Latest completed task",
        location: null,
        status: "completed",
        sourceJobId: "job-1",
        at: "2026-03-12T00:00:05.000Z",
        summary: "Completed the task."
      },
      {
        id: "file-action",
        kind: "file",
        label: "Landing page file",
        location: "C:\\Users\\testuser\\Desktop\\123\\index.html",
        status: "created",
        sourceJobId: "job-1",
        at: "2026-03-12T00:00:04.000Z",
        summary: "Created the landing page."
      }
    ]
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "What did you just do?"
  );

  assert.equal(reply, "I updated index.html.");
});

test("renderConversationStatusOrRecall prefers file edits for tell-me-about-your-changes follow-ups", () => {
  const session = buildSession({
    recentJobs: [
      buildConversationJobFixture({
        id: "job-2",
        input: "build the landing page and leave it open",
        executionInput: "build the landing page and leave it open",
        createdAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:01.500Z",
        completedAt: "2026-03-12T00:00:02.000Z",
        status: "completed",
        resultSummary: "I opened http://127.0.0.1:4177/ in your browser and left it open.",
        ackEligibleAt: "2026-03-12T00:00:01.100Z"
      }),
      buildConversationJobFixture({
        id: "job-3",
        input: "change the hero image to a slider instead of the landing page",
        executionInput: "change the hero image to a slider instead of the landing page",
        createdAt: "2026-03-12T00:00:03.000Z",
        startedAt: "2026-03-12T00:00:03.500Z",
        completedAt: "2026-03-12T00:00:05.000Z",
        status: "completed",
        resultSummary: "I updated index.html and kept the preview open.",
        ackEligibleAt: "2026-03-12T00:00:03.100Z"
      })
    ],
    recentActions: [
      {
        id: "browser-action",
        kind: "browser_session",
        label: "Browser window",
        location: "http://127.0.0.1:4177/",
        status: "open",
        sourceJobId: "job-3",
        at: "2026-03-12T00:00:05.000Z",
        summary: "Brought the preview browser window forward."
      },
      {
        id: "file-action-styles",
        kind: "file",
        label: "File styles.css",
        location: "C:\\Users\\testuser\\Desktop\\123\\styles.css",
        status: "updated",
        sourceJobId: "job-3",
        at: "2026-03-12T00:00:04.000Z",
        summary: "Updated the slider styling."
      },
      {
        id: "file-action-index",
        kind: "file",
        label: "File index.html",
        location: "C:\\Users\\testuser\\Desktop\\123\\index.html",
        status: "updated",
        sourceJobId: "job-3",
        at: "2026-03-12T00:00:03.000Z",
        summary: "Updated the hero markup to a slider."
      },
      {
        id: "older-file-action-index",
        kind: "file",
        label: "File index.html",
        location: "C:\\Users\\testuser\\Desktop\\older\\index.html",
        status: "updated",
        sourceJobId: "job-2",
        at: "2026-03-12T00:00:02.000Z",
        summary: "Created the original landing page."
      }
    ],
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser-session-1",
        label: "Browser window",
        url: "http://127.0.0.1:4177/",
        status: "open",
        openedAt: "2026-03-12T00:00:05.000Z",
        sourceJobId: "job-3",
        linkedProcessLeaseId: "proc_preview_1",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\123",
        linkedProcessPid: 43125
      })
    ]
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "Okay tell me about your changes so I know what you changed."
  );

  assert.match(reply, /^I updated styles\.css and index\.html\./);
  assert.match(reply, /The hero section now uses a slider\./);
  assert.match(reply, /The preview is still open at http:\/\/127\.0\.0\.1:4177\/\./);
  assert.doesNotMatch(reply, /older\\index\.html/i);
});

test("renderConversationStatusOrRecall answers what it is waiting on in plain language", () => {
  const session = buildSession({
    progressState: {
      status: "waiting_for_user",
      message: "whether you want me to plan it first or build it now",
      jobId: null,
      updatedAt: "2026-03-12T00:00:05.000Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "What are you waiting on from me right now?"
  );

  assert.equal(
    reply,
    "I'm waiting on you for whether you want me to plan it first or build it now."
  );
});

test("renderConversationStatusOrRecall returns a review-oriented durable handoff summary", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-4",
      status: "completed",
      goal: "Build the landing page and leave a preview open.",
      summary: "I finished the landing page and left the preview ready for review.",
      nextSuggestedStep: "Tell me what section you want changed next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-4",
      updatedAt: "2026-03-12T00:00:08.000Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "Show me what is ready to review."
  );

  assert.match(reply, /Here is what is ready to review: I finished the landing page and left the preview ready for review\./);
  assert.match(reply, /Status: Finished and ready for your review\./);
  assert.match(reply, /Workspace: C:\\Users\\testuser\\Desktop\\drone-company/);
  assert.match(reply, /Preview: http:\/\/127\.0\.0\.1:4177\/index\.html/);
  assert.match(reply, /Next step: Tell me what section you want changed next\./);
});

test("renderConversationStatusOrRecall treats rough-draft review prompts as paused handoff summaries", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-4b",
      status: "waiting_for_user",
      goal: "Build the landing page and leave the preview open for review.",
      summary: "I finished the first draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-4b",
      updatedAt: "2026-03-12T00:00:08.500Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "Show me the rough draft."
  );

  assert.match(reply, /Here is what is ready to review: I finished the first draft and paused at the review checkpoint\./);
  assert.match(reply, /Status: Paused here with a saved checkpoint ready for your review or next change request\./);
  assert.match(reply, /Primary artifact: C:\\Users\\testuser\\Desktop\\drone-company\\index\.html/);
  assert.match(reply, /Next step: Tell me what section you want me to refine next\./);
});

test("renderConversationStatusOrRecall uses the durable handoff for while-you-were-away review questions", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-5",
      status: "completed",
      goal: "Build the landing page and leave the preview open.",
      summary: "I finished the landing page draft and left the preview ready for review.",
      nextSuggestedStep: "Tell me which section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-5",
      updatedAt: "2026-03-12T00:00:09.000Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "Okay, what changed while I was away?"
  );

  assert.match(reply, /While you were away, I finished the landing page draft and left the preview ready for review\./);
  assert.match(reply, /Best first look: open the preview at http:\/\/127\.0\.0\.1:4177\/index\.html\./);
  assert.match(reply, /Workspace: C:\\Users\\testuser\\Desktop\\drone-company/);
  assert.match(reply, /Then review: review C:\\Users\\testuser\\Desktop\\drone-company\\index\.html\./);
  assert.match(reply, /After you review it: Tell me which section you want me to refine next\./);
});

test("renderConversationStatusOrRecall guides the user to the first review surface when asked where to start", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-5b",
      status: "waiting_for_user",
      goal: "Build the landing page and wait at the review checkpoint.",
      summary: "I finished the landing page draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want me to refine first.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-5b",
      updatedAt: "2026-03-12T00:00:09.500Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "What should I look at first?"
  );

  assert.match(reply, /Start here: open the preview at http:\/\/127\.0\.0\.1:4177\/index\.html\./);
  assert.match(reply, /After that: review C:\\Users\\testuser\\Desktop\\drone-company\\index\.html and C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css\./);
  assert.match(reply, /Review order:/);
  assert.match(reply, /1\. Preview the page at http:\/\/127\.0\.0\.1:4177\/index\.html\./);
  assert.match(reply, /2\. Check the primary artifact at C:\\Users\\testuser\\Desktop\\drone-company\\index\.html\./);
  assert.match(reply, /3\. Review the changed file at C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css\./);
  assert.match(reply, /After your review: Tell me what section you want me to refine first\./);
});

test("renderConversationStatusOrRecall can use semantic handoff hints for nuanced guided review wording", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-5d",
      status: "waiting_for_user",
      goal: "Build the landing page and wait at the review checkpoint.",
      summary: "I finished the landing page draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want me to refine first.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-5d",
      updatedAt: "2026-03-12T00:00:09.900Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "When I get back later, what should I inspect first from the draft you left me?",
    "guided_review"
  );

  assert.match(reply, /Start here: open the preview at http:\/\/127\.0\.0\.1:4177\/index\.html\./);
  assert.match(reply, /Review order:/);
  assert.match(reply, /After your review: Tell me what section you want me to refine first\./);
});

test("renderConversationStatusOrRecall can use semantic handoff hints for softer review-next wording", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-5f",
      status: "waiting_for_user",
      goal: "Build the landing page and pause at the review checkpoint.",
      summary: "I finished the landing page draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want me to refine first.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css",
        "C:\\Users\\testuser\\Desktop\\drone-company\\app.js"
      ],
      sourceJobId: "job-5f",
      updatedAt: "2026-03-12T00:00:10.000Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "What should I review next from that draft?",
    "next_review_step"
  );

  assert.match(reply, /Here is the next thing I would review from the saved work:/);
  assert.match(reply, /Next review step: Check the primary artifact at C:\\Users\\testuser\\Desktop\\drone-company\\index\.html\./);
  assert.match(reply, /After that: Review the changed file at C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css\. and Review the changed file at C:\\Users\\testuser\\Desktop\\drone-company\\app\.js\./);
  assert.match(reply, /Status: Paused here with a saved checkpoint ready for your review or next change request\./);
});

test("renderConversationStatusOrRecall can use semantic handoff hints for wrap-up summary wording", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-5g",
      status: "completed",
      goal: "Finish the landing page draft and save the review checkpoint.",
      summary: "I finished the landing page draft and saved the review checkpoint for you.",
      nextSuggestedStep: "Tell me which section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-5g",
      updatedAt: "2026-03-12T00:00:10.300Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "What did you wrap up for me on that draft?",
    "wrap_up_summary"
  );

  assert.match(reply, /Here is what I wrapped up for you: I finished the landing page draft and saved the review checkpoint for you\./);
  assert.match(reply, /What I wrapped up: C:\\Users\\testuser\\Desktop\\drone-company\\index\.html and C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css\./);
  assert.match(reply, /Status: Finished and ready for your review\./);
  assert.match(reply, /Next step: Tell me which section you want me to refine next\./);
});

test("renderConversationStatusOrRecall recognizes finished-while-gone handoff prompts", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-5c",
      status: "completed",
      goal: "Build the landing page while the user is away.",
      summary: "I finished the landing page draft and left the preview ready for review.",
      nextSuggestedStep: "Tell me what section you want me to change next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-5c",
      updatedAt: "2026-03-12T00:00:09.750Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "What did you finish while I was gone?"
  );

  assert.match(reply, /While you were away, I finished the landing page draft and left the preview ready for review\./);
  assert.match(reply, /Best first look: open the preview at http:\/\/127\.0\.0\.1:4177\/index\.html\./);
  assert.match(reply, /Preview: http:\/\/127\.0\.0\.1:4177\/index\.html/);
  assert.match(reply, /After you review it: Tell me what section you want me to change next\./);
});

test("renderConversationStatusOrRecall can use semantic handoff hints for nuanced explain-style return wording", () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-5e",
      status: "completed",
      goal: "Finish the landing page draft and save the review checkpoint.",
      summary: "I finished the landing page draft and saved the review checkpoint for you.",
      nextSuggestedStep: "Tell me which section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-5e",
      updatedAt: "2026-03-12T00:00:10.100Z"
    }
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "Explain what you actually changed in that saved draft.",
    "explain_handoff"
  );

  assert.match(reply, /Here is what I changed in the saved work: I finished the landing page draft and saved the review checkpoint for you\./);
  assert.match(reply, /Status: Finished and ready for your review\./);
  assert.match(reply, /What I changed: C:\\Users\\testuser\\Desktop\\drone-company\\index\.html and C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css\./);
  assert.match(reply, /Preview: http:\/\/127\.0\.0\.1:4177\/index\.html/);
  assert.match(reply, /Next step: Tell me which section you want me to refine next\./);
});

test("renderConversationStatusOrRecall falls back to the latest concrete location when no path destination is stored", () => {
  const session = buildSession({
    activeWorkspace: {
      id: "workspace:desktop-123",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\123",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
      previewUrl: "file:///C:/Users/testuser/Desktop/123/index.html",
      browserSessionId: "browser-session-1",
      browserSessionIds: ["browser-session-1"],
      browserSessionStatus: "open",
      browserProcessPid: 42001,
      previewProcessLeaseId: null,
      previewProcessLeaseIds: [],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\123",
      lastKnownPreviewProcessPid: null,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_only",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
      sourceJobId: "job-2",
      updatedAt: "2026-03-12T00:00:05.000Z"
    },
    recentActions: [
      {
        id: "folder-action",
        kind: "folder",
        label: "Desktop 123 folder",
        location: "C:\\Users\\testuser\\Desktop\\123",
        status: "created",
        sourceJobId: "job-2",
        at: "2026-03-12T00:00:05.000Z",
        summary: "Created the folder."
      }
    ]
  });

  const reply = renderConversationStatusOrRecall(
    session,
    "Where did you put that?"
  );

  assert.match(reply, /Current workspace:/);
  assert.match(reply, /C:\\Users\\testuser\\Desktop\\123/);
});

test("renderConversationStatusOrRecall describes orphaned workspaces as attributable instead of current", () => {
  const session = buildSession({
    activeWorkspace: {
      id: "workspace:desktop-drone-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
      browserSessionId: "browser-session-detached",
      browserSessionIds: ["browser-session-detached"],
      browserSessionStatus: "open",
      browserProcessPid: null,
      previewProcessLeaseId: null,
      previewProcessLeaseIds: [],
      previewProcessCwd: null,
      lastKnownPreviewProcessPid: null,
      stillControllable: false,
      ownershipState: "orphaned",
      previewStackState: "browser_only",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-2",
      updatedAt: "2026-03-12T00:00:05.000Z"
    }
  });

  const locationReply = renderConversationStatusOrRecall(
    session,
    "Where did you put that?"
  );
  const browserReply = renderConversationStatusOrRecall(
    session,
    "Is the browser still open?"
  );

  assert.match(locationReply, /Most recent attributable workspace:/);
  assert.match(locationReply, /Last attributable workspace: C:\\Users\\testuser\\Desktop\\drone-company/);
  assert.match(browserReply, /Last attributable workspace preview:/);
});

test("deriveConversationLedgersFromTaskRunResult links an open browser session back to the preview process lease", () => {
  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-open-browser",
      goal: "Leave the local app open in a browser window.",
      userInput: "Open the local app and leave it open for me.",
      createdAt: "2026-03-12T00:00:00.000Z"
    },
    plan: {
      taskId: "task-open-browser",
      plannerNotes: "Open the browser after local verification.",
      actions: [
        {
          id: "action_start_process",
          type: "start_process",
          description: "Start the local preview server.",
          params: {
            command: "python -m http.server 8125",
            cwd: "C:\\Users\\testuser\\Desktop\\123"
          },
          estimatedCostUsd: 0.08
        },
        {
          id: "action_open_browser",
          type: "open_browser",
          description: "Open the verified page in a visible browser window.",
          params: {
            url: "http://127.0.0.1:8125/"
          },
          estimatedCostUsd: 0.03
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_start_process",
          type: "start_process",
          description: "Start the local preview server.",
          params: {
            command: "python -m http.server 8125",
            cwd: "C:\\Users\\testuser\\Desktop\\123"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: true,
        output: "Process started: lease proc_preview_1.",
        executionStatus: "success",
        executionMetadata: {
          processLeaseId: "proc_preview_1",
          processLifecycleStatus: "PROCESS_STARTED",
          processCwd: "C:\\Users\\testuser\\Desktop\\123",
          processPid: 43125
        },
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_open_browser",
          type: "open_browser",
          description: "Open the verified page in a visible browser window.",
          params: {
            url: "http://127.0.0.1:8125/"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Opened http://127.0.0.1:8125/ in your visible browser and left it open.",
        executionStatus: "success",
        executionMetadata: {
          browserSession: true,
          browserSessionId: "browser_session:action_open_browser",
          browserSessionUrl: "http://127.0.0.1:8125/",
          browserSessionStatus: "open",
          browserSessionVisibility: "visible",
          browserSessionBrowserProcessPid: 42055
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Opened the local app in a visible browser window.",
    modelUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedSpendUsd: 0
    },
    startedAt: "2026-03-12T00:00:01.000Z",
    completedAt: "2026-03-12T00:00:02.000Z"
  };

  const ledgers = deriveConversationLedgersFromTaskRunResult(
    taskRunResult,
    "job-open-browser",
    "2026-03-12T00:00:02.000Z"
  );

  assert.equal(ledgers.browserSessions.length, 1);
  assert.equal(ledgers.browserSessions[0]?.status, "open");
  assert.equal(ledgers.browserSessions[0]?.url, "http://127.0.0.1:8125/");
  assert.equal(ledgers.browserSessions[0]?.linkedProcessLeaseId, "proc_preview_1");
  assert.equal(ledgers.browserSessions[0]?.linkedProcessCwd, "C:\\Users\\testuser\\Desktop\\123");
  assert.equal(ledgers.browserSessions[0]?.linkedProcessPid, 43125);
  assert.equal(ledgers.browserSessions[0]?.workspaceRootPath, "C:\\Users\\testuser\\Desktop\\123");
  assert.equal(ledgers.browserSessions[0]?.browserProcessPid, 42055);
  assert.equal(ledgers.recentActions.some((action) => action.kind === "browser_session"), true);
});

test("deriveConversationLedgersFromTaskRunResult prefers explicit browser ownership metadata when no start_process action is present", () => {
  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-open-browser-owned",
      goal: "Reopen the tracked landing page preview.",
      userInput: "Reopen the landing page preview for me.",
      createdAt: "2026-03-12T00:00:00.000Z"
    },
    plan: {
      taskId: "task-open-browser-owned",
      plannerNotes: "Reopen the tracked preview in a browser.",
      actions: [
        {
          id: "action_open_browser_owned",
          type: "open_browser",
          description: "Open the tracked page in a visible browser window.",
          params: {
            url: "http://127.0.0.1:8125/",
            rootPath: "C:\\Users\\testuser\\Desktop\\123",
            previewProcessLeaseId: "proc_preview_2"
          },
          estimatedCostUsd: 0.03
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_open_browser_owned",
          type: "open_browser",
          description: "Open the tracked page in a visible browser window.",
          params: {
            url: "http://127.0.0.1:8125/",
            rootPath: "C:\\Users\\testuser\\Desktop\\123",
            previewProcessLeaseId: "proc_preview_2"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Opened http://127.0.0.1:8125/ in your visible browser and left it open.",
        executionStatus: "success",
        executionMetadata: {
          browserSession: true,
          browserSessionId: "browser_session:action_open_browser_owned",
          browserSessionUrl: "http://127.0.0.1:8125/",
          browserSessionStatus: "open",
          browserSessionVisibility: "visible",
          browserSessionBrowserProcessPid: 42056,
          browserSessionWorkspaceRootPath: "C:\\Users\\testuser\\Desktop\\123",
          browserSessionLinkedProcessLeaseId: "proc_preview_2",
          browserSessionLinkedProcessCwd: "C:\\Users\\testuser\\Desktop\\123",
          browserSessionLinkedProcessPid: 43126
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Reopened the local app in a visible browser window.",
    modelUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedSpendUsd: 0
    },
    startedAt: "2026-03-12T00:00:01.000Z",
    completedAt: "2026-03-12T00:00:02.000Z"
  };

  const ledgers = deriveConversationLedgersFromTaskRunResult(
    taskRunResult,
    "job-open-browser-owned",
    "2026-03-12T00:00:02.000Z"
  );

  assert.equal(ledgers.browserSessions[0]?.workspaceRootPath, "C:\\Users\\testuser\\Desktop\\123");
  assert.equal(ledgers.browserSessions[0]?.linkedProcessLeaseId, "proc_preview_2");
  assert.equal(ledgers.browserSessions[0]?.linkedProcessCwd, "C:\\Users\\testuser\\Desktop\\123");
  assert.equal(ledgers.browserSessions[0]?.linkedProcessPid, 43126);
});

test("deriveConversationLedgersFromTaskRunResult links an open browser session to the latest prior matching preview lease when a task started multiple workspace processes", () => {
  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-open-browser-multi-process",
      goal: "Leave the repaired local app open in a browser window.",
      userInput: "Reuse the existing React app, start its preview, and leave it open for me.",
      createdAt: "2026-03-12T00:00:00.000Z"
    },
    plan: {
      taskId: "task-open-browser-multi-process",
      plannerNotes: "Repair the preview flow and leave the browser open.",
      actions: [
        {
          id: "action_start_process_old",
          type: "start_process",
          description: "Start the earlier preview attempt.",
          params: {
            command: "npm run preview -- --host 127.0.0.1 --port 4173",
            cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
          },
          estimatedCostUsd: 0.08
        },
        {
          id: "action_start_process_new",
          type: "start_process",
          description: "Restart the preview with the repaired workspace state.",
          params: {
            command: "npm run preview -- --host 127.0.0.1 --port 4173",
            cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
          },
          estimatedCostUsd: 0.08
        },
        {
          id: "action_open_browser_multi_process",
          type: "open_browser",
          description: "Open the repaired preview in a visible browser window.",
          params: {
            url: "http://127.0.0.1:4173/",
            rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City"
          },
          estimatedCostUsd: 0.03
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_start_process_old",
          type: "start_process",
          description: "Start the earlier preview attempt.",
          params: {
            command: "npm run preview -- --host 127.0.0.1 --port 4173",
            cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: true,
        output: "Process started: lease proc_preview_old.",
        executionStatus: "success",
        executionMetadata: {
          processLeaseId: "proc_preview_old",
          processLifecycleStatus: "PROCESS_STARTED",
          processCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
          processPid: 43125
        },
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_start_process_new",
          type: "start_process",
          description: "Restart the preview with the repaired workspace state.",
          params: {
            command: "npm run preview -- --host 127.0.0.1 --port 4173",
            cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: true,
        output: "Process started: lease proc_preview_new.",
        executionStatus: "success",
        executionMetadata: {
          processLeaseId: "proc_preview_new",
          processLifecycleStatus: "PROCESS_STARTED",
          processCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
          processPid: 43126
        },
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_open_browser_multi_process",
          type: "open_browser",
          description: "Open the repaired preview in a visible browser window.",
          params: {
            url: "http://127.0.0.1:4173/",
            rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "The existing browser window for http://127.0.0.1:4173/ is already open and was brought forward.",
        executionStatus: "success",
        executionMetadata: {
          browserSession: true,
          browserSessionId: "browser_session:action_open_browser_multi_process",
          browserSessionUrl: "http://127.0.0.1:4173/",
          browserSessionStatus: "open",
          browserSessionVisibility: "visible",
          browserSessionBrowserProcessPid: 42057
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Opened the repaired local app in a visible browser window.",
    modelUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedSpendUsd: 0
    },
    startedAt: "2026-03-12T00:00:01.000Z",
    completedAt: "2026-03-12T00:00:02.000Z"
  };

  const ledgers = deriveConversationLedgersFromTaskRunResult(
    taskRunResult,
    "job-open-browser-multi-process",
    "2026-03-12T00:00:02.000Z"
  );

  assert.equal(ledgers.browserSessions.length, 1);
  assert.equal(ledgers.browserSessions[0]?.linkedProcessLeaseId, "proc_preview_new");
  assert.equal(
    ledgers.browserSessions[0]?.linkedProcessCwd,
    "C:\\Users\\testuser\\Desktop\\AI Drone City"
  );
  assert.equal(ledgers.browserSessions[0]?.linkedProcessPid, 43126);
});

test("deriveConversationLedgersFromTaskRunResult marks a stopped managed preview process as closed", () => {
  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-close-preview",
      goal: "Close the tracked landing page preview stack.",
      userInput: "Close the landing page so we can work on something else.",
      createdAt: "2026-03-12T00:00:00.000Z"
    },
    plan: {
      taskId: "task-close-preview",
      plannerNotes: "Close the browser and stop the linked preview process.",
      actions: [
        {
          id: "action_close_browser",
          type: "close_browser",
          description: "Close the tracked landing page preview.",
          params: {
            sessionId: "browser_session:landing-page"
          },
          estimatedCostUsd: 0.03
        },
        {
          id: "action_stop_process",
          type: "stop_process",
          description: "Stop the linked local preview process.",
          params: {
            leaseId: "proc_preview_1"
          },
          estimatedCostUsd: 0.12
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_close_browser",
          type: "close_browser",
          description: "Close the tracked landing page preview.",
          params: {
            sessionId: "browser_session:landing-page"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Closed the browser window for http://127.0.0.1:8125/.",
        executionStatus: "success",
        executionMetadata: {
          browserSession: true,
          browserSessionId: "browser_session:landing-page",
          browserSessionUrl: "http://127.0.0.1:8125/",
          browserSessionStatus: "closed",
          browserSessionVisibility: "visible"
        },
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action_stop_process",
          type: "stop_process",
          description: "Stop the linked local preview process.",
          params: {
            leaseId: "proc_preview_1"
          },
          estimatedCostUsd: 0.12
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_1.",
        executionStatus: "success",
        executionMetadata: {
          processLeaseId: "proc_preview_1",
          processLifecycleStatus: "PROCESS_STOPPED",
          processCwd: "C:\\Users\\testuser\\Desktop\\drone-company"
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Closed the browser and stopped the preview server.",
    modelUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedSpendUsd: 0
    },
    startedAt: "2026-03-12T00:00:01.000Z",
    completedAt: "2026-03-12T00:00:02.000Z"
  };

  const ledgers = deriveConversationLedgersFromTaskRunResult(
    taskRunResult,
    "job-close-preview",
    "2026-03-12T00:00:02.000Z"
  );
  const closedProcess = ledgers.recentActions.find(
    (action) => action.kind === "process" && action.location === "C:\\Users\\testuser\\Desktop\\drone-company"
  );

  assert.ok(closedProcess);
  assert.equal(closedProcess.status, "closed");
});

test("deriveConversationLedgersFromTaskRunResult records linked browser cleanup emitted by stop_process", () => {
  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-stop-preview-cleanup",
      goal: "Stop the linked preview and close its browser window.",
      userInput: "Organize the drone folders and shut down the old preview holders first.",
      createdAt: "2026-03-14T00:00:00.000Z"
    },
    plan: {
      taskId: "task-stop-preview-cleanup",
      plannerNotes: "Stop the exact tracked preview holder before moving the folder.",
      actions: [
        {
          id: "action_stop_preview_cleanup",
          type: "stop_process",
          description: "Stop the linked preview process and clean up its browser window.",
          params: {
            leaseId: "proc_preview_3"
          },
          estimatedCostUsd: 0.08
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_stop_preview_cleanup",
          type: "stop_process",
          description: "Stop the linked preview process and clean up its browser window.",
          params: {
            leaseId: "proc_preview_3"
          },
          estimatedCostUsd: 0.08
        },
        mode: "escalation_path",
        approved: true,
        output:
          "Process stopped: lease proc_preview_3. Closed 1 linked browser window.",
        executionStatus: "success",
        executionMetadata: {
          processLeaseId: "proc_preview_3",
          processLifecycleStatus: "PROCESS_STOPPED",
          processCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
          processPid: 43127,
          linkedBrowserSessionCleanupCount: 1,
          linkedBrowserSessionCleanupRecordsJson: JSON.stringify([
            {
              sessionId: "browser_session:action_open_browser_preview",
              url: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
              status: "closed",
              visibility: "visible",
              controllerKind: "playwright_managed",
              controlAvailable: false,
              browserProcessPid: 42057,
              workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
              linkedProcessLeaseId: "proc_preview_3",
              linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
              linkedProcessPid: 43127
            }
          ])
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Stopped the preview holder and closed the linked browser window.",
    modelUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedSpendUsd: 0
    },
    startedAt: "2026-03-14T00:00:01.000Z",
    completedAt: "2026-03-14T00:00:02.000Z"
  };

  const ledgers = deriveConversationLedgersFromTaskRunResult(
    taskRunResult,
    "job-stop-preview-cleanup",
    "2026-03-14T00:00:02.000Z"
  );

  assert.equal(ledgers.browserSessions.length, 1);
  assert.equal(ledgers.browserSessions[0]?.id, "browser_session:action_open_browser_preview");
  assert.equal(ledgers.browserSessions[0]?.status, "closed");
  assert.equal(ledgers.browserSessions[0]?.controlAvailable, false);
  assert.equal(
    ledgers.browserSessions[0]?.workspaceRootPath,
    "C:\\Users\\testuser\\Desktop\\drone-company"
  );
  assert.equal(ledgers.browserSessions[0]?.linkedProcessLeaseId, "proc_preview_3");
  assert.equal(
    ledgers.recentActions.some(
      (action) =>
        action.kind === "browser_session" &&
        action.status === "closed" &&
        action.location === "file:///C:/Users/testuser/Desktop/drone-company/index.html"
    ),
    true
  );
});
