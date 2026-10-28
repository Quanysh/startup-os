// Rules for the owner's agent token and the endpoint it opens (POST /mcp/v1,
// convex/mcp.ts): what the token looks like, how often it may call, how much
// one request and one answer may hold, and the fixed words for every refusal.
// Pure, so the Assistant page quotes the numbers the server enforces.
//
// Every sentence here is fixed words. None is built from a token, an
// argument or anything a tool returned.

import { MAX_RUNNER_CALLS_PER_WINDOW } from "./chatRules";
import { TOKEN_STEM } from "./identity";
import { base64Url } from "./personalRules";

/**
 * What an agent token begins with. Not the personal token's `sos_`: the
 * ingest endpoint tells a personal token by that prefix, and must never take
 * one of these for one (`"sosa_…".startsWith("sos_")` is false: the fourth
 * character differs).
 */
export const AGENT_TOKEN_PREFIX = `${TOKEN_STEM}a_` as const;
/** Random bytes in a token: 256 bits. */
export const AGENT_TOKEN_BYTES = 32;

export function isAgentToken(given: string): boolean {
  return given.startsWith(AGENT_TOKEN_PREFIX);
}

/** A token made of these bytes. */
export function agentTokenFrom(bytes: Uint8Array): string {
  return `${AGENT_TOKEN_PREFIX}${base64Url(bytes)}`;
}

export const AGENT_SCOPES = ["read", "act"] as const;
/** What a token may do: read the OS, or read it and act in it. */
export type AgentScope = (typeof AGENT_SCOPES)[number];
/** What a tool does. A `read` token calls `read` tools only. */
export type ToolKind = AgentScope;

// ── Clients ─────────────────────────────────────────────────────────────────

/** Named tokens one owner may hold at once: one a client (Claude Code on the Mac, a Grok bot, …). */
export const MAX_AGENT_TOKENS = 20;
/** The longest name of a client, after cleaning. */
export const MAX_CLIENT_NAME = 60;

/** Said when a client's token cannot be made or revoked as asked. Fixed words: none quotes a name. */
export const CLIENT_WORDS = {
  nameMissing: "Give the client a name, so you can tell it apart later.",
  nameTooLong: `A client's name may be at most ${MAX_CLIENT_NAME} characters.`,
  tooMany: `At most ${MAX_AGENT_TOKENS} tokens at once. Revoke one you no longer use first.`,
  oneRunner:
    "Another client already runs the chat and the agents on your Mac. Revoke it first, or make this one without that.",
  runnerActs: "The Mac's runner needs a token that may read and act.",
} as const;

/** The most bytes of one request's body. A tool call is a name and a few short fields. */
export const MAX_MCP_BYTES = 64 * 1024;

// ── How often ───────────────────────────────────────────────────────────────

/** Both limits are counted in a fixed window of this length. */
export const CALL_WINDOW_MS = 10 * 60 * 1000;
/** Tool calls one client may make in a window, of either kind. */
export const MAX_CALLS_PER_WINDOW = 120;
/** Of those, calls of tools that change something. */
export const MAX_ACTS_PER_WINDOW = 30;

export type Window = { windowStart?: number; count?: number };

/**
 * Where a count stands in its window, and what one more does to it. A fixed
 * window: it opens with the first call and is replaced by a new one once it
 * is `CALL_WINDOW_MS` old.
 */
export function nextWindow(
  current: Window,
  at: number,
  max: number,
): { allowed: boolean; windowStart: number; count: number } {
  const open =
    current.windowStart !== undefined &&
    at >= current.windowStart &&
    at - current.windowStart < CALL_WINDOW_MS;
  if (!open) return { allowed: true, windowStart: at, count: 1 };
  const count = current.count ?? 0;
  if (count >= max) return { allowed: false, windowStart: current.windowStart!, count };
  return { allowed: true, windowStart: current.windowStart!, count: count + 1 };
}

// ── What is kept of a call ──────────────────────────────────────────────────

export const AGENT_OUTCOMES = ["ok", "refused", "invalid", "error"] as const;
/**
 * How a tool call ended: it ran; it was refused (the token's scope, the
 * limit, a company or a mirrored row); what was sent was not valid; or it
 * failed.
 */
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

/** The audit table keeps its newest rows, this many at most. */
export const MAX_AGENT_CALLS = 500;
/** And none older than this. */
export const AGENT_CALL_RETENTION_DAYS = 30;
/** Rows the Assistant page lists. */
export const RECENT_AGENT_CALLS = 50;
/** What a call with a tool name the registry does not hold is written as: never the name sent. */
export const UNKNOWN_TOOL = "unknown";

// ── The words ───────────────────────────────────────────────────────────────

export const AGENT_WORDS = {
  unauthorized: "This endpoint needs a token or a sign-in the owner gave this client.",
  tooLarge: `A request may be at most ${MAX_MCP_BYTES / 1024} KB.`,
  parse: "The request is not valid JSON.",
  invalidRequest: "The request is not a JSON-RPC 2.0 request.",
  batch: "Batches are not supported: send one request at a time.",
  version: "That MCP protocol version is not supported.",
  method: "That method is not supported.",
  params: "The parameters of that method are not valid.",
  unknownTool: "There is no tool of that name.",
  limited: `At most ${MAX_CALLS_PER_WINDOW} tool calls in ${CALL_WINDOW_MS / 60_000} minutes. Try again later.`,
  actsLimited: `At most ${MAX_ACTS_PER_WINDOW} changes in ${CALL_WINDOW_MS / 60_000} minutes. Try again later.`,
  runnerLimited: `At most ${MAX_RUNNER_CALLS_PER_WINDOW.toLocaleString("en-US")} chat runner calls in ${CALL_WINDOW_MS / 60_000} minutes. Try again later.`,
  readOnly:
    "This client is read only. The owner can give it a token or a sign-in that may act on Settings › Connections.",
  notAllowed: "That is not allowed.",
  failed: "The tool failed. Nothing was changed.",
  getNotAllowed: "This endpoint answers POST only: it opens no stream.",
} as const;

/** Said when a token could not be made from what the browser sent. */
export const TOKEN_NOT_MADE = "That token could not be made. Try again.";
