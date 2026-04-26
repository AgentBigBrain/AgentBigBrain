/**
 * @fileoverview Canonical neutral path and identity fixtures for tests/evidence.
 */

const TEST_USER = "testuser";
const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

export const TEST_REVIEWER_HANDLE = TEST_USER;
export const TEST_OPERATOR_ID = `operator_${TEST_USER}`;

export const HOST_TEST_HOME_DIR = IS_WINDOWS
  ? `C:\\Users\\${TEST_USER}`
  : IS_MAC
    ? `/Users/${TEST_USER}`
    : `/home/${TEST_USER}`;
export const HOST_TEST_DESKTOP_DIR = IS_WINDOWS
  ? `${HOST_TEST_HOME_DIR}\\Desktop`
  : `${HOST_TEST_HOME_DIR}/Desktop`;
export const HOST_TEST_DESKTOP_DIR_FORWARD = HOST_TEST_DESKTOP_DIR.replace(/\\/g, "/");
export const HOST_TEST_SAMPLE_SITE_DIR = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR}\\sample-site`
  : `${HOST_TEST_DESKTOP_DIR}/sample-site`;
export const HOST_TEST_PORTFOLIO_DEMO_DIR = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR}\\portfolio-demo`
  : `${HOST_TEST_DESKTOP_DIR}/portfolio-demo`;
export const HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR}\\playwright-proof-smoke`
  : `${HOST_TEST_DESKTOP_DIR}/playwright-proof-smoke`;
export const HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_TEST_DIR = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR}\\playwright-proof-smoke-test`
  : `${HOST_TEST_DESKTOP_DIR}/playwright-proof-smoke-test`;
export const HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_AUTO_8124_DIR = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR}\\playwright-proof-smoke-codex-auto-8124`
  : `${HOST_TEST_DESKTOP_DIR}/playwright-proof-smoke-codex-auto-8124`;
export const HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_2_DIR = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR}\\playwright-proof-smoke-test-2`
  : `${HOST_TEST_DESKTOP_DIR}/playwright-proof-smoke-test-2`;
export const HOST_TEST_TOP_SECRET_FILE_PATH = IS_WINDOWS
  ? `${HOST_TEST_HOME_DIR.replace(/\\/g, "/")}/top_secret.txt`
  : `${HOST_TEST_HOME_DIR}/top_secret.txt`;
export const HOST_TEST_IMPORTANT_FILE_PATH = IS_WINDOWS
  ? `${HOST_TEST_HOME_DIR.replace(/\\/g, "/")}/important.txt`
  : `${HOST_TEST_HOME_DIR}/important.txt`;
export const HOST_TEST_PRIVATE_DIR = IS_WINDOWS
  ? `${HOST_TEST_HOME_DIR}\\Private`
  : `${HOST_TEST_HOME_DIR}/Private`;
export const HOST_TEST_UNSAFE_FILE_PATH = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR_FORWARD}/unsafe.txt`
  : `${HOST_TEST_DESKTOP_DIR}/unsafe.txt`;
export const HOST_TEST_SOMETHING_FILE_PATH = IS_WINDOWS
  ? `${HOST_TEST_DESKTOP_DIR_FORWARD}/something.txt`
  : `${HOST_TEST_DESKTOP_DIR}/something.txt`;
export const HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_INDEX_HTML = IS_WINDOWS
  ? `${HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR}\\index.html`
  : `${HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR}/index.html`;
export const HOST_TEST_SYSTEM_FILE_PATH = IS_WINDOWS
  ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
  : "/etc/hosts";
export const HOST_TEST_SHELL_NAME = IS_WINDOWS ? "PowerShell" : IS_MAC ? "zsh" : "bash";

const WINDOWS_TEST_USER = "testuser";

export const WINDOWS_TEST_HOME_DIR = `C:\\Users\\${WINDOWS_TEST_USER}`;
export const WINDOWS_TEST_DESKTOP_DIR = `${WINDOWS_TEST_HOME_DIR}\\Desktop`;
export const WINDOWS_TEST_DESKTOP_DIR_FORWARD = WINDOWS_TEST_DESKTOP_DIR.replace(/\\/g, "/");

export const WINDOWS_TEST_DEMO_APP_DIR = `${WINDOWS_TEST_DESKTOP_DIR}\\demo-app`;
export const WINDOWS_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR =
  `${WINDOWS_TEST_DESKTOP_DIR}\\playwright-proof-smoke`;
export const WINDOWS_TEST_PLAYWRIGHT_PROOF_SMOKE_AUTO_8124_DIR =
  `${WINDOWS_TEST_DESKTOP_DIR}\\playwright-proof-smoke-codex-auto-8124`;
export const WINDOWS_TEST_PLAYWRIGHT_PROOF_SMOKE_2_DIR =
  `${WINDOWS_TEST_DESKTOP_DIR}\\playwright-proof-smoke-test-2`;
export const WINDOWS_TEST_PLAYWRIGHT_PROOF_SMOKE_TEST_DIR =
  `${WINDOWS_TEST_DESKTOP_DIR}\\playwright-proof-smoke-test`;
export const WINDOWS_TEST_PORTFOLIO_DEMO_DIR = `${WINDOWS_TEST_DESKTOP_DIR}\\portfolio-demo`;
export const WINDOWS_TEST_WRONG_APP_DIR = `${WINDOWS_TEST_DESKTOP_DIR}\\wrong-app`;

export const WINDOWS_TEST_PLAYWRIGHT_PROOF_SMOKE_INDEX_HTML =
  `${WINDOWS_TEST_PLAYWRIGHT_PROOF_SMOKE_DIR}\\index.html`;
export const WINDOWS_TEST_IMPORTANT_FILE_PATH =
  `${WINDOWS_TEST_HOME_DIR.replace(/\\/g, "/")}/important.txt`;
export const WINDOWS_TEST_UNSAFE_FILE_PATH =
  `${WINDOWS_TEST_DESKTOP_DIR_FORWARD}/unsafe.txt`;
export const WINDOWS_TEST_SOMETHING_FILE_PATH =
  `${WINDOWS_TEST_DESKTOP_DIR_FORWARD}/something.txt`;
export const WINDOWS_TEST_TOP_SECRET_FILE_PATH =
  `${WINDOWS_TEST_HOME_DIR.replace(/\\/g, "/")}/top_secret.txt`;
