// Bot-to-bot handoffs: one agent finishing its part and asking another to take
// over ("Research done, Growth takes over"), kept where the owner can see them
// (/handoffs). Coordination records, not owner data: the bots write them
// directly, each as itself, and the owner can reassign or close any of them.
// Pure: the clock and the rows are arguments.

import { ConvexError } from "convex/values";
import { PRODUCT } from "./identity";

export const HANDOFF_STATUSES = ["open", "accepted", "done", "declined", "closed"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const HANDOFF_STATUS_LABELS: Readonly<Record<HandoffStatus, string>> = {
  open: "Open",
  accepted: "Accepted",
  done: "Done",
  declined: "Declined",
  closed: "Closed",
};

/** A handoff in these is over: only the owner's reassignment could reopen it, and that is refused too. */
export const FINISHED_STATUSES: readonly HandoffStatus[] = ["done", "declined", "closed"];

export const HANDOFF_ACTIONS = ["create", "accept", "decline", "done", "reassign", "close"] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

/** What a bot may do to a handoff addressed to it. */
export const BOT_ACTIONS = ["accept", "decline", "done"] as const;
export type BotAction = (typeof BOT_ACTIONS)[number];

export const HANDOFF_LINK_KINDS = ["task", "deal", "decision"] as const;
export type HandoffLinkKind = (typeof HANDOFF_LINK_KINDS)[number];

export const MAX_BOT_NAME = 40;
export const MAX_HANDOFF_SUMMARY = 1500;
export const MAX_HANDOFF_NOTE = 500;
export const MAX_HANDOFF_LINKS = 5;
/** Status changes kept on one handoff; the newest win. A handoff changes a few times, not hundreds. */
export const MAX_HANDOFF_HISTORY = 30;
/** Rows one list sends: open ones first, then the latest finished. */
export const HANDOFF_OPEN_ROWS = 200;
export const HANDOFF_FINISHED_ROWS = 100;
/** An open handoff nobody accepted within this long needs the owner. */
export const HANDOFF_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * What a handoff is called to someone not sent its words: a bot that reads
 * the company's figures wrote it, and they do not hold every page those
 * figures are on (`FIGURE_AREAS`, convex/handoffs.ts).
 */
export const HANDOFF_WITHHELD = "A handoff between bots that may hold the company's figures";

export const HANDOFF_WORDS = {
  notYours: "That handoff is not addressed to you, so you cannot answer it.",
  gone: "That handoff is no longer there.",
  finished: "That handoff is already finished.",
  needsAccept: "Only an open handoff can be accepted.",
  needsReason: "Say why in the note.",
  nameNeeded: "A handoff needs a bot name, such as growth.",
  toSelf: "A handoff goes to another bot, not to the one handing it over.",
  ambiguous: "That id matches more than one bot, so it was not addressed. Use one bot's id.",
  link: "A link must be a task, deal or decision of this company that is still there.",
  unknownPerson:
    "That address is not one of this company's people who can open /handoffs. Read `people` for who a handoff can go to.",
  botsToPeople: "Only a bot with write on the board may hand work to a person. Name your bot.",
  contact:
    "Leave email addresses and phone numbers out of a handoff to a person: its title and summary are posted in the company's Telegram group. Name people by name and role.",
} as const;

// ── Handoffs to people (Bot Loop v3) ────────────────────────────────────────
// `to` (and `from`) is a bot or a person: `{type: "bot", id}` or
// `{type: "person", email}`. A plain string with no "@" is a bot, as before;
// with one it is a person's address. A person is stored by their lower-cased
// address with `toKind: "person"`, and keyed "@<address>", which no bot's key
// (letters, digits and "_") can ever be.

/** Handoffs to people one bot may make in a UTC day. */
export const PERSON_HANDOFFS_PER_DAY = 20;
/** How much of a summary the person's notification carries. */
export const NOTIFIED_SUMMARY = 300;
const MAX_EMAIL = 254;

export type HandoffParty = { type: "bot"; id: string } | { type: "person"; email: string };
export type PartyInput = string | HandoffParty;

/** A person's address as stored: trimmed, lower case, one plausible address, or null. */
export function cleanEmail(email: string): string | null {
  const one = email.trim().toLowerCase();
  if (one.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(one)) return null;
  return one;
}

/** What a call's `to` names: a bot (a plain name), or a person (an address). */
export function partyOf(input: PartyInput): HandoffParty {
  if (typeof input !== "string") {
    if (input.type === "bot") return { type: "bot", id: cleanBotName(input.id) };
    const email = cleanEmail(input.email);
    if (email === null) throw new ConvexError(HANDOFF_WORDS.unknownPerson);
    return { type: "person", email };
  }
  if (!input.includes("@")) return { type: "bot", id: cleanBotName(input) };
  const email = cleanEmail(input);
  if (email === null) throw new ConvexError(HANDOFF_WORDS.unknownPerson);
  return { type: "person", email };
}

/** The key a person is matched by: "@" and the address. */
export const personKey = (email: string): string => `@${email.trim().toLowerCase()}`;

/** The key of a name as a filter gives it: an address is a person's, anything else a bot's. */
export const keyOf = (name: string): string => (name.includes("@") ? personKey(name) : handoffKey(name));

/** A stored side of a handoff as the union the tools send. */
export const refOf = (name: string, kind: "person" | undefined): HandoffParty =>
  kind === "person" ? { type: "person", email: name } : { type: "bot", id: name };

/** Whether an open handoff to a person has gone a day with nothing done. */
export const isPersonStale = (
  h: { status: HandoffStatus; openSince: number; toKind?: "person" | undefined },
  now: number,
): boolean => h.toKind === "person" && isUnaccepted(h, now);

/** The start of the UTC day of `now`. */
export const utcDayStart = (now: number): number => now - (now % (24 * 60 * 60 * 1000));

/** What the sending bot is told of a person's "done": the id, their note, and who. */
export function completionOf(row: {
  _id: string;
  history: readonly HistoryEntry[];
}): { id: string; note: string | null; by: string } {
  const done = [...row.history].reverse().find((entry) => entry.action === "done");
  return { id: row._id, note: done?.note ?? null, by: done?.by ?? "" };
}

/** A bot's name as typed: trimmed, one line, within the cap. Blank is refused. */
export function cleanBotName(name: string): string {
  const one = name.replace(/\s+/g, " ").trim();
  if (one === "" || one.length > MAX_BOT_NAME) throw new ConvexError(HANDOFF_WORDS.nameNeeded);
  return one;
}

/** What two spellings of one bot share: "Growth", "growth " and "GROWTH" are one. */
export const botKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

// ── The external owner-agents (security review, 2026-10-19) ────────────────
// `chief_of_staff`, `engineering` and `finance` are each one of the Mac's four
// and, named through any other client, a bot profile (convex/lib/botRules.ts,
// `EXTERNAL_OWNER_AGENTS`). The two must not share a handoff key: the profile
// is `bot:<id>` (as its trust is, `externalProposerOf`), which `botKey` can
// never be (":" becomes "_"), and only a call the endpoint matched to the
// profile (`callerName`'s `bot`) is given that name. The Mac agent is
// `mac:<id>`.
//
// A bare slug such as `engineering` is the profile's id (`whoami`'s `bot.id`).
// It maps to that profile: a new handoff is stored as `bot:<id>`, and the
// answer warns, because the same slug is also the Mac agent's id. A row still
// stored under the bare id (from before this) is the profile's too, so
// `my_inbox` and `handoff_update` agree. An id that matches two bot profiles
// is refused rather than guessed.

/** The ids that have an external profile: botRules' `EXTERNAL_OWNER_AGENTS` (a test pins the two). */
export const EXTERNAL_HANDOFF_IDS = ["chief_of_staff", "engineering", "finance"] as const;
export type ExternalHandoffId = (typeof EXTERNAL_HANDOFF_IDS)[number];
/** An external profile's handoff name: `bot:chief_of_staff`. */
export const externalHandoffName = (id: ExternalHandoffId): string => `bot:${id}`;
/** The Mac agent of one of those ids: `mac:engineering`. */
export const macHandoffName = (id: ExternalHandoffId): string => `mac:${id}`;

const isExternalHandoffId = (id: string): id is ExternalHandoffId =>
  (EXTERNAL_HANDOFF_IDS as readonly string[]).includes(id);

/** `bot:<id>` or `mac:<id>` for an external profile's id, else null. The key is the name itself. */
function prefixed(prefix: "bot" | "mac", name: string): string | null {
  const one = name.trim().toLowerCase();
  const head = `${prefix}:`;
  if (!one.startsWith(head)) return null;
  const id = one.slice(head.length);
  return isExternalHandoffId(id) ? `${head}${id}` : null;
}

/** The key a handoff's side is matched by: a profile's or the Mac agent's own name, else the bot's key. */
export const handoffKey = (name: string): string => prefixed("bot", name) ?? prefixed("mac", name) ?? botKey(name);

/**
 * Said when a bare slug was taken as the bot profile. The id is one of
 * `EXTERNAL_HANDOFF_IDS`, never text the caller typed past that.
 */
export function sharedAgentWarning(id: ExternalHandoffId): string {
  return `That id is also the owner's Mac agent. This handoff was addressed to the bot profile bot:${id}. Address the Mac agent as mac:${id}.`;
}

export type BotAssignment = { to: string; toKey: string; warning: string | null };

/**
 * Who a bot id is stored as. `bot:<id>` is the profile, `mac:<id>` the Mac
 * agent, and a bare `engineering` (any spelling `botKey` folds) the profile,
 * with a warning. Any other name keeps its own key.
 */
export function assignBot(id: string): BotAssignment {
  const cleaned = cleanBotName(id);
  const mac = prefixed("mac", cleaned);
  if (mac !== null) return { to: mac, toKey: mac, warning: null };
  const bot = prefixed("bot", cleaned);
  if (bot !== null) return { to: bot, toKey: bot, warning: null };
  const key = botKey(cleaned);
  if (isExternalHandoffId(key)) {
    const to = externalHandoffName(key);
    return { to, toKey: to, warning: sharedAgentWarning(key) };
  }
  return { to: cleaned, toKey: key, warning: null };
}

/**
 * Whether `assignment` names more than one bot profile, so it must be refused
 * rather than stored. A profile matches by its id or its name (`botKey`).
 * The Mac form matches no profile.
 */
export function profileClash(
  assignment: { toKey: string },
  profiles: readonly { botId: string; name: string }[],
): boolean {
  const key = assignment.toKey.startsWith("bot:")
    ? assignment.toKey.slice("bot:".length)
    : assignment.toKey.startsWith("mac:")
      ? ""
      : assignment.toKey;
  const want = botKey(key);
  if (want === "") return false;
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (botKey(profile.botId) === want || botKey(profile.name) === want) ids.add(profile.botId);
  }
  return ids.size > 1;
}

/**
 * The stored keys a `to` filter names. A bare external id and `bot:<id>` are
 * the same profile, including a legacy row still stored under the bare id.
 */
export function addressKeys(name: string): readonly string[] {
  if (name.includes("@")) return [personKey(name)];
  const mac = prefixed("mac", name);
  if (mac !== null) return [mac];
  const bot = prefixed("bot", name);
  if (bot !== null) return [bot, bot.slice("bot:".length)];
  const key = botKey(name);
  if (isExternalHandoffId(key)) return [externalHandoffName(key), key];
  return [key];
}

/**
 * The stored keys this caller may answer. The matched profile (`bot:<id>`)
 * answers that key and the legacy bare id. The Mac agent, whose caller name
 * is the bare id, answers only `mac:<id>`. A person is already `@<address>`.
 */
export function answerKeys(caller: string): readonly string[] {
  // A person is already keyed "@<address>". Folding that through `botKey` would drop the "@".
  if (caller.startsWith("@")) return [caller];
  const key = handoffKey(caller);
  const bot = prefixed("bot", key);
  if (bot !== null) return [bot, bot.slice("bot:".length)];
  const mac = prefixed("mac", key);
  if (mac !== null) return [mac];
  if (isExternalHandoffId(key)) return [macHandoffName(key)];
  return [key];
}

/**
 * A handoff stored under a bare external id, rewritten to the bot profile.
 * A person and anything already canonical are left alone: null. The migration
 * asks this only of open rows.
 */
export function repairedAddressee(
  toKey: string,
  toKind: "person" | undefined,
): { to: string; toKey: string } | null {
  if (toKind === "person") return null;
  if (!isExternalHandoffId(toKey)) return null;
  const to = externalHandoffName(toKey);
  return { to, toKey: to };
}

/** Who the repair says it was (the product, by its slug), and the note it leaves. Fixed words, no title. */
export const HANDOFF_REPAIR_BY = PRODUCT.slug;
export const HANDOFF_REPAIR_NOTE = "Addressed to the bot profile.";

/**
 * Which bot a call is: the owner's bot the endpoint matched to a profile (its
 * id, verified: `ToolClock.bot`), else the agent a run names in its header,
 * else the `agent` argument (by then one of the four: any other name went
 * through a bot profile), else the client the token belongs to. Only a matched
 * bot profile is checked identity; the rest are names held to one owner's
 * tokens, which keep honest callers from answering each other's handoffs.
 */
export function callerName(parts: {
  bot?: string | undefined;
  header?: string | undefined;
  argument?: string | undefined;
  clientName?: string | undefined;
}): string {
  // The external chief of staff (or engineering) the endpoint matched: its own name, never the Mac's.
  if (parts.bot !== undefined && (EXTERNAL_HANDOFF_IDS as readonly string[]).includes(parts.bot)) {
    return externalHandoffName(parts.bot as (typeof EXTERNAL_HANDOFF_IDS)[number]);
  }
  for (const candidate of [parts.bot, parts.header, parts.argument, parts.clientName]) {
    // Only a matched profile may be `bot:…`: any other name loses its ":" (a client called "bot:chief_of_staff" is not it).
    if (candidate !== undefined && botKey(candidate) !== "") return cleanBotName(candidate.replace(/:/g, " ").slice(0, MAX_BOT_NAME));
  }
  return "agent";
}

type Gate = { status: HandoffStatus; toKey: string };

/**
 * Whether the bot named `callerKey` may take `action` on this handoff, as a
 * sentence when not. Only the receiving bot answers; accepting needs it open;
 * a decline needs a reason; nothing finished changes.
 */
export function botMayAct(handoff: Gate, callerKey: string, action: BotAction, note: string): string | null {
  if (!answerKeys(callerKey).includes(handoff.toKey)) return HANDOFF_WORDS.notYours;
  if (FINISHED_STATUSES.includes(handoff.status)) return HANDOFF_WORDS.finished;
  if (action === "accept" && handoff.status !== "open") return HANDOFF_WORDS.needsAccept;
  if (action === "decline" && note.trim() === "") return HANDOFF_WORDS.needsReason;
  return null;
}

export const STATUS_AFTER: Readonly<Record<BotAction, HandoffStatus>> = {
  accept: "accepted",
  decline: "declined",
  done: "done",
};

export type HistoryEntry = { at: number; by: string; action: HandoffAction; note?: string | undefined };

/** The history with one entry added, cut to the newest `MAX_HANDOFF_HISTORY`. */
export const withEntry = (history: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] =>
  [...history, entry].slice(-MAX_HANDOFF_HISTORY);

/** Whether an open handoff has gone a day without being accepted. */
export const isUnaccepted = (h: { status: HandoffStatus; openSince: number }, now: number): boolean =>
  h.status === "open" && now - h.openSince > HANDOFF_STALE_MS;
