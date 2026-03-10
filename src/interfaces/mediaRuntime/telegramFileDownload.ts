/**
 * @fileoverview Canonical Telegram file-descriptor and bounded file-download helpers for media ingest.
 */

export interface TelegramFileDescriptor {
  fileId: string;
  filePath: string;
  downloadUrl: string;
  sizeBytes: number | null;
}

/**
 * Resolves a Telegram file descriptor via the Bot API `getFile` method.
 *
 * @param apiBaseUrl - Telegram Bot API base URL.
 * @param botToken - Telegram bot token.
 * @param fileId - Provider file identifier.
 * @returns Bounded Telegram file descriptor used for later downloads.
 */
export async function resolveTelegramFileDescriptor(
  apiBaseUrl: string,
  botToken: string,
  fileId: string
): Promise<TelegramFileDescriptor> {
  const url = new URL(`/bot${botToken}/getFile`, apiBaseUrl);
  url.searchParams.set("file_id", fileId);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`getFile failed with status ${response.status}.`);
  }

  const payload = await response.json() as {
    ok?: boolean;
    result?: { file_id?: string; file_path?: string; file_size?: number };
  };
  if (!payload.ok || !payload.result?.file_path || !payload.result.file_id) {
    throw new Error("getFile returned no file_path.");
  }

  return {
    fileId: payload.result.file_id,
    filePath: payload.result.file_path,
    downloadUrl: new URL(`/file/bot${botToken}/${payload.result.file_path}`, apiBaseUrl).toString(),
    sizeBytes: typeof payload.result.file_size === "number" ? payload.result.file_size : null
  };
}

/**
 * Downloads one Telegram file into memory with an optional size ceiling.
 *
 * @param descriptor - Resolved Telegram file descriptor.
 * @param maxBytes - Optional maximum allowed download size.
 * @returns Raw file bytes for downstream media interpretation.
 */
export async function downloadTelegramFileBuffer(
  descriptor: TelegramFileDescriptor,
  maxBytes?: number
): Promise<Buffer> {
  if (typeof maxBytes === "number" && maxBytes > 0 && typeof descriptor.sizeBytes === "number") {
    if (descriptor.sizeBytes > maxBytes) {
      throw new Error(`Telegram file exceeds the ${maxBytes} byte download limit.`);
    }
  }

  const response = await fetch(descriptor.downloadUrl);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with status ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (typeof maxBytes === "number" && maxBytes > 0 && bytes.length > maxBytes) {
    throw new Error(`Telegram file exceeds the ${maxBytes} byte download limit.`);
  }
  return bytes;
}
