// Where the chat's runner (scripts/assistantRunner.ts) finds the OS's agent
// endpoint and the owner's agent token: Claude Code's own user configuration
// on this Mac, where the owner put them when he connected Claude on
// /assistant. So there is one token, kept in one place, and nothing new to
// set up.
//
// Only the OS's own entry of `mcpServers` (`startup-os`, PRODUCT.slug) is read.
// The token is returned to the caller and to nobody else: nothing here prints,
// logs or writes it, and no refusal quotes anything that was read. Pure but
// for the injected reader.

import { AGENT_TOKEN_PREFIX } from "../convex/lib/agentRules";
import { APP_URL, PRODUCT } from "../convex/lib/identity";

export const SERVER_NAME = PRODUCT.slug;
/** The one address the runner talks to. */
export const PRODUCTION_URL = `${APP_URL}/mcp/v1`;

export const CONFIG_WORDS = {
  notConnected: `Claude Code on this Mac is not connected to ${PRODUCT.name}. Open /assistant in the app, create a token that may read and act, add it to Claude Code as the page shows (for your user, not one project), then run this again.`,
  wrongUrl: `The ${SERVER_NAME} connection in Claude Code does not point at ${PRODUCTION_URL}. Nothing was sent. Connect Claude again from /assistant. (A localhost address is taken only with --local.)`,
  tokenFileMode:
    "The file STARTUP_OS_AGENT_TOKEN_FILE names can be read by others. Make it yours alone (chmod 600) and run this again.",
  overrideHalf: "Set both STARTUP_OS_MCP_URL and STARTUP_OS_AGENT_TOKEN_FILE, or neither.",
} as const;

export type Target = { url: string; token: string };
export type Found = Target | { problem: string };

export type ConfigDeps = {
  /** Reads a file as text; throws when it cannot. */
  readFile: (path: string) => string;
  /** A file's permission bits. */
  fileMode: (path: string) => number;
};

const TOKEN = new RegExp(`^${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{20,200}$`);
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/mcp\/v1$/;

/** Whether the runner may send the token to this address. */
export function urlAllowed(url: unknown, local: boolean): url is string {
  if (typeof url !== "string") return false;
  return url === PRODUCTION_URL || (local && LOCAL.test(url));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fromClaude(configPath: string, local: boolean, deps: ConfigDeps): Found {
  let entry: unknown;
  try {
    const parsed: unknown = JSON.parse(deps.readFile(configPath));
    // This one entry, and nothing else of the file.
    entry = isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers[SERVER_NAME] : undefined;
  } catch {
    return { problem: CONFIG_WORDS.notConnected };
  }
  if (!isObject(entry) || !isObject(entry.headers)) return { problem: CONFIG_WORDS.notConnected };
  const header = entry.headers.Authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return { problem: CONFIG_WORDS.notConnected };
  }
  const token = header.slice("Bearer ".length);
  if (!TOKEN.test(token)) return { problem: CONFIG_WORDS.notConnected };
  if (!urlAllowed(entry.url, local)) return { problem: CONFIG_WORDS.wrongUrl };
  return { url: entry.url, token };
}

/**
 * The endpoint and the token, or the reason the runner will not start, in
 * fixed words. With `STARTUP_OS_MCP_URL` and `STARTUP_OS_AGENT_TOKEN_FILE` both
 * set (tests, a local backend) those are used instead of Claude's
 * configuration: the file must be the caller's alone, and the address is held
 * to the same rule either way.
 */
export function discover(
  input: { configPath: string; local: boolean; env: Record<string, string | undefined> },
  deps: ConfigDeps,
): Found {
  const url = input.env.STARTUP_OS_MCP_URL;
  const tokenFile = input.env.STARTUP_OS_AGENT_TOKEN_FILE;
  if (!url && !tokenFile) return fromClaude(input.configPath, input.local, deps);
  if (!url || !tokenFile) return { problem: CONFIG_WORDS.overrideHalf };
  if (!urlAllowed(url, input.local)) return { problem: CONFIG_WORDS.wrongUrl };
  try {
    if ((deps.fileMode(tokenFile) & 0o077) !== 0) return { problem: CONFIG_WORDS.tokenFileMode };
    const token = deps.readFile(tokenFile).trim();
    return TOKEN.test(token) ? { url, token } : { problem: CONFIG_WORDS.notConnected };
  } catch {
    return { problem: CONFIG_WORDS.notConnected };
  }
}
