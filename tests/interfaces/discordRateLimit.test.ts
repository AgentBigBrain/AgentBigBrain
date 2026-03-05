/**
 * @fileoverview Tests Discord retry-after parsing defaults used by outbound send retry handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDiscordRetryAfterMs } from "../../src/interfaces/discordRateLimit";

test("discord retry parser returns default for invalid payload", () => {
  assert.equal(parseDiscordRetryAfterMs(null), 1_000);
  assert.equal(parseDiscordRetryAfterMs({}), 1_000);
  assert.equal(parseDiscordRetryAfterMs({ retry_after: -1 }), 1_000);
});

test("discord retry parser converts seconds to milliseconds", () => {
  assert.equal(parseDiscordRetryAfterMs({ retry_after: 0.75 }), 750);
  assert.equal(parseDiscordRetryAfterMs({ retry_after: 0.01 }), 250);
});
