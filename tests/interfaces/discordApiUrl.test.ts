/**
 * @fileoverview Tests Discord REST URL construction to preserve API version prefixes for outbound gateway calls.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDiscordApiUrl } from "../../src/interfaces/discordApiUrl";

test("buildDiscordApiUrl preserves api version path when endpoint starts with slash", () => {
  const url = buildDiscordApiUrl(
    "https://discord.com/api/v10",
    "/channels/803848302859649046/messages"
  );

  assert.equal(
    url.toString(),
    "https://discord.com/api/v10/channels/803848302859649046/messages"
  );
});

test("buildDiscordApiUrl preserves api version path when base has trailing slash", () => {
  const url = buildDiscordApiUrl(
    "https://discord.com/api/v10/",
    "channels/803848302859649046/messages"
  );

  assert.equal(
    url.toString(),
    "https://discord.com/api/v10/channels/803848302859649046/messages"
  );
});

