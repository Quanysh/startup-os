// An outbound webhook that wakes an external bot routine when something was
// given to it, or when a proposal it filed was decided. Pure: the mutation
// asks `botEventPayload`, `mayReceiveEvents` and `countEvent` and schedules
// the delivery, and the action asks `webhookTarget` and `signBody` when it
// runs. Nothing here reads a table, a clock or the environment.
//
// What may leave: a delivery id, the event name, the company, the bot's
// profile id, the row's id, a short title and (for a decision) the decision.
// Never a note, a summary, a reason or any other body. The signing secret is
// read by the action and never logged, stored or put on a scheduled job.
//
// One URL receives every bot's events (the owner sets it). The receiver must
// route on `agent` and never hand one bot's events to another; Startup OS sends
// a bot only what its profile covers (switched on, the board, its company).

import { type ProposalKind } from "./agents";
import { isBotId, isExternalOwnerAgent, isProfileId, levelOf, type BotPermission } from "./botRules";
import { HEADERS } from "./identity";
import { cleanRemote } from "./mirrorRules";

/** Convex env. Unset URL: the mutation schedules nothing and throws nothing. */
export const WEBHOOK_URL_ENV = "BOT_EVENTS_WEBHOOK_URL";
/** Convex env. The key every request is signed with; without it nothing is sent. */
export const WEBHOOK_SECRET_ENV = "BOT_EVENTS_WEBHOOK_SECRET";
/** Convex env, optional. While rotating: the old key, sent as a second signature. */
export const WEBHOOK_SECRET_PREVIOUS_ENV = "BOT_EVENTS_WEBHOOK_SECRET_PREVIOUS";
/** A secret shorter than this is not used (`openssl rand -hex 32` makes 64). */
export const MIN_SECRET_LENGTH = 32;

/** Seconds since 1970 UTC, as a decimal string: the first part of what is signed. */
export const TIMESTAMP_HEADER = HEADERS.timestamp;
/** Hex HMAC-SHA256 of `${timestamp}.${body}`, keyed with the secret. */
export const SIGNATURE_HEADER = HEADERS.signature;
/** The same, keyed with the previous secret, only while one is set. */
export const PREVIOUS_SIGNATURE_HEADER = HEADERS.previousSignature;
/** How old a request a receiver should still accept (documented; the receiver checks it). */
export const MAX_REQUEST_AGE_SECONDS = 300;

/** At most this many events a bot an hour; the rest are counted and not sent. */
export const EVENTS_PER_BOT_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

export const EVENT_TITLE_LIMIT = 140;
/** How long one POST may take before it counts as a network failure. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/**
 * Delays before attempts 1, 2 and 3. Attempt 0 is the first POST, scheduled
 * immediately. Four tries, then a fixed log line and give up.
 */
export const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

const URL_MAX = 2_048;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const BOT_EVENTS = ["task.assigned", "handoff.assigned", "proposal.decided"] as const;
export type BotEventName = (typeof BOT_EVENTS)[number];

export const BOT_EVENT_DECISIONS = ["approved", "dismissed", "auto_approved"] as const;
export type BotEventDecision = (typeof BOT_EVENT_DECISIONS)[number];

/** A title for a proposal whose payload has none of its own. One per kind. */
export const PROPOSAL_EVENT_TITLES: Record<ProposalKind, string> = {
  task_create: "New task",
  task_change: "Task change",
  deal_next_step: "Deal next step",
  draft: "Draft",
  decision_record: "Decision",
  goal_create: "New goal",
  goal_update: "Goal change",
  bot_permission: "Permission",
  deal_create: "New deal",
  memory_note: "Note",
  comment: "Comment",
  task_archive: "Archive task",
  handoff_reassign: "Handoff",
};

/** The title that may leave: one line, at most {@link EVENT_TITLE_LIMIT} characters. */
export function eventTitle(value: string): string {
  return cleanRemote(value, EVENT_TITLE_LIMIT);
}

/**
 * How a task assignee that is a bot is stored, or null for anything else.
 * A bot of the owner's is its bare id (`growth`). An external owner-agent
 * profile is `bot:<id>` (`bot:engineering`), as a handoff spells it, so it
 * is never the bare id of the Mac agent of that name. The bare four
 * (`chief_of_staff`, `engineering`, `sales`, `finance`) are never a bot
 * assignee, and an address (with "@") is a person.
 */
export function taskAssigneeBot(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  if (id === "" || id.includes("@")) return null;
  if (id.startsWith("bot:")) {
    const bare = id.slice("bot:".length);
    if (isExternalOwnerAgent(bare)) return id;
    return isBotId(bare) ? bare : null;
  }
  if (id.includes(":")) return null;
  return isBotId(id) ? id : null;
}

/** The profile id (`bots.botId`) a stored bot assignee names, or null when it is no bot. */
export function assigneeProfileId(stored: string | null | undefined): string | null {
  const assignee = taskAssigneeBot(stored);
  if (assignee === null) return null;
  return assignee.startsWith("bot:") ? assignee.slice("bot:".length) : assignee;
}

/**
 * The profile a handoff is for, from its stored key. A person (`@…` or
 * `toKind: "person"`), a Mac agent (`mac:`) and a bare one of the four (a
 * row from before handoffs spelled profiles `bot:<id>`) are null: none is
 * woken here.
 */
export function handoffReceivingBot(toKey: string | null | undefined, toKind?: string | null): string | null {
  if (toKind === "person" || typeof toKey !== "string") return null;
  const key = toKey.trim().toLowerCase();
  if (key === "" || key.includes("@") || key.startsWith("mac:")) return null;
  if (key.startsWith("bot:")) {
    const bare = key.slice("bot:".length);
    return isProfileId(bare) ? bare : null;
  }
  return isBotId(key) ? key : null;
}

/**
 * Whether a bot whose profile says this company may hold a task of
 * `taskCompany`. No company on the profile, or "both", covers either market.
 * A shared task (no company) is not refused here; it is also not sent.
 */
export function botCoversCompany(
  botCompany: "us" | "kz" | "both" | undefined,
  taskCompany: "us" | "kz" | undefined,
): boolean {
  if (taskCompany === undefined || botCompany === undefined || botCompany === "both") return true;
  return botCompany === taskCompany;
}

export type ReceivingProfile = {
  enabled: boolean;
  permissions: readonly BotPermission[];
  company?: "us" | "kz" | "both" | undefined;
};

/**
 * Whether a profile may be given a task or be woken about this company's
 * work: switched on, reading or writing the board, and working for that
 * company. Asked when a task is given, when an event is scheduled, and again
 * just before it is sent (a bot switched off since is not woken).
 */
export function mayReceiveEvents(profile: ReceivingProfile | null, company: "us" | "kz" | undefined): boolean {
  if (profile === null || !profile.enabled) return false;
  if (levelOf(profile.permissions, "board") === "none") return false;
  return botCoversCompany(profile.company, company);
}

/** True when the URL env is set to something other than whitespace. Validity is the action's. */
export function webhookConfigured(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.trim() !== "";
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A dotted IPv4 literal (the URL parser has already turned 0x7f.1 or 2130706433 into one). */
function ipv4Of(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function blockedV4([a, b]: readonly number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  );
}

/** The eight words of an IPv6 literal as the URL parser writes it (lower case, no zone, no dotted tail). */
function ipv6Of(host: string): number[] | null {
  if (!host.startsWith("[") || !host.endsWith("]")) return null;
  const inner = host.slice(1, -1);
  const halves = inner.split("::");
  if (halves.length > 2) return null;
  const words = (part: string) => (part === "" ? [] : part.split(":"));
  const head = words(halves[0]!);
  const tail = halves.length === 2 ? words(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (all.length !== 8 || all.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return all.map((word) => parseInt(word, 16));
}

function blockedV6(words: readonly number[]): boolean {
  const [w0] = words;
  if (words.slice(0, 7).every((w) => w === 0) && (words[7] === 0 || words[7] === 1)) return true; // :: and ::1
  if ((w0! & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  if ((w0! & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  // An IPv4 address wearing IPv6 (::ffff:a.b.c.d, or the old ::a.b.c.d): judged as that IPv4 address.
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) {
    return blockedV4([words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff]);
  }
  return false;
}

/**
 * Whether a URL's host (as `URL.hostname` gives it) is one a delivery must
 * never reach: this machine, a private or link-local network, or a cloud
 * metadata service. Only literals and these names are known here; a public
 * name that resolves to a private address is the receiver's operator's to
 * avoid (`docs/assistant.md`, "Waking an external bot").
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal" || host === "metadata") return true;
  const v4 = ipv4Of(host);
  if (v4 !== null) return blockedV4(v4);
  const v6 = ipv6Of(host);
  if (v6 !== null) return blockedV6(v6);
  return false;
}

/**
 * The URL a delivery may POST to. https to a public host. On a local
 * development deployment (`dev`, convex/lib/devLocal.ts), http or https to
 * this machine's own loopback too, and nothing else private. A URL that
 * carries a username or password is refused: that secret would otherwise sit
 * in the request and in the far end's logs.
 */
export function webhookUrl(raw: string | undefined, dev: boolean): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > URL_MAX || CONTROL.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (dev && LOOPBACK_NAMES.has(url.hostname)) return url.href;
  if (url.protocol !== "https:") return null;
  return isBlockedHost(url.hostname) ? null : url.href;
}

/** A secret long enough to sign with, trimmed; else null. */
function secretOf(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < MIN_SECRET_LENGTH || CONTROL.test(trimmed)) return null;
  return trimmed;
}

export type WebhookTarget =
  | { kind: "unset" }
  | { kind: "unusable" }
  | { kind: "ready"; url: string; secret: string; previous: string | null };

/**
 * What the action should do with the env vars, read at delivery time. No
 * secret, or one too short, is unusable: nothing unsigned is ever sent.
 */
export function webhookTarget(env: {
  url: string | undefined;
  secret: string | undefined;
  previous?: string | undefined;
  dev: boolean;
}): WebhookTarget {
  if (!webhookConfigured(env.url)) return { kind: "unset" };
  const url = webhookUrl(env.url, env.dev);
  const secret = secretOf(env.secret);
  if (url === null || secret === null) return { kind: "unusable" };
  const previous = secretOf(env.previous);
  return { kind: "ready", url, secret, previous: previous === secret ? null : previous };
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Hex HMAC-SHA256 of `${timestamp}.${body}`, keyed with `secret` (Web Crypto). */
export async function signBody(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
}

export type EventWindow = { windowStart: number; sent: number; dropped: number };

/**
 * One more event for a bot this hour: sent while fewer than
 * {@link EVENTS_PER_BOT_PER_HOUR} were, otherwise counted as dropped. A new
 * hour starts both counts again. Counts only: nothing of the event is kept.
 */
export function countEvent(row: EventWindow | null, now: number): { send: boolean; row: EventWindow } {
  const windowStart = now - (now % HOUR_MS);
  const current = row !== null && row.windowStart === windowStart ? row : { windowStart, sent: 0, dropped: 0 };
  if (current.sent >= EVENTS_PER_BOT_PER_HOUR) {
    return { send: false, row: { ...current, dropped: current.dropped + 1 } };
  }
  return { send: true, row: { ...current, sent: current.sent + 1 } };
}

type EventBase = {
  deliveryId: string;
  company: "us" | "kz";
  agent: string;
  id: string;
  title: string;
  at: number;
};

export type BotEvent =
  | (EventBase & { event: "task.assigned" | "handoff.assigned" })
  | (EventBase & { event: "proposal.decided"; decision: BotEventDecision });

export type BotEventDraft = {
  event: BotEventName;
  company: "us" | "kz" | undefined;
  /** The receiving profile's id (`bots.botId`), or null when nobody is woken. */
  agent: string | null;
  id: string;
  title: string;
  decision?: BotEventDecision;
  /** Made once when it is scheduled and kept across retries, so a receiver can drop a repeat. */
  deliveryId: string;
  at: number;
};

const ID_MAX = 128;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The JSON object that may be sent, or null when this write is not one we
 * wake anyone for (a person, a shared task, a Mac agent, one of the bare
 * four, a title that cleans to nothing). `decision` is present only on
 * `proposal.decided`.
 */
export function botEventPayload(draft: BotEventDraft): BotEvent | null {
  if (draft.company !== "us" && draft.company !== "kz") return null;
  const agent = typeof draft.agent === "string" ? draft.agent.trim().toLowerCase() : "";
  if (!isProfileId(agent)) return null;
  if (typeof draft.id !== "string" || draft.id.length === 0 || draft.id.length > ID_MAX) return null;
  if (typeof draft.deliveryId !== "string" || !DELIVERY_ID.test(draft.deliveryId)) return null;
  if (!Number.isInteger(draft.at) || draft.at < 0) return null;
  const title = eventTitle(draft.title);
  if (title === "") return null;
  const base = { deliveryId: draft.deliveryId, company: draft.company, agent, id: draft.id, title, at: draft.at };
  if (draft.event === "proposal.decided") {
    if (draft.decision === undefined || !(BOT_EVENT_DECISIONS as readonly string[]).includes(draft.decision)) {
      return null;
    }
    return { ...base, event: "proposal.decided", decision: draft.decision };
  }
  if (draft.event !== "task.assigned" && draft.event !== "handoff.assigned") return null;
  return { ...base, event: draft.event };
}

/** The POST body. No attempt counter, and no decision except on a proposal. */
export function deliveryBody(event: BotEvent): {
  deliveryId: string;
  event: BotEventName;
  company: "us" | "kz";
  agent: string;
  id: string;
  title: string;
  at: number;
  decision?: BotEventDecision;
} {
  const base = {
    deliveryId: event.deliveryId,
    event: event.event,
    company: event.company,
    agent: event.agent,
    id: event.id,
    title: event.title,
    at: event.at,
  };
  return event.event === "proposal.decided" ? { ...base, decision: event.decision } : base;
}
