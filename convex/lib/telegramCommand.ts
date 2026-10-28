// What the Telegram bot is told, and what it answers. Pure: no clock, no
// database, no request.
//
// An update arrives from outside, on a route whose only guard is a shared
// secret. Every field of it is treated as hostile: `parseUpdate` keeps the
// few fields the bot uses, each checked for type and length, and drops the
// rest unread. What somebody typed is data and never an instruction: a title
// that looks like a command is a title.

import { ALL_COMPANY_IDS, COMPANIES, hashtagOf, type CompanyId } from "./company";
import { COMPANY_IDENTITY, PRODUCT, TELEGRAM_WEBHOOK_LABEL } from "./identity";
import { MAX_TITLE_LENGTH } from "./limits";
import { cleanRemote } from "./mirrorRules";
import { isCanonicalPeriodStart } from "./periods";
import {
  MAX_CHAT_TITLE,
  actorOf,
  botIsGone,
  dayInWords,
  plain,
  type FoundChat,
} from "./telegramMessage";

export const WEBHOOK_PATH = "/telegram/v1/webhook";
/** The largest update read. Telegram's own are a few kilobytes. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;
/**
 * How old a message or a membership change may be and still be acted on.
 * Telegram holds what it could not deliver; a task asked for an hour ago,
 * while commands were off or the deployment was down, is not added now.
 */
export const MAX_UPDATE_AGE_MS = 10 * 60 * 1000;
/** The longest text Telegram sends in one message. */
const MAX_TEXT = 4096;
const MAX_ENTITIES = 50;
const USERNAME = /^[A-Za-z0-9_]{5,32}$/;

// Limits on what the group can make the bot do.
/** Tasks one group may add in an hour, and all groups in a day. */
export const TASKS_PER_CHAT_PER_HOUR = 30;
export const TASKS_PER_DAY = 100;
/** Replies other than "Added" one group gets in an hour. */
export const REPLIES_PER_CHAT_PER_HOUR = 10;
/** Times an hour a group is told "only teammates", so a stranger cannot make the bot spam. */
export const REFUSALS_PER_CHAT_PER_HOUR = 2;

// ── The webhook's secret ────────────────────────────────────────────────────

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The secret Telegram sends back with every update, so the route can tell
 * Telegram from anyone else. Derived from the bot's token (HMAC-SHA256 of a
 * fixed label, TELEGRAM_WEBHOOK_LABEL, keyed by the token, as hex; changing
 * the label on a live deployment refuses every update): it exists whenever the token
 * does, is never stored, and cannot be turned back into the token.
 */
export async function webhookSecret(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(TELEGRAM_WEBHOOK_LABEL)));
}

/** The address Telegram is told to call, from the deployment's own; nothing if that is not https. */
export function webhookUrlOf(site: string | undefined): string | undefined {
  const base = (site ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(base)) return undefined;
  return `${base}${WEBHOOK_PATH}`;
}

// ── An update, read strictly ────────────────────────────────────────────────

export type Entity = {
  type: "mention" | "text_mention" | "hashtag";
  offset: number;
  length: number;
};

export type InboundMessage = {
  chatId: string;
  messageId: number;
  /** The sender's Telegram id, and their username if they have one. */
  from: { id: string; username?: string };
  /** The message's text, or a photo's caption when it came with entities. */
  text: string;
  entities: Entity[];
  caption: boolean;
};

export type InboundUpdate = {
  updateId: number;
  /** The group it happened in: all that is kept of a chat the bot does not post to. */
  chat?: FoundChat;
  /** When Telegram says it happened, in milliseconds. Always there when `chat` is. */
  at?: number;
  /**
   * The username of whoever wrote in the group or added the bot to it, when
   * they have one: the only reason to believe an unknown group is the team's.
   */
  by?: string;
  /** Telegram says the bot left the group or was removed from it. */
  left?: true;
  message?: InboundMessage;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isWhole = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

function groupOf(chat: unknown): FoundChat | undefined {
  if (!isRecord(chat)) return undefined;
  const { id, type } = chat;
  if ((type !== "group" && type !== "supergroup") || !isWhole(id)) return undefined;
  const title = cleanRemote(chat.title, MAX_CHAT_TITLE);
  return title === "" ? undefined : { id: String(id), title, type };
}

type Span = { offset: number; length: number };

const ENTITY_SHAPE: Record<Entity["type"], RegExp | null> = {
  mention: /^@[A-Za-z0-9_]{1,32}$/,
  hashtag: /^#[^\s#@]{1,64}$/,
  // Any words: a person with no username, named by a link to their profile.
  text_mention: null,
};

const overlap = (a: Span, b: Span) =>
  a.offset < b.offset + b.length && b.offset < a.offset + a.length;

/**
 * The marks that are kept, in the order they came. One that shares any of its
 * stretch with a mark already kept is dropped, a repeat of the same mark
 * included: Telegram's own never overlap, so one that does was made by hand,
 * and taking the same stretch out of the text twice would eat the title.
 */
function entitiesOf(raw: unknown, text: string): Entity[] {
  if (!Array.isArray(raw)) return [];
  const kept: Entity[] = [];
  for (const entity of raw.slice(0, MAX_ENTITIES)) {
    if (!isRecord(entity)) continue;
    const { type, offset, length } = entity;
    if (type !== "mention" && type !== "text_mention" && type !== "hashtag") continue;
    if (!isWhole(offset) || !isWhole(length) || offset < 0 || length < 1) continue;
    if (offset + length > text.length) continue;
    const shape = ENTITY_SHAPE[type];
    if (shape !== null && !shape.test(text.slice(offset, offset + length))) continue;
    if (kept.some((one) => overlap(one, { offset, length }))) continue;
    kept.push({ type, offset, length });
  }
  return kept;
}

/**
 * Whether a message is somebody else's words passed on, or was written
 * through another bot. Neither is the sender asking for a task: a forwarded
 * "@bot assign …" would be acted on in the forwarder's name.
 */
function notTheirOwn(message: Record<string, unknown>): boolean {
  return (
    message.via_bot !== undefined ||
    message.is_automatic_forward === true ||
    Object.keys(message).some((key) => key.startsWith("forward_"))
  );
}

function messageOf(message: Record<string, unknown>, chatId: string): InboundMessage | undefined {
  const { from, message_id: messageId } = message;
  if (!isWhole(messageId) || !isRecord(from) || !isWhole(from.id) || from.is_bot === true) {
    return undefined;
  }
  if (notTheirOwn(message)) return undefined;
  const caption = typeof message.text !== "string";
  // A caption is read only when Telegram marked something in it.
  if (caption && !Array.isArray(message.caption_entities)) return undefined;
  const text = caption ? message.caption : message.text;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) return undefined;
  const username =
    typeof from.username === "string" && USERNAME.test(from.username) ? from.username : undefined;
  return {
    chatId,
    messageId,
    from: { id: String(from.id), ...(username === undefined ? null : { username }) },
    text,
    entities: entitiesOf(caption ? message.caption_entities : message.entities, text),
    caption,
  };
}

/**
 * What the bot uses of an update, or null when it is not one. Only a message
 * and the bot's own membership change are looked at; of each, only the group,
 * the username of whoever did it, whether the bot is now out of the group,
 * and (for a message) the sender's id, the text and where its mentions and
 * hashtags are. Nothing else is read, so nothing else can be kept.
 */
export function parseUpdate(json: unknown): InboundUpdate | null {
  if (!isRecord(json) || !isWhole(json.update_id) || json.update_id < 0) return null;
  const update: InboundUpdate = { updateId: json.update_id };
  const event = isRecord(json.message)
    ? json.message
    : isRecord(json.my_chat_member)
      ? json.my_chat_member
      : undefined;
  const chat = groupOf(event?.chat);
  if (chat === undefined) return update;
  // Seconds since 1970, as Telegram sends them. Without one its age cannot be
  // told, so nothing of the update is kept.
  const date = event?.date;
  if (!isWhole(date) || date <= 0 || date >= 1e11) return update;
  update.chat = chat;
  update.at = date * 1000;
  const by = actorOf(event);
  if (by !== undefined) update.by = by;
  if (!isRecord(json.message) && botIsGone(event)) update.left = true;
  if (isRecord(json.message)) {
    const message = messageOf(json.message, chat.id);
    if (message !== undefined) update.message = message;
  }
  return update;
}

// ── What was asked ──────────────────────────────────────────────────────────

/**
 * Which board a hashtag names: a company's own hashtags (its identity's, in
 * convex/lib/identity.ts) and its id, then "both" and "shared". Every company
 * the code knows, whether or not this OS is run for it, as before.
 */
export type Board = CompanyId | "both";
const BOARDS: Record<string, Board> = {
  ...Object.fromEntries(
    ALL_COMPANY_IDS.flatMap((id) => [...COMPANY_IDENTITY[id].hashtags, id].map((tag) => [tag, id] as const)),
  ),
  both: "both",
  shared: "both",
};

/** The boards' hashtags, as the help and a refusal list them. */
const BOARD_TAGS = `${hashtagOf("us")}, ${hashtagOf("kz")} or #both`;

export type TaskRequest = {
  kind: "task";
  /** What was typed after "@", as typed: not yet anybody. */
  assignee?: string;
  /** The person named has no Telegram username, so cannot be looked up. */
  noUsername?: true;
  /** The board a hashtag named; left out, the group's own rule decides. */
  board?: Board;
  /** Two different boards were named. */
  boardConflict?: true;
  title: string;
  due?: string;
  /** A date was written in the right form and is no day. */
  badDate?: true;
};
export type BotRequest = { kind: "help" } | TaskRequest;

/**
 * The text with some stretches taken out, each replaced by a space. From the
 * end backwards, and a stretch that reaches into one already taken out is
 * left alone: the same stretch given twice is taken out once.
 */
function without(text: string, spans: Span[]): string {
  let out = text;
  let from = text.length;
  for (const span of [...spans].sort((a, b) => b.offset - a.offset)) {
    if (span.offset + span.length > from) continue;
    out = `${out.slice(0, span.offset)} ${out.slice(span.offset + span.length)}`;
    from = span.offset;
  }
  return out;
}

/** Where the hashtags are: Telegram's own marks, or the text read for them where it sent none. */
function hashtagSpans(text: string, entities: Entity[]): Span[] {
  const marked = entities.filter((entity) => entity.type === "hashtag");
  if (marked.length > 0) return marked;
  return [...text.matchAll(/(?<=^|\s)#[A-Za-z0-9_]{1,64}(?=\s|$)/g)].map((match) => ({
    offset: match.index,
    length: match[0].length,
  }));
}

/** The boards named by hashtag, and where those hashtags are. Other hashtags are left alone. */
function boardsIn(text: string, entities: Entity[]) {
  const spans: Span[] = [];
  const named = new Set<Board>();
  for (const span of hashtagSpans(text, entities)) {
    const word = text.slice(span.offset + 1, span.offset + span.length).toLowerCase();
    // `hasOwn`: "#constructor" is a hashtag somebody may type.
    if (!Object.hasOwn(BOARDS, word)) continue;
    spans.push(span);
    named.add(BOARDS[word]!);
  }
  return { spans, named: [...named] };
}

// Words people put before the task itself when they talk to the bot ("assign
// task to @sam to call the clinic"). DELIBERATELY SMALL AND FIXED: this is a
// list, not an understanding of language, and nothing is guessed. A lead-in
// is removed only at the very start of the text before the person named and
// of the text after them, whatever its capitals. Anything this does not
// match is left exactly as it was typed.
export const LEAD_INS = [
  "assign task to",
  "assign a task to",
  "assign to",
  "new task for",
  "task for",
  "task to",
  "please",
  "pls",
  "задача для",
  "задачу для",
  "поставь задачу",
  "назначь задачу",
  "пожалуйста",
] as const;
/** A word left hanging once a lead-in is gone: "assign task to @sam to call …". */
const DANGLING = ["to", "чтобы"] as const;

const LEADING_MARKS = /^[\s:,;.\-–—]+/;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const BY_LENGTH = [...LEAD_INS].sort((x, y) => y.length - x.length);

/** `text` without `phrase` at its start, when it is there as whole words; else null. */
function dropStart(text: string, phrase: string): string | null {
  if (!text.toLowerCase().startsWith(phrase)) return null;
  const next = text.slice(phrase.length, phrase.length + 2);
  // "pls" is not the start of "plsql", nor "to" of "to-do".
  if (next !== "" && (WORD_CHARACTER.test(next[0]!) || next[0] === "-")) return null;
  return text.slice(phrase.length);
}

/** A stretch of text without the lead-ins at its start, and whether any was there. */
function dropLeadIns(text: string): { text: string; dropped: boolean } {
  let rest = text.replace(LEADING_MARKS, "");
  let dropped = false;
  for (;;) {
    const shorter = BY_LENGTH.map((phrase) => dropStart(rest, phrase)).find((cut) => cut !== null);
    if (shorter === undefined || shorter === null) return { text: rest, dropped };
    rest = shorter.replace(LEADING_MARKS, "");
    dropped = true;
  }
}

/**
 * The title out of what is left once the mentions, hashtags and command are
 * gone: `parts` are the text before the person named and the text after.
 * Each loses its lead-ins; if any was lost, a word left dangling at the start
 * goes too and the first letter is made a capital. With no lead-in the words
 * are kept as typed, capitals and all.
 */
export function titleFrom(parts: readonly string[]): string {
  // One line each, with nothing invisible in it.
  const tidied = parts.map((part) => dropLeadIns(cleanRemote(part, MAX_TEXT)));
  let title = tidied
    .map((part) => part.text)
    .filter((part) => part !== "")
    .join(" ")
    .replace(LEADING_MARKS, "");
  if (!tidied.some((part) => part.dropped)) return title;
  for (const word of DANGLING) {
    const cut = dropStart(title, word);
    if (cut !== null) title = cut.replace(LEADING_MARKS, "");
  }
  const [first = "", ...others] = Array.from(title);
  return first.toUpperCase() + others.join("");
}

/** A task from the text round the person named, or a request for help when no title is left. */
function taskFrom(
  parts: readonly string[],
  who: Pick<TaskRequest, "assignee" | "noUsername">,
  boards: Board[],
): BotRequest {
  // The date is read off the end before the title is tidied, so "by" is never taken for a word of it.
  const last = cleanRemote(parts.at(-1) ?? "", MAX_TEXT);
  let due: string | undefined;
  let badDate = false;
  const dated = /(?:^|\s)by\s+(\d{4}-\d{2}-\d{2})$/i.exec(last);
  if (dated !== null) {
    if (isCanonicalPeriodStart("day", dated[1]!)) due = dated[1]!;
    else badDate = true;
  }
  const title = titleFrom(
    dated === null ? parts : [...parts.slice(0, -1), last.slice(0, dated.index)],
  );
  if (title === "") return { kind: "help" };
  return {
    kind: "task",
    ...who,
    ...(boards.length === 1 ? { board: boards[0]! } : null),
    ...(boards.length > 1 ? { boardConflict: true as const } : null),
    title,
    ...(due === undefined ? null : { due }),
    ...(badDate ? { badDate: true as const } : null),
  };
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What a message asks of the bot, or null when it asks nothing.
 *
 *   /help, /start              the help reply
 *   /task [@person] Title      a task (also /task@bot …)
 *   … @bot … [@person] Title   a task: the bot mentioned anywhere in the text
 *
 * In both, a company's hashtag (`#startup`, `#globex`) or `#both` names the board and a trailing
 * `by YYYY-MM-DD` the due date. A mention is one Telegram marked as such
 * (`entities`), never a string that happens to hold the bot's name.
 */
export function parseRequest(
  message: Pick<InboundMessage, "text" | "entities" | "caption">,
  botUsername: string | undefined,
): BotRequest | null {
  const { text, entities } = message;
  const boards = boardsIn(text, entities);

  if (text.startsWith("/")) {
    if (message.caption) return null;
    const command = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s([\s\S]*))?$/.exec(
      without(text, boards.spans),
    );
    if (command === null) return null;
    const [, name, addressed, tail = ""] = command;
    if (addressed !== undefined && (botUsername === undefined || !sameName(addressed, botUsername))) {
      return null;
    }
    const verb = name!.toLowerCase();
    if (verb === "help" || verb === "start") return { kind: "help" };
    if (verb !== "task") return null;
    // The person is the first thing after the command, lead-ins aside.
    const person = /^([^@]*)@(\S*)([\s\S]*)$/.exec(tail);
    return person === null || dropLeadIns(cleanRemote(person[1]!, MAX_TEXT)).text !== ""
      ? taskFrom([tail], {}, boards.named)
      : taskFrom([person[1]!, person[3]!], { assignee: person[2]! }, boards.named);
  }

  if (botUsername === undefined) return null;
  const named = entities
    .filter((entity) => entity.type !== "hashtag")
    .sort((a, b) => a.offset - b.offset);
  const nameOf = (entity: Entity) => text.slice(entity.offset + 1, entity.offset + entity.length);
  const isBot = (entity: Entity) =>
    entity.type === "mention" && sameName(nameOf(entity), botUsername);
  const toBot = named.filter(isBot);
  if (toBot.length === 0) return null;
  // The first other person named is who the task is for.
  const person = named.find((entity) => !isBot(entity));
  // The text before the person named and the text after, each without the
  // bot's name and the board's hashtag.
  const gone = [...toBot, ...boards.spans];
  const cuts = person === undefined ? [text.length] : [person.offset, person.offset + person.length];
  const before = without(
    text.slice(0, cuts[0]),
    gone.filter((span) => span.offset < cuts[0]!),
  );
  const after = without(
    text.slice(cuts.at(-1)),
    gone
      .filter((span) => span.offset >= cuts.at(-1)!)
      .map((span) => ({ offset: span.offset - cuts.at(-1)!, length: span.length })),
  );
  return taskFrom(
    person === undefined ? [before] : [before, after],
    person === undefined
      ? {}
      : person.type === "mention"
        ? { assignee: nameOf(person) }
        : { noUsername: true },
    boards.named,
  );
}

// ── What the bot answers ────────────────────────────────────────────────────

// Sent as HTML. The examples are in <code>, which Telegram does not read for
// mentions or hashtags, so the help pings nobody.
export function HELP_REPLY(botUsername: string | undefined): string {
  const bot = botUsername !== undefined && USERNAME.test(botUsername) ? botUsername : undefined;
  const example = bot === undefined ? "/task" : `@${bot}`;
  return [
    `<b>Add a task to the ${PRODUCT.name} board</b>`,
    ...(bot === undefined ? [] : [`<code>@${bot} @username Title of the task</code>`]),
    "<code>/task @username Title of the task</code>",
    "Leave the person out for a task that is nobody's yet. A due date goes at the end, written <code>by 2026-10-20</code>; no other way of writing a date is read.",
    `The task goes on this group's board. For another, add <code>${hashtagOf("us")}</code>, <code>${hashtagOf("kz")}</code> or <code>#both</code>, as in <code>${example} @username ${hashtagOf("kz")} Title of the task</code>.`,
  ].join("\n");
}

export const REPLIES = {
  strangers: `Only teammates in ${PRODUCT.name} can add tasks here.`,
  limit: "That is enough tasks from Telegram for now. Add this one on the board.",
  badDate: "I could not read that date. Write it as by YYYY-MM-DD. Nothing was added.",
  titleTooLong: `That title is too long (${MAX_TITLE_LENGTH} characters at most). Nothing was added.`,
  noUsername:
    "That person has no Telegram username, so I cannot give them a task from here. Nothing was added.",
  oneBoard: `Name one board: ${BOARD_TAGS}. Nothing was added.`,
  notYourBoard: "You are not on that company's board. Nothing was added.",
} as const;

/** A name as it was typed, made safe to say back: short, escaped, and pinging nobody. */
const said = (typed: string) => `＠${plain(Array.from(typed).slice(0, 40).join(""))}`;

/**
 * The one answer for a person a task cannot be given to, whatever the reason:
 * nobody has that username, the sender shares no company with them, or they
 * are not on the task's company. The group is told nothing that would let it
 * work out which, since not everyone in it is on both companies. The name is
 * said back as it was typed, never as it is on record.
 */
export const unknownAssigneeReply = (typed: string) =>
  `I do not know ${said(typed)} as a teammate on this board. Nothing was added.`;

/**
 * For a sender whose untagged task would land on a company they are not on:
 * where it would go and the hashtag of their own. In <code>, so it is not a
 * hashtag in the reply.
 */
export const untaggedRefusal = (goesTo: CompanyId, own: CompanyId) =>
  `With no hashtag a task from this group goes to ${COMPANIES[goesTo].name}'s board, which you are not on. Add <code>${hashtagOf(own)}</code> to put it on ${COMPANIES[own].name}'s. Nothing was added.`;

/** "Startup's board", "Globex's board" or "both boards". */
export const boardWords = (company: CompanyId | undefined) =>
  company === undefined ? "both boards" : `${COMPANIES[company].name}'s board`;

/**
 * The one confirmation: which board, who for (their real "@", so Telegram
 * notifies them once, here), the title made safe, the due date and the link.
 */
export function addedReply(task: {
  /** The assignee's username as it is on record. */
  username: string | undefined;
  title: string;
  company: CompanyId | undefined;
  due: string | undefined;
  boardUrl: string | undefined;
}): string {
  const who =
    task.username !== undefined && USERNAME.test(task.username) ? ` for @${task.username}` : "";
  const due = dayInWords(task.due);
  return [
    `<b>Added</b> to ${boardWords(task.company)}${who}: ${plain(task.title)}`,
    ...(due === undefined ? [] : [`due ${due}`]),
    ...(task.boardUrl === undefined ? [] : [`<a href="${task.boardUrl}">Open the board</a>`]),
  ].join(" · ");
}

/**
 * The line added to the confirmation of a task near an open card
 * (`nearTasks`): its title, as typed text, so the group can delete one. The
 * task is added all the same: a person is never refused for it.
 */
export const nearDuplicateLine = (title: string) => `Possible duplicate of: ${plain(title)}`;

/**
 * The line added to the confirmation of the first task someone adds: their
 * username has just been tied to the Telegram account that wrote, and the
 * group is told, so that a wrong link is seen at once. Nothing for a username
 * that is not one.
 */
export const firstTaskLine = (username: string) =>
  USERNAME.test(username)
    ? `First task from @${username}: this Telegram account is now linked to them in ${PRODUCT.name}.`
    : undefined;

// ── What can go wrong while acting on an update, in fixed words ─────────────

// The only sentences ever stored or shown about an update that was not acted
// on as asked. What was thrown may hold what somebody typed, or an address
// with the bot's token in it, so it is never kept: one of these is chosen.
export const COMMAND_FAILURES = {
  update: "An update from Telegram could not be acted on.",
  replyAfterTask: "A task was added but the reply could not be posted.",
  reply: "The bot's reply could not be posted.",
} as const;
export type CommandFailure = keyof typeof COMMAND_FAILURES;

/** A failure's fixed sentence. Whatever is handed in, only a fixed sentence comes out. */
export const commandFailureOf = (failure: string): string =>
  Object.hasOwn(COMMAND_FAILURES, failure)
    ? COMMAND_FAILURES[failure as CommandFailure]
    : COMMAND_FAILURES.update;

// ── What Telegram says about the bot ────────────────────────────────────────

/** The bot's own username out of an answer to `getMe`, or nothing if it is not one. */
export function botUsernameOf(json: unknown): string | undefined {
  const result = isRecord(json) ? json.result : undefined;
  const username = isRecord(result) ? result.username : undefined;
  return typeof username === "string" && USERNAME.test(username) ? username : undefined;
}

export type CommandsState = {
  /** Whether the bot's updates come here: on, off, or sent to some other address. */
  state: "on" | "off" | "elsewhere";
  /** Updates Telegram is still holding. */
  pending: number;
  /** When Telegram last failed to deliver one. What it said about it is not kept. */
  deliveryErrorAt?: number;
};

/**
 * An answer to `getWebhookInfo`, as much as is kept: whether the address is
 * this deployment's (the address itself is not kept), how many updates wait
 * and when one last failed. Nothing for an answer in another shape.
 */
export function commandsStateOf(json: unknown, ourUrl: string | undefined): CommandsState | undefined {
  const result = isRecord(json) ? json.result : undefined;
  if (!isRecord(result)) return undefined;
  const url = typeof result.url === "string" ? result.url : "";
  const pending = result.pending_update_count;
  const failedAt = result.last_error_date;
  return {
    state: url === "" ? "off" : url === ourUrl ? "on" : "elsewhere",
    pending: isWhole(pending) && pending >= 0 ? pending : 0,
    ...(isWhole(failedAt) && failedAt > 0 && failedAt < 1e11 ? { deliveryErrorAt: failedAt * 1000 } : null),
  };
}
