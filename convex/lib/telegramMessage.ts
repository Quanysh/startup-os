// What the Telegram bot says, and the rules round it. Pure: no clock, no
// database, no request. The bot posts one kind of message (a task was given
// to someone) into a company's group, and a fixed test sentence.
//
// A task's title and a person's name are text somebody typed. Neither may add
// markup to the message or ping anyone: both go through `plain`.

import { ConvexError } from "convex/values";
import { COMPANIES, type CompanyId } from "./company";
import { PRODUCT } from "./identity";
import { cleanRemote } from "./mirrorRules";

/** Telegram refuses a message longer than this. */
export const TELEGRAM_LIMIT = 4096;
/** How much of a title is quoted. Escaping can make each character five. */
const MAX_QUOTED_TITLE = 300;
const MAX_QUOTED_NAME = 100;
/** How long a group's title may be, as stored and shown. */
export const MAX_CHAT_TITLE = 100;
/** How many groups "Find my groups" offers. */
export const MAX_FOUND_CHATS = 20;
/** Messages one group is sent in an hour; the rest are dropped. */
export const HOURLY_LIMIT = 30;

export const TEST_MESSAGE = `${PRODUCT.name} is connected to this group.`;

// ── What can go wrong, in fixed words ───────────────────────────────────────

// The only sentences ever stored or shown about a request to Telegram. The
// request's address holds the bot's token, so nothing a request throws or
// Telegram answers is ever kept: one of these is chosen instead.
export const TELEGRAM_FAILURES = {
  token: "Telegram refused the bot's token.",
  chat: "The bot is not in that group or cannot post there.",
  timeout: "Telegram did not answer in time.",
  unreachable: "Telegram could not be reached.",
  slow: "Telegram asked the bot to slow down; the message was not sent.",
  flood: "Too many messages in an hour; some were not sent.",
  badToken: "TELEGRAM_BOT_TOKEN is not a bot token.",
  updates: "Telegram would not list what the bot has seen. A bot with a webhook cannot be asked.",
  webhook: "Telegram would not change where the bot's updates go.",
  noSite: "This deployment has no https address for Telegram to call.",
  delivery: "Telegram could not deliver the last update to the OS.",
  other: "Telegram answered with an error.",
} as const;
export type TelegramFailure = keyof typeof TELEGRAM_FAILURES;

const FAILURE_SENTENCES: readonly string[] = Object.values(TELEGRAM_FAILURES);
/** Whether a string is one of the fixed sentences: all a status row may hold. */
export const isTelegramFailure = (text: string) => FAILURE_SENTENCES.includes(text);

// ── The token ───────────────────────────────────────────────────────────────

/**
 * Whether a value has the shape of a bot token. It goes into a request's
 * address, so it is checked first and never echoed.
 */
export function isBotToken(value: string): boolean {
  return /^\d{3,20}:[A-Za-z0-9_-]{30,100}$/.test(value);
}

// ── A person's username ─────────────────────────────────────────────────────

export const NOT_A_USERNAME =
  "That is not a Telegram username: 5 to 32 letters, digits or underscores.";

/**
 * A Telegram username as it is stored: as typed, without the leading "@".
 * Nothing typed is no username. Anything else is refused in fixed words,
 * since the username is written into a message as a tag.
 */
export function cleanTelegram(raw: string): string | undefined {
  const typed = raw.trim().replace(/^@/, "");
  if (typed === "") return undefined;
  if (!/^[A-Za-z0-9_]{5,32}$/.test(typed)) throw new ConvexError(NOT_A_USERNAME);
  return typed;
}

/** Two usernames are one person's whatever their capitals. */
export const sameTelegram = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ── Text somebody typed ─────────────────────────────────────────────────────

/** The first `max` characters, whole ones, with an ellipsis where it was cut. */
function cut(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : text;
}

/**
 * Typed text made safe to put in a message: one line, nothing invisible, the
 * three characters Telegram's HTML reads escaped, and every "@" replaced by
 * the full-width sign, which Telegram does not read as a mention.
 */
export function plain(text: string): string {
  return cleanRemote(text, Number.MAX_SAFE_INTEGER)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "＠");
}

const quoted = (text: string, max: number) =>
  plain(cut(cleanRemote(text, Number.MAX_SAFE_INTEGER), max));

// ── Which group ─────────────────────────────────────────────────────────────

export type Chat = {
  id: string;
  title: string;
  /** How many are in it, when Telegram has been asked. */
  members?: number;
  /** When Telegram said the bot left it or was removed; gone once the bot is seen there again. */
  leftAt?: number;
};

/**
 * The group a task's message goes to: its company's. A shared task goes to
 * Startup's group if one is set, else Globex's. None set, none sent.
 */
export function chatFor(
  company: CompanyId | undefined,
  chats: { us?: Chat; kz?: Chat },
): Chat | undefined {
  if (company !== undefined) return chats[company];
  return chats.us ?? chats.kz;
}

// ── The link ────────────────────────────────────────────────────────────────

/**
 * The board's address from SITE_URL, or nothing when that is not a plain
 * site address: it is written into the message as a link.
 */
export function boardUrlOf(siteUrl: string | undefined): string | undefined {
  const site = (siteUrl ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(site)) return undefined;
  return `${site}/board`;
}

// ── The message ─────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Oct 2026" for "2026-10-20"; nothing for anything else. */
export function dayInWords(due: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due ?? "");
  if (match === null) return undefined;
  const month = MONTHS[Number(match[2]) - 1];
  return month === undefined ? undefined : `${Number(match[3])} ${month} ${match[1]}`;
}

export type Assignment = {
  /** The assignee's Telegram username, already through `cleanTelegram`. */
  username: string | undefined;
  /** The name they signed in with, used when there is no username. */
  name: string | undefined;
  title: string;
  /** Left out for a shared task. */
  company: CompanyId | undefined;
  due: string | undefined;
  /** The name of whoever assigned it. */
  actor: string | undefined;
  boardUrl: string | undefined;
};

/**
 * The one message: who the task is for, its title, then a line with the
 * company, the due date, who assigned it and a link to the board. Never the
 * task's notes, never an address.
 */
export function assignmentMessage(a: Assignment): string {
  const who =
    a.username !== undefined && /^[A-Za-z0-9_]{5,32}$/.test(a.username)
      ? `@${a.username}`
      : a.name !== undefined && a.name.trim() !== ""
        ? quoted(a.name, MAX_QUOTED_NAME)
        : "a teammate";
  const due = dayInWords(a.due);
  const actor = a.actor !== undefined && a.actor.trim() !== "" ? a.actor : undefined;
  const rest = [
    a.company === undefined ? "Both" : COMPANIES[a.company].name,
    due === undefined ? undefined : `due ${due}`,
    actor === undefined ? undefined : `from ${quoted(actor, MAX_QUOTED_NAME)}`,
    a.boardUrl === undefined ? undefined : `<a href="${a.boardUrl}">Open the board</a>`,
  ].filter((part) => part !== undefined);
  return [`<b>New task</b> for ${who}`, quoted(a.title, MAX_QUOTED_TITLE), rest.join(" · ")].join(
    "\n",
  );
}

/** /handoffs' address from SITE_URL, under the same rule as the board's. */
export const handoffsUrlOf = (siteUrl: string | undefined): string | undefined =>
  boardUrlOf(siteUrl)?.replace(/\/board$/, "/handoffs");

/** How much of a handoff's summary the group is shown. */
const MAX_QUOTED_SUMMARY = 300;
/** A bot's id as it may appear in a message: a plain slug, else "a bot". */
const BOT_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export type HandoffNotice = {
  /** The person's Telegram username, already through `cleanTelegram`. */
  username: string | undefined;
  /** The name they signed in with, used when there is no username. */
  name: string | undefined;
  /** Null: not for the group (a bot that reads the company's figures wrote it); the summary is then "". */
  title: string | null;
  summary: string;
  company: CompanyId;
  /** The bot that handed it over, by its profile's id. */
  bot: string;
  url: string | undefined;
};

/**
 * A bot handed a person work: who it is for, its title, the start of its
 * summary, then the company, the bot and a link to /handoffs. Never an
 * address; the title and summary are quoted as text.
 */
export function handoffMessage(h: HandoffNotice): string {
  const who =
    h.username !== undefined && /^[A-Za-z0-9_]{5,32}$/.test(h.username)
      ? `@${h.username}`
      : h.name !== undefined && h.name.trim() !== ""
        ? quoted(h.name, MAX_QUOTED_NAME)
        : "a teammate";
  const bot = BOT_SLUG.test(h.bot) ? h.bot : "a bot";
  const rest = [
    COMPANIES[h.company].name,
    `from ${bot}`,
    h.url === undefined ? undefined : `<a href="${h.url}">Open handoffs</a>`,
  ].filter((part) => part !== undefined);
  if (h.title === null) return [`<b>New handoff</b> for ${who}`, rest.join(" · ")].join("\n");
  const summary = h.summary.trim() === "" ? [] : [quoted(h.summary, MAX_QUOTED_SUMMARY)];
  return [`<b>New handoff</b> for ${who}`, quoted(h.title, MAX_QUOTED_TITLE), ...summary, rest.join(" · ")].join("\n");
}

// ── The groups the bot has seen ─────────────────────────────────────────────

export type FoundChat = {
  id: string;
  title: string;
  type: "group" | "supergroup";
  /** How many are in it, when Telegram has been asked: what tells two groups of one name apart. */
  members?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The kinds of update that name the chat they happened in. */
const WHERE = ["message", "edited_message", "my_chat_member"] as const;

/**
 * The username of whoever sent a message or changed the bot's membership, when
 * it is one and they are not a bot. Nothing else of them is read.
 */
export function actorOf(event: unknown): string | undefined {
  const from = isRecord(event) ? event.from : undefined;
  if (!isRecord(from) || from.is_bot === true) return undefined;
  const { username } = from;
  return typeof username === "string" && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : undefined;
}

/** Whether a change to the bot's own membership says it is no longer in the group. */
export function botIsGone(event: unknown): boolean {
  const now = isRecord(event) ? event.new_chat_member : undefined;
  return isRecord(now) && (now.status === "left" || now.status === "kicked");
}

/**
 * The distinct groups and supergroups in an answer to `getUpdates`, each as
 * its id, title and type. A group counts only when the update gives a reason
 * to believe the team is in it: whoever wrote there, or added the bot, has a
 * username on record (`vouched`, lower-cased). Anyone can add a bot to a group
 * of their own and call it what they like. A group the bot has since left is
 * not one. Nothing else in an update is read: no text, and of the sender only
 * the username. An answer in another shape holds no groups.
 */
export function chatsFromUpdates(vouched: ReadonlySet<string>, json: unknown): FoundChat[] {
  if (!isRecord(json) || json.ok !== true || !Array.isArray(json.result)) return [];
  const found = new Map<string, FoundChat>();
  for (const update of json.result) {
    if (!isRecord(update)) continue;
    for (const key of WHERE) {
      const event = update[key];
      const chat = isRecord(event) ? event.chat : undefined;
      if (!isRecord(chat)) continue;
      const { id, type } = chat;
      if (type !== "group" && type !== "supergroup") continue;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
      if (key === "my_chat_member" && botIsGone(event)) {
        found.delete(String(id));
        continue;
      }
      const by = actorOf(event);
      if (by === undefined || !vouched.has(by.toLowerCase())) continue;
      const title = cleanRemote(chat.title, MAX_CHAT_TITLE);
      if (title === "") continue;
      if (!found.has(String(id))) found.set(String(id), { id: String(id), title, type });
    }
  }
  return [...found.values()].slice(0, MAX_FOUND_CHATS);
}

/**
 * The list of groups seen, with one more: newest first, `MAX_FOUND_CHATS` at
 * most. A group already listed is changed where it stands, so seeing it again
 * can put nobody out. When the list is full the one seen longest ago goes,
 * never one of `picked`: a group the owner chose stays on offer. The same
 * array comes back when there is nothing to change.
 */
export function rememberChat(
  found: readonly FoundChat[],
  chat: FoundChat,
  picked: readonly string[],
): readonly FoundChat[] {
  const known = found.find((one) => one.id === chat.id);
  if (known !== undefined) {
    if (known.title === chat.title && known.type === chat.type) return found;
    return found.map((one) => (one.id === chat.id ? { ...one, ...chat } : one));
  }
  const next = [chat, ...found];
  while (next.length > MAX_FOUND_CHATS) {
    const oldest = next.findLastIndex((one, at) => at > 0 && !picked.includes(one.id));
    if (oldest === -1) return found;
    next.splice(oldest, 1);
  }
  return next;
}
