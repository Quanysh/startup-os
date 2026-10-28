// Globex's Intercom inbox (/support, the `support` area): the closed sets,
// the limits and the rules for where a chat started, shared by the sync
// (convex/support.ts), the parser (./supportParse.ts), the page and the
// owner's agent. Pure: the UI imports it.
//
// What is stored of a conversation is `SupportRow` and nothing more: ids,
// times, states, where it started (a class and a page area, never a URL),
// Fin's outcome, the assignee (a teammate's id and name), counts, a rating's
// score and the titles of the help articles Fin used. Tags are not kept: they
// often hold a customer's or a clinic's name.
// **Never a message, a subject, a contact, a customer's name, address or
// phone, a company or any customer field**: chats may hold patient data, and
// Startup OS holds none.

import { KZ_APP_HOST, KZ_STAGING_HOST } from "./features";

/** Where a chat started. */
export const SUPPORT_ORIGINS = ["customer", "test", "other", "unknown"] as const;
export type SupportOrigin = (typeof SUPPORT_ORIGINS)[number];

/** What Intercom says became of a chat Fin answered (`ai_agent.resolution_state`). */
export const FIN_OUTCOMES = [
  "assumed_resolution",
  "confirmed_resolution",
  "escalated",
  "negative_feedback",
] as const;
export type FinOutcome = (typeof FIN_OUTCOMES)[number];

export const SUPPORT_STATES = ["open", "closed", "snoozed"] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];

/** One conversation as the OS keeps it. Times in ms; `timeToHumanReply` in seconds, as Intercom counts it. */
export type SupportRow = {
  intercomId: string;
  createdAt: number;
  updatedAt: number;
  state: SupportState;
  open: boolean;
  priority: boolean;
  waitingSince: number | null;
  origin: SupportOrigin;
  /** The first one or two path segments under /dashboard, ids dropped: a customer's chat only. */
  pageArea: string | null;
  finParticipated: boolean;
  finOutcome: FinOutcome | null;
  humanRepliedAt: number | null;
  timeToHumanReply: number | null;
  lastCustomerReplyAt: number | null;
  lastHumanReplyAt: number | null;
  assigneeId: string | null;
  assigneeName: string | null;
  parts: number | null;
  reopens: number | null;
  rating: number | null;
  /** Help-center article titles from Globex's own workspace (Fin's sources), not customer text. */
  articles: string[];
};

// ── Limits ──────────────────────────────────────────────────────────────────

/** A push holds every open chat and every chat updated in this many days. */
export const SUPPORT_READ_DAYS = 90;
/** A closed chat not updated in this many days is deleted. */
export const SUPPORT_KEEP_DAYS = 180;
/** The most conversations one push holds: past it the push is refused rather than kept in part. */
export const MAX_SUPPORT_CONVERSATIONS = 500;
/** A help article's title and a teammate's name, at most. */
export const MAX_ARTICLE_TITLE = 120;
export const MAX_ASSIGNEE_NAME = 60;
/** Help articles kept per chat. */
export const MAX_ARTICLES = 10;

// ── Where a chat started ────────────────────────────────────────────────────

/** Globex's product: a chat begun here is a customer's. */
const CUSTOMER_HOST = KZ_APP_HOST;

function urlOf(value: string | null | undefined): URL | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isTestHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    // Globex's staging, under any name.
    host === KZ_STAGING_HOST ||
    host.endsWith(`.${KZ_STAGING_HOST}`) ||
    // Intercom's own previews: the hosted messenger, a workspace's preview page.
    host === "intercom.com" ||
    host.endsWith(".intercom.com")
  );
}

/**
 * Where a chat began, from the page its first message was sent on
 * (`first_contact_reply.url`): Globex's product is a customer; a local
 * machine, staging or one of Intercom's previews is a test; any other host
 * (another product sharing the workspace, atlas.example.com) is other; no page
 * is unknown. The URL is read here and never kept.
 */
export function originOf(value: string | null | undefined): SupportOrigin {
  const url = urlOf(value);
  if (url === null) return "unknown";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "other";
  const host = url.hostname.toLowerCase();
  if (url.pathname.includes("fin_demo_preview") || isTestHost(host)) return "test";
  return host === CUSTOMER_HOST ? "customer" : "other";
}

/** A segment a page area may hold: a plain word, never an id, an address or anything encoded. */
const PLAIN_SEGMENT = /^[a-z][a-z0-9_-]{0,39}$/;
const looksLikeId = (segment: string) => /\d/.test(segment) && segment.length >= 8;

/**
 * Which part of Globex a customer's chat began on: the first one or two
 * path segments under /dashboard, lower-cased, with every segment that is
 * not a plain word (an id, an address, anything encoded) dropped. "dashboard"
 * for the dashboard itself; null off the product, outside /dashboard, or for
 * any chat that is not a customer's. Never a full URL, a query or a fragment.
 */
export function pageAreaOf(value: string | null | undefined): string | null {
  const url = urlOf(value);
  if (url === null || originOf(value) !== "customer") return null;
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.toLowerCase());
  if (segments[0] !== "dashboard") return null;
  const kept = segments
    .slice(1)
    .filter((segment) => PLAIN_SEGMENT.test(segment) && !looksLikeId(segment))
    .slice(0, 2);
  return kept.length === 0 ? "dashboard" : kept.join("/");
}

/**
 * Whether a value is a page area as `pageAreaOf` makes one: "dashboard", or
 * one or two plain lower-case words joined by "/", none an id. What a push
 * says is held to it, so no id, address, URL or query can arrive as one.
 */
export function isPageArea(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "dashboard") return true;
  const segments = value.split("/");
  return (
    segments.length >= 1 &&
    segments.length <= 2 &&
    segments.every((segment) => PLAIN_SEGMENT.test(segment) && !looksLikeId(segment))
  );
}

// ── Links into Intercom ─────────────────────────────────────────────────────

const APP_ID = /^[a-z0-9]{4,16}$/;
const CONVERSATION_ID = /^\d{1,30}$/;

/** Whether a value is plainly a workspace's id code (a made-up one: "abcd1234"). */
export const isAppId = (value: unknown): value is string => typeof value === "string" && APP_ID.test(value);

/** Whether a value is plainly a conversation's id. */
export const isConversationId = (value: unknown): value is string =>
  typeof value === "string" && CONVERSATION_ID.test(value);

/** The inbox in Intercom, or null without a workspace id that is plainly one. */
export function inboxLink(appId: string | null): string | null {
  return isAppId(appId) ? `https://app.intercom.com/a/inbox/${appId}/inbox` : null;
}

/** One conversation in Intercom's inbox, or null where either id is not plainly one. */
export function intercomLink(appId: string | null, conversationId: string): string | null {
  const inbox = inboxLink(appId);
  return inbox === null || !isConversationId(conversationId)
    ? null
    : `${inbox}/conversation/${conversationId}`;
}

// ── How the pushes go ───────────────────────────────────────────────────────

/** The source's id, in the manifest and in `sourceStatus`. */
export const INTERCOM_SOURCE = "intercom";
/**
 * The ingest token the hourly Intercom task on the owner's Mac pushes with
 * (docs/setup.md, "Intercom"), by name. Startup OS never calls
 * Intercom itself and holds no Intercom credential.
 */
export const INTERCOM_TOKEN_ENV = "INGEST_TOKEN_INTERCOM";

export type SupportFailure = "not_configured" | "refused";

/**
 * A stored run's state as a key the page words itself, so the message (which
 * names a path and a rule) stays on Settings › Sources. Null for a good push
 * or none.
 */
export function failureOf(state: string | null | undefined): SupportFailure | null {
  if (state === null || state === undefined || state === "ok") return null;
  return state === "not_configured" ? "not_configured" : "refused";
}
