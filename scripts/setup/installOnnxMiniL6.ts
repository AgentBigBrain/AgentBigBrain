/**
 * @fileoverview Downloads the local ONNX embedding artifacts used by semantic memory.
 *
 * Installs `model.onnx` and `tokenizer.json` for `sentence-transformers/all-MiniLM-L6-v2`
 * into a local directory (default: `models/all-MiniLM-L6-v2`).
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  buildAppleSiliconNodeMismatchMessage,
  detectCurrentAppleSiliconNodeMismatch
} from "../../src/core/appleSiliconRuntime";

interface CliOptions {
  targetDir: string;
  force: boolean;
}

interface ArtifactSpec {
  fileName: string;
  url: string;
  minBytes: number;
}

const DEFAULT_TARGET_DIR = path.join("models", "all-MiniLM-L6-v2");
const ARTIFACTS: readonly ArtifactSpec[] = [
  {
    fileName: "model.onnx",
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx?download=true",
    minBytes: 1_000_000
  },
  {
    fileName: "tokenizer.json",
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json?download=true",
    minBytes: 1_000
  }
];

/**
 * Prints usage text and exits for this process.
 *
 * @param code - Process exit code.
 */
function printUsageAndExit(code: number): never {
  console.log("Usage: npm run setup:embeddings -- [--dir <path>] [--force]");
  console.log("");
  console.log("Options:");
  console.log(`  --dir <path>   Target model directory (default: ${DEFAULT_TARGET_DIR})`);
  console.log("  --force        Re-download files even if they already exist.");
  console.log("  --help         Show this help.");
  process.exit(code);
}

/**
 * Parses CLI arguments into deterministic options.
 *
 * @param argv - CLI arguments after node/script path.
 * @returns Parsed install options.
 */
function parseCliOptions(argv: readonly string[]): CliOptions {
  let targetDir = DEFAULT_TARGET_DIR;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--dir requires a value.");
      }
      targetDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      const value = arg.slice("--dir=".length).trim();
      if (!value) {
        throw new Error("--dir requires a non-empty value.");
      }
      targetDir = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { targetDir, force };
}

/**
 * Returns whether a file already exists and satisfies a minimum-size threshold.
 *
 * @param filePath - Candidate file path to check.
 * @param minBytes - Minimum expected size.
 * @returns `true` when the file exists and appears valid.
 */
async function hasValidExistingFile(filePath: string, minBytes: number): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size >= minBytes;
  } catch {
    return false;
  }
}

/**
 * Downloads a file to a temporary path and atomically moves it into place.
 *
 * @param url - Source URL for download.
 * @param destinationPath - Final output path.
 * @param minBytes - Minimum expected file size.
 * @returns Final file size in bytes.
 */
async function downloadToFile(url: string, destinationPath: string, minBytes: number): Promise<number> {
  const temporaryPath = `${destinationPath}.download`;
  await rm(temporaryPath, { force: true });

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }
  if (!response.body) {
    throw new Error(`Download returned an empty body for ${url}`);
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  const webStream = response.body as import("stream/web").ReadableStream<Uint8Array>;
  await pipeline(Readable.fromWeb(webStream), createWriteStream(temporaryPath));

  const downloaded = await stat(temporaryPath);
  if (downloaded.size < minBytes) {
    await rm(temporaryPath, { force: true });
    throw new Error(
      `Downloaded file is too small (${downloaded.size} bytes < ${minBytes}) for ${destinationPath}`
    );
  }

  await rm(destinationPath, { force: true });
  await rename(temporaryPath, destinationPath);
  return downloaded.size;
}

/**
 * Converts bytes to a compact human-readable string.
 *
 * @param bytes - Byte size value.
 * @returns Human-readable size string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  const mib = kib / 1024;
  if (mib < 1024) {
    return `${mib.toFixed(1)} MiB`;
  }
  return `${(mib / 1024).toFixed(2)} GiB`;
}

/**
 * Installs required ONNX embedding artifacts into a local directory.
 *
 * @param options - CLI install options.
 */
async function installArtifacts(options: CliOptions): Promise<void> {
  const resolvedDir = path.resolve(options.targetDir);
  console.log(`[Embeddings] Target directory: ${resolvedDir}`);

  for (const artifact of ARTIFACTS) {
    const destinationPath = path.join(resolvedDir, artifact.fileName);
    const exists = !options.force && (await hasValidExistingFile(destinationPath, artifact.minBytes));
    if (exists) {
      const existingInfo = await stat(destinationPath);
      console.log(
        `[Embeddings] Skipping ${artifact.fileName} (already present: ${formatBytes(existingInfo.size)}).`
      );
      continue;
    }

    console.log(`[Embeddings] Downloading ${artifact.fileName}...`);
    const finalBytes = await downloadToFile(artifact.url, destinationPath, artifact.minBytes);
    console.log(
      `[Embeddings] Installed ${artifact.fileName} (${formatBytes(finalBytes)}) at ${destinationPath}.`
    );
  }

  console.log("[Embeddings] Installation complete.");
}

/**
 * Prints a deterministic setup warning when Apple Silicon is using x64 Node.
 *
 * @param options - CLI install options.
 */
function warnOnAppleSiliconNodeMismatch(options: CliOptions): void {
  const mismatch = detectCurrentAppleSiliconNodeMismatch();
  if (!mismatch) {
    return;
  }

  const resolvedDir = path.resolve(options.targetDir);
  console.warn(
    `[Embeddings] Warning: ${buildAppleSiliconNodeMismatchMessage("onnxruntime-node")} ` +
    `This setup command only downloads model assets into "${resolvedDir}"; it does not repair a mismatched native Node runtime.`
  );
}

/**
 * Main CLI entrypoint.
 */
async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  warnOnAppleSiliconNodeMismatch(options);
  await installArtifacts(options);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Embeddings] Installation failed: ${message}`);
  process.exitCode = 1;
});
