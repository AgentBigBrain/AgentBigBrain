import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { collectRelationshipContinuityEntityHints } from "../../src/interfaces/conversationRuntime/relationshipContinuityContext";

test("collectRelationshipContinuityEntityHints keeps earlier memory subjects alive across later workflow turns for mixed recap prompts", () => {
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "avery_brooks",
    conversationVisibility: "private",
    receivedAt: "2026-04-13T13:12:59.000Z"
  });
  session.conversationTurns = [
    {
      id: "turn-user-memory-intake",
      role: "user",
      text:
        "Billy used to work at Sample Web Studio, Garrett still owns Harbor Signal Studio, and Sam was supposed to bring the revised copy deck on March 12.",
      at: "2026-04-13T13:12:59.000Z"
    },
    {
      id: "turn-assistant-memory-intake",
      role: "assistant",
      text: "I’m keeping that context straight.",
      at: "2026-04-13T13:13:00.000Z"
    },
    {
      id: "turn-user-memory-corrections",
      role: "user",
      text:
        "Billy is no longer at Sample Web Studio. Crimson Analytics hired him on March 15, Sam took over the billing cleanup on March 21, and the March 27 review is now the pending milestone.",
      at: "2026-04-13T13:13:07.000Z"
    },
    {
      id: "turn-assistant-memory-corrections",
      role: "assistant",
      text: "Current and historical details noted.",
      at: "2026-04-13T13:13:08.000Z"
    },
    {
      id: "turn-user-build-one",
      role: "user",
      text: "Create a lightweight HTML landing page in the Foundry Echo folder.",
      at: "2026-04-13T13:15:11.000Z"
    },
    {
      id: "turn-assistant-build-one",
      role: "assistant",
      text: "I opened the Foundry Echo page.",
      at: "2026-04-13T13:16:58.000Z"
    },
    {
      id: "turn-user-build-two",
      role: "user",
      text: "Create another lightweight HTML landing page in the River Glass folder.",
      at: "2026-04-13T13:17:30.000Z"
    },
    {
      id: "turn-assistant-build-two",
      role: "assistant",
      text: "I opened the River Glass page.",
      at: "2026-04-13T13:18:54.000Z"
    },
    {
      id: "turn-user-build-three",
      role: "user",
      text: "Create a third lightweight HTML landing page in the Marquee Thread folder.",
      at: "2026-04-13T13:19:30.000Z"
    },
    {
      id: "turn-assistant-build-three",
      role: "assistant",
      text: "I opened the Marquee Thread page.",
      at: "2026-04-13T13:21:25.000Z"
    }
  ];

  const hints = collectRelationshipContinuityEntityHints(
    session,
    "Switch gears back to memory and status tracking. Tell me which employment facts are current versus historical, which date is the active pending review date, who currently handles the billing cleanup, and whether the Foundry Echo, River Glass, and Marquee Thread browser pages are still open or fully closed."
  );

  assert.ok(hints.includes("billy"));
  assert.ok(hints.includes("sample"));
  assert.ok(hints.includes("crimson"));
  assert.ok(hints.includes("sam"));
  assert.ok(hints.includes("march"));
  assert.ok(!hints.includes("switch"));
});
