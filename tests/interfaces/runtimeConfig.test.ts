/**
 * @fileoverview Tests provider selection and username-scoped ingress configuration parsing for interface runtime.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createInterfaceRuntimeConfigFromEnv } from "../../src/interfaces/runtimeConfig";

test("runtime config selects telegram provider when configured", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(config.security.allowedUsernames[0], "agentowner");
  assert.equal(config.security.agentPulseTickIntervalMs, 120000);
  assert.equal(config.security.ackDelayMs, 1200);
  assert.equal(config.security.showTechnicalSummary, false);
  assert.equal(config.security.showSafetyCodes, false);
  assert.equal(config.security.showCompletionPrefix, false);
  assert.equal(config.security.followUpOverridePath, null);
  assert.equal(config.security.pulseLexicalOverridePath, null);
  assert.equal(config.security.invocation.requireNameCall, false);
  assert.equal(config.security.invocation.aliases[0], "BigBrain");
  assert.equal(config.streamingTransportMode, "edit");
  assert.equal(config.nativeDraftStreaming, false);
});

test("runtime config selects discord provider when configured", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "discord",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    DISCORD_BOT_TOKEN: "discord-token"
  });

  assert.equal(config.provider, "discord");
  assert.equal(config.security.allowedUsernames[0], "agentowner");
});

test("runtime config supports agent pulse scheduler interval override", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    BRAIN_AGENT_PULSE_TICK_INTERVAL_MS: "45000"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(config.security.agentPulseTickIntervalMs, 45000);
});

test("runtime config supports bounded ack delay override", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    BRAIN_INTERFACE_ACK_DELAY_MS: "900"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(config.security.ackDelayMs, 900);
});

test("runtime config supports Telegram native draft streaming toggle", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_NATIVE_DRAFT_STREAMING: "true"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(config.streamingTransportMode, "native_draft");
  assert.equal(config.nativeDraftStreaming, true);
});

test("runtime config supports explicit Telegram streaming transport mode override", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_STREAMING_TRANSPORT_MODE: "native_draft",
    TELEGRAM_NATIVE_DRAFT_STREAMING: "false"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(config.streamingTransportMode, "native_draft");
  assert.equal(config.nativeDraftStreaming, true);
});

test("runtime config supports disabling technical summary output", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY: "false"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(config.security.showTechnicalSummary, false);
  assert.equal(config.security.showSafetyCodes, false);
});

test("runtime config supports explicit safety-code and completion-prefix toggles", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY: "true",
    BRAIN_INTERFACE_SHOW_SAFETY_CODES: "false",
    BRAIN_INTERFACE_SHOW_COMPLETION_PREFIX: "true"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(config.security.showTechnicalSummary, true);
  assert.equal(config.security.showSafetyCodes, false);
  assert.equal(config.security.showCompletionPrefix, true);
});

test("runtime config supports follow-up override path for deterministic classifier aliases", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    BRAIN_INTERFACE_FOLLOW_UP_OVERRIDE_PATH: "runtime/policy/followup_override.json"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(
    config.security.followUpOverridePath,
    "runtime/policy/followup_override.json"
  );
});

test("runtime config supports pulse lexical override path for deterministic classifier tightening", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    BRAIN_INTERFACE_PULSE_LEXICAL_OVERRIDE_PATH: "runtime/policy/pulse_lexical_override.json"
  });

  assert.equal(config.provider, "telegram");
  assert.equal(
    config.security.pulseLexicalOverridePath,
    "runtime/policy/pulse_lexical_override.json"
  );
});

test("runtime config enables invocation name-call policy when configured", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "discord",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    DISCORD_BOT_TOKEN: "discord-token",
    BRAIN_INTERFACE_REQUIRE_NAME_CALL: "true",
    BRAIN_INTERFACE_NAME_ALIASES: "BigBrain,Brain"
  });

  assert.equal(config.provider, "discord");
  assert.equal(config.security.invocation.requireNameCall, true);
  assert.deepEqual(config.security.invocation.aliases, ["BigBrain", "Brain"]);
});

test("runtime config selects both providers when explicitly configured", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "both",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    DISCORD_BOT_TOKEN: "discord-token"
  });

  assert.equal(config.provider, "both");
  if (config.provider !== "both") {
    assert.fail("Expected multi-provider interface config.");
  }
  assert.equal(config.telegram.provider, "telegram");
  assert.equal(config.discord.provider, "discord");
  assert.equal(config.security.allowedUsernames[0], "agentowner");
});

test("runtime config supports comma-list provider selection for dual runtime", () => {
  const config = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram,discord",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    DISCORD_BOT_TOKEN: "discord-token"
  });

  assert.equal(config.provider, "both");
  if (config.provider !== "both") {
    assert.fail("Expected multi-provider interface config.");
  }
});

test("runtime config requires at least one allowlisted username", () => {
  assert.throws(
    () =>
      createInterfaceRuntimeConfigFromEnv({
        BRAIN_INTERFACE_PROVIDER: "telegram",
        BRAIN_INTERFACE_SHARED_SECRET: "secret",
        TELEGRAM_BOT_TOKEN: "telegram-token",
        BRAIN_INTERFACE_ALLOWED_USERNAMES: ""
      }),
    /BRAIN_INTERFACE_ALLOWED_USERNAMES/
  );
});

test("runtime config requires both provider tokens when dual runtime is enabled", () => {
  assert.throws(
    () =>
      createInterfaceRuntimeConfigFromEnv({
        BRAIN_INTERFACE_PROVIDER: "both",
        BRAIN_INTERFACE_SHARED_SECRET: "secret",
        BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
        TELEGRAM_BOT_TOKEN: "telegram-token"
      }),
    /DISCORD_BOT_TOKEN/
  );
});

test("runtime config rejects invalid provider choice", () => {
  assert.throws(
    () =>
      createInterfaceRuntimeConfigFromEnv({
        BRAIN_INTERFACE_PROVIDER: "unknown",
        BRAIN_INTERFACE_SHARED_SECRET: "secret",
        BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner"
      }),
    /BRAIN_INTERFACE_PROVIDER/
  );
});

test("runtime config fails closed when ack delay is out of range", () => {
  assert.throws(
    () =>
      createInterfaceRuntimeConfigFromEnv({
        BRAIN_INTERFACE_PROVIDER: "telegram",
        BRAIN_INTERFACE_SHARED_SECRET: "secret",
        BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
        TELEGRAM_BOT_TOKEN: "telegram-token",
        BRAIN_INTERFACE_ACK_DELAY_MS: "100"
      }),
    /BRAIN_INTERFACE_ACK_DELAY_MS/
  );
});

test("runtime config fails closed when ack delay is not an integer", () => {
  assert.throws(
    () =>
      createInterfaceRuntimeConfigFromEnv({
        BRAIN_INTERFACE_PROVIDER: "telegram",
        BRAIN_INTERFACE_SHARED_SECRET: "secret",
        BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
        TELEGRAM_BOT_TOKEN: "telegram-token",
        BRAIN_INTERFACE_ACK_DELAY_MS: "hello"
      }),
    /BRAIN_INTERFACE_ACK_DELAY_MS/
  );
});

test("runtime config fails closed when Telegram streaming transport mode is invalid", () => {
  assert.throws(
    () =>
      createInterfaceRuntimeConfigFromEnv({
        BRAIN_INTERFACE_PROVIDER: "telegram",
        BRAIN_INTERFACE_SHARED_SECRET: "secret",
        BRAIN_INTERFACE_ALLOWED_USERNAMES: "agentowner",
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_STREAMING_TRANSPORT_MODE: "invalid"
      }),
    /TELEGRAM_STREAMING_TRANSPORT_MODE/
  );
});
