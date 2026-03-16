/**
 * @fileoverview Canonical transport lifecycle helpers shared by Discord and Telegram gateways.
 */

import type { TransportFetch } from "./contracts";
export {
  abortAutonomousTransportTask,
  abortAutonomousTransportTaskIfRequested,
  isAutonomousStopIntent
} from "./autonomousAbortControl";

export interface DiscordSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  readyState: number;
}

export interface DiscordGatewayPayload {
  op?: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

export interface DiscordGatewayBotResponse {
  url?: string;
}

export interface WebSocketLikeConstructor {
  new(url: string): DiscordSocket;
}

export interface ResolveDiscordGatewaySocketUrlInput {
  gatewayUrl: string;
  botToken: string;
  fetchImpl?: TransportFetch;
}

export interface HandleDiscordGatewaySocketMessageInput {
  rawData: string;
  onSequence(sequence: number): void;
  onHello(data: { heartbeat_interval?: number } | undefined): Promise<void>;
  onDispatch(eventType: string, data: unknown): Promise<void>;
}

export interface RouteDiscordDispatchEventInput {
  eventType: string;
  data: unknown;
  onReady(data: { user?: { id?: string } }): Promise<void>;
  onMessageCreate(data: unknown): Promise<void>;
}

export interface HandleDiscordHelloLifecycleInput {
  data: { heartbeat_interval?: number } | undefined;
  existingHeartbeatTimer: NodeJS.Timeout | null;
  sequenceProvider(): number | null;
  socket: DiscordSocket | null;
  botToken: string;
  intents: number;
}

export interface AttachDiscordSocketLifecycleInput {
  socket: DiscordSocket;
  onOpen(): void;
  onMessage(rawData: string): Promise<void>;
  onMessageError(error: Error): void;
  onError(error: unknown): void;
  onClose(): void;
}

export interface ReconnectWithBackoffInput {
  delayMs: number;
  isRunning(): boolean;
  reconnect(): Promise<void>;
  onReconnectError(error: Error): void;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface PollTelegramUpdatesOnceInput<TUpdate> {
  apiBaseUrl: string;
  botToken: string;
  pollTimeoutSeconds: number;
  nextOffset: number;
  fetchImpl?: TransportFetch;
  processUpdate(update: TUpdate): Promise<void>;
}

export interface RunTelegramPollingLoopInput {
  isRunning(): boolean;
  pollOnce(): Promise<void>;
  pollIntervalMs: number;
  onPollError(error: Error): void;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface TelegramGetUpdatesEnvelope<TUpdate> {
  ok?: boolean;
  result?: TUpdate[];
}

interface TelegramUpdateIdCarrier {
  update_id?: number;
}

/**
 * Pauses execution for a bounded interval used by polling and reconnect backoff flows.
 *
 * @param ms - Duration value in milliseconds.
 * @returns Promise resolving after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves the WebSocket constructor used by the Discord gateway runtime.
 *
 * @returns Available WebSocket constructor from the runtime environment.
 */
export function resolveWebSocketConstructor(): WebSocketLikeConstructor {
  const maybeGlobal = (globalThis as unknown as { WebSocket?: WebSocketLikeConstructor }).WebSocket;
  if (maybeGlobal) {
    return maybeGlobal;
  }

  const wsModule = require("ws") as { WebSocket?: WebSocketLikeConstructor; default?: WebSocketLikeConstructor };
  const maybeModuleCtor = wsModule.WebSocket ?? wsModule.default;
  if (!maybeModuleCtor) {
    throw new Error("No WebSocket implementation found. Install dependency `ws`.");
  }
  return maybeModuleCtor;
}

/**
 * Resolves the authenticated Discord gateway socket URL for the current bot token.
 *
 * @param input - Discord gateway discovery context.
 * @returns Gateway WebSocket URL including version and encoding parameters.
 */
export async function resolveDiscordGatewaySocketUrl(
  input: ResolveDiscordGatewaySocketUrlInput
): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.gatewayUrl, {
    method: "GET",
    headers: {
      Authorization: `Bot ${input.botToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Discord gateway discovery failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as DiscordGatewayBotResponse;
  const baseUrl = payload.url ?? "wss://gateway.discord.gg";
  const url = new URL(baseUrl);
  url.searchParams.set("v", "10");
  url.searchParams.set("encoding", "json");
  return url.toString();
}

/**
 * Parses one Discord gateway socket payload and routes it to hello/dispatch handlers.
 *
 * @param input - Raw payload plus handler callbacks for sequence, hello, and dispatch events.
 * @returns Promise resolving after any routed handler completes.
 */
export async function handleDiscordGatewaySocketMessage(
  input: HandleDiscordGatewaySocketMessageInput
): Promise<void> {
  let payload: DiscordGatewayPayload;
  try {
    payload = JSON.parse(input.rawData) as DiscordGatewayPayload;
  } catch {
    return;
  }

  if (typeof payload.s === "number") {
    input.onSequence(payload.s);
  }

  if (payload.op === 10) {
    await input.onHello(payload.d as { heartbeat_interval?: number } | undefined);
    return;
  }

  if (payload.op === 0 && typeof payload.t === "string") {
    await input.onDispatch(payload.t, payload.d);
  }
}

/**
 * Starts the Discord heartbeat timer and immediately emits the first heartbeat payload.
 *
 * @param heartbeatIntervalMs - Server-provided heartbeat interval.
 * @param sequenceProvider - Callback returning the latest gateway sequence.
 * @param sendPayload - Outbound gateway payload sender.
 * @returns Active heartbeat timer handle.
 */
export function startDiscordHeartbeat(
  heartbeatIntervalMs: number,
  sequenceProvider: () => number | null,
  sendPayload: (payload: Record<string, unknown>) => void
): NodeJS.Timeout {
  const sendHeartbeat = (): void => {
    sendPayload({
      op: 1,
      d: sequenceProvider()
    });
  };

  sendHeartbeat();
  return setInterval(sendHeartbeat, heartbeatIntervalMs);
}

/**
 * Builds the Discord identify payload used immediately after the hello event arrives.
 *
 * @param botToken - Discord bot token used for identify authentication.
 * @param intents - Discord gateway intent bitmask configured for the runtime.
 * @returns Canonical identify payload ready for socket send.
 */
export function buildDiscordIdentifyPayload(
  botToken: string,
  intents: number
): Record<string, unknown> {
  return {
    op: 2,
    d: {
      token: botToken,
      intents,
      properties: {
        $os: "windows",
        $browser: "agentbigbrain",
        $device: "agentbigbrain"
      }
    }
  };
}

/**
 * Sends a JSON payload through an open Discord gateway socket.
 *
 * @param socket - Active Discord gateway socket or `null` when disconnected.
 * @param payload - Structured gateway payload to serialize and send.
 */
export function sendDiscordGatewayPayload(
  socket: DiscordSocket | null,
  payload: Record<string, unknown>
): void {
  if (!socket || socket.readyState !== 1) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

/**
 * Attaches the canonical Discord socket lifecycle handlers used by the stable gateway entrypoint.
 *
 * @param input - Socket plus stable gateway callbacks for open, message, error, and close events.
 */
export function attachDiscordSocketLifecycle(input: AttachDiscordSocketLifecycleInput): void {
  input.socket.onopen = () => {
    input.onOpen();
  };
  input.socket.onmessage = (event) => {
    void input.onMessage(event.data).catch((error) => {
      input.onMessageError(error instanceof Error ? error : new Error(String(error)));
    });
  };
  input.socket.onerror = (error) => {
    input.onError(error);
  };
  input.socket.onclose = () => {
    input.onClose();
  };
}

/**
 * Applies Discord hello-event lifecycle behavior: reset heartbeat and send identify payload.
 *
 * @param input - Hello payload plus socket/timer/authentication context.
 * @returns Active heartbeat timer for the current socket session.
 */
export function handleDiscordHelloLifecycle(
  input: HandleDiscordHelloLifecycleInput
): NodeJS.Timeout {
  const heartbeatInterval = input.data?.heartbeat_interval ?? 41_250;
  if (input.existingHeartbeatTimer) {
    clearInterval(input.existingHeartbeatTimer);
  }

  const timer = startDiscordHeartbeat(
    heartbeatInterval,
    input.sequenceProvider,
    (payload) => sendDiscordGatewayPayload(input.socket, payload)
  );
  sendDiscordGatewayPayload(
    input.socket,
    buildDiscordIdentifyPayload(input.botToken, input.intents)
  );
  return timer;
}

/**
 * Routes one Discord dispatch event to the stable gateway callbacks.
 *
 * @param input - Event metadata and stable gateway callbacks.
 * @returns Promise resolving after the routed callback completes.
 */
export async function routeDiscordDispatchEvent(
  input: RouteDiscordDispatchEventInput
): Promise<void> {
  if (input.eventType === "READY") {
    await input.onReady(input.data as { user?: { id?: string } });
    return;
  }

  if (input.eventType === "MESSAGE_CREATE") {
    await input.onMessageCreate(input.data);
  }
}

/**
 * Repeats reconnect attempts behind a bounded backoff gate while the owning gateway is still
 * running.
 *
 * @param input - Reconnect callbacks plus running-state and delay dependencies.
 */
export async function reconnectWithBackoffLoop(
  input: ReconnectWithBackoffInput
): Promise<void> {
  const sleepImpl = input.sleepImpl ?? sleep;
  await sleepImpl(input.delayMs);
  if (!input.isRunning()) {
    return;
  }

  try {
    await input.reconnect();
  } catch (error) {
    input.onReconnectError(error instanceof Error ? error : new Error(String(error)));
    await reconnectWithBackoffLoop(input);
  }
}

/**
 * Executes one Telegram `getUpdates` poll and returns the next offset to persist.
 *
 * @param input - Telegram polling context and update processor.
 * @returns Next update offset after processing the current batch.
 */
export async function pollTelegramUpdatesOnce<TUpdate extends TelegramUpdateIdCarrier>(
  input: PollTelegramUpdatesOnceInput<TUpdate>
): Promise<number> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(`/bot${input.botToken}/getUpdates`, input.apiBaseUrl);
  url.searchParams.set("timeout", String(input.pollTimeoutSeconds));
  if (input.nextOffset > 0) {
    url.searchParams.set("offset", String(input.nextOffset));
  }

  const response = await fetchImpl(url.toString(), { method: "GET" });
  if (!response.ok) {
    throw new Error(`getUpdates failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as TelegramGetUpdatesEnvelope<TUpdate>;
  if (!payload.ok || !Array.isArray(payload.result)) {
    return input.nextOffset;
  }

  let nextOffset = input.nextOffset;
  for (const update of payload.result) {
    if (typeof update.update_id === "number") {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
    }
    await input.processUpdate(update);
  }
  return nextOffset;
}

/**
 * Runs the canonical Telegram long-poll loop while the owning gateway remains active.
 *
 * @param input - Poll callback, error handler, and loop timing dependencies.
 */
export async function runTelegramPollingLoop(
  input: RunTelegramPollingLoopInput
): Promise<void> {
  const sleepImpl = input.sleepImpl ?? sleep;
  while (input.isRunning()) {
    try {
      await input.pollOnce();
    } catch (error) {
      input.onPollError(error instanceof Error ? error : new Error(String(error)));
    }

    if (input.isRunning()) {
      await sleepImpl(input.pollIntervalMs);
    }
  }
}
