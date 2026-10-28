import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { isOwnerEmail, memberByEmail } from "./authOwner";
import { COMPANIES, companyIds, type CompanyId } from "./lib/company";
import {
  NOT_ALLOWED,
  memberMutation,
  memberQuery,
  ownerMutation,
  requireCompany,
  type Member,
} from "./lib/owner";
import { may } from "./lib/roles";
import { nameOf, teamDirectory } from "./lib/teamDirectory";
import {
  HOURLY_LIMIT,
  TELEGRAM_FAILURES,
  TEST_MESSAGE,
  assignmentMessage,
  boardUrlOf,
  handoffMessage,
  handoffsUrlOf,
  chatFor,
  chatsFromUpdates,
  cleanTelegram,
  sameTelegram,
  type Chat,
  type FoundChat,
  type TelegramFailure,
} from "./lib/telegramMessage";
import {
  botUsernameOf,
  commandsStateOf,
  webhookUrlOf,
  type CommandsState,
} from "./lib/telegramCommand";
import { figureAreasOf } from "./lib/handoffFigures";
import { askTelegram, sendMessage, type TelegramResult } from "./lib/telegramRequest";
import { companyValidator } from "./schema";

// The Telegram bot: when a task is given to someone on the board, a message in
// that company's group that tags them. Nothing else is ever posted, and
// nothing is read from Telegram but the list of groups the bot has seen.
//
// The bot's token is the TELEGRAM_BOT_TOKEN variable, set by the owner. It is
// read here, inside the actions, and goes nowhere else: not into a table, a
// function's arguments or result, a log line or an error. Unset, the feature
// is off and nothing is scheduled. Every request's address holds the token,
// so a request's failure is kept only as one of the fixed sentences in
// convex/lib/telegramMessage.ts.
//
// The task's own write never waits for Telegram and cannot fail because of
// it: `tasks.create` and `tasks.update` only schedule `notify`, with ids, and
// `notify` swallows whatever goes wrong after writing down which sentence.

const HOUR_MS = 60 * 60 * 1000;

export const NO_TOKEN = "Set TELEGRAM_BOT_TOKEN on the Convex deployment first.";
export const PICK_FROM_LIST = "Pick a group from the list.";
/** Said to anyone but the owner who names a company's group, to pick it, clear it or send it as it is. */
export const GROUPS_ARE_THE_OWNERS = "The owner picks the groups.";

/** The bot's token, or null when the variable is unset or blank. Never at module scope. */
export function botToken(): string | null {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  return token === "" ? null : token;
}

/** A failure's fixed sentence. Whatever is handed in, only a fixed sentence comes out. */
export function sentenceOf(failure: string): string {
  return Object.hasOwn(TELEGRAM_FAILURES, failure)
    ? TELEGRAM_FAILURES[failure as TelegramFailure]
    : TELEGRAM_FAILURES.other;
}

export const settingsRow = (ctx: QueryCtx) => ctx.db.query("telegramSettings").first();

// ── Who may see and change what ─────────────────────────────────────────────
//
// The settings are one row for the whole deployment, and it holds both
// companies' groups. They are the `settings` area's: the owner's, and a
// teammate's the owner ticked it for. For a teammate the row is split in two:
//
// - A company's group is that company's. It is shown to and tested by the
//   people on that company, and nobody else. Which group it is, is the
//   owner's alone to say (`save`), and so is the list it is picked from
//   (`findChats`, `found`): a holder is sent neither.
// - Everything else is shared by both companies: whether messages are on,
//   where an untagged task goes, and whether the bot takes commands (the
//   owner's switch, `commandsWanted`, included). Any holder reads it; only
//   one who is on both companies changes it, since a change lands on a
//   company they are not on otherwise.
// - What goes with a group goes with its company: how many are in it and
//   whether the bot has left it.
// - The last failure while acting on an update is the deployment's and is in
//   fixed words that name no group and nobody: any holder reads it.
// - Who is linked to a Telegram account is about people: a caller is told of
//   those who share a company with them, by name. A teammate's username is
//   sent by `team.list` alone and never from here, to the owner included.
//
// None of this is how a group comes to be listed. That rule (someone with a
// username on record wrote in it or added the bot) goes by everyone on
// record, whoever is looking: `usernamesOnRecord` takes no caller.
//
// The owner is on both. The token is still shown to nobody.

/** Whether a caller is on every company: what changing a shared setting takes. */
export function onBothCompanies(member: Member): boolean {
  return companyIds().every((company) => member.companies.includes(company));
}

/** Refuse a change to what both companies share, in the words of a missing permission. */
export function requireBothCompanies(member: Member) {
  if (!onBothCompanies(member)) throw new ConvexError(NOT_ALLOWED);
}

const chatOf = (row: Doc<"telegramSettings"> | null, company: CompanyId) =>
  company === "us" ? row?.chatUs : row?.chatKz;

/**
 * The groups a caller is sent and may pick from: every group the bot has
 * seen, less any that is another company's pick and not one of their own.
 */
function foundFor(member: Member, row: Doc<"telegramSettings"> | null) {
  const mine = new Set<string>();
  const theirs = new Set<string>();
  for (const company of companyIds()) {
    const chat = chatOf(row, company);
    if (chat !== undefined) (member.companies.includes(company) ? mine : theirs).add(chat.id);
  }
  return row?.found?.filter((chat) => mine.has(chat.id) || !theirs.has(chat.id));
}

/** Change the one settings row, making it (switched off) if there is none yet. */
export async function writeSettings(ctx: MutationCtx, patch: Partial<Doc<"telegramSettings">>) {
  const row = await settingsRow(ctx);
  if (row === null) await ctx.db.insert("telegramSettings", { enabled: false, ...patch });
  else await ctx.db.patch(row._id, patch);
}

type Settings = Doc<"telegramSettings">;

/** The groups picked in settings: one, two, or the same one twice. */
export const pickedChats = (row: Settings | null): Chat[] =>
  [row?.chatUs, row?.chatKz].filter((chat) => chat !== undefined);

/**
 * Every Telegram username on record, lower-cased: each teammate's and each
 * owner's own. A group is believed to be the team's only when one of these
 * wrote in it or added the bot to it.
 */
export async function usernamesOnRecord(ctx: QueryCtx, row: Settings | null): Promise<Set<string>> {
  const names = new Set<string>();
  // At most MAX_MEMBERS rows: `team.add` refuses more.
  for (const member of await ctx.db.query("members").collect()) {
    if (member.telegram !== undefined) names.add(member.telegram.toLowerCase());
  }
  for (const owner of row?.owners ?? []) names.add(owner.telegram.toLowerCase());
  return names;
}

/** Said when a username is typed for one record and is another's. Not whose. */
export const TELEGRAM_TAKEN = "That Telegram username is already on another record.";

/**
 * Refuse a username that is already on another record: a teammate's row or an
 * owner's own entry, whatever its capitals. A username on two records is
 * nobody's to the bot (`named` in convex/telegramInbound.ts), so giving
 * someone another person's would lock that person out of adding tasks. The
 * record being written is left out: it keeps its own.
 */
export async function requireFreeUsername(
  ctx: QueryCtx,
  username: string | undefined,
  own: { member?: Id<"members">; owner?: Id<"users"> },
) {
  if (username === undefined) return;
  // At most MAX_MEMBERS rows: `team.add` refuses more.
  for (const member of await ctx.db.query("members").collect()) {
    if (member._id === own.member || member.telegram === undefined) continue;
    if (sameTelegram(member.telegram, username)) throw new ConvexError(TELEGRAM_TAKEN);
  }
  for (const entry of (await settingsRow(ctx))?.owners ?? []) {
    if (entry.userId === own.owner) continue;
    if (sameTelegram(entry.telegram, username)) throw new ConvexError(TELEGRAM_TAKEN);
  }
}

/** How many links and resets the settings row remembers. */
export const MAX_LINK_LOG = 20;
type LinkEvent = NonNullable<Settings["log"]>[number];

/** The log with one more event at its head, the oldest dropped past twenty. */
export const linkLogWith = (row: Settings | null, event: LinkEvent): LinkEvent[] =>
  [event, ...(row?.log ?? [])].slice(0, MAX_LINK_LOG);

// ── The hook the board calls ────────────────────────────────────────────────

/**
 * Called by `tasks.create` and `tasks.update` once the task is written. It
 * schedules the message when the task now has an assignee, that changed in
 * this call, and it is not the caller's own. It does nothing else and never
 * throws: the task is saved whatever becomes of the message.
 */
export async function announceAssignment(
  ctx: MutationCtx,
  change: {
    taskId: Id<"tasks">;
    /** The assignee before this call and after it, lower-cased addresses. */
    before: string | undefined;
    after: string | undefined;
    actor: Pick<Doc<"users">, "_id" | "email">;
  },
): Promise<void> {
  try {
    if (change.after === undefined || change.after === change.before) return;
    if (change.actor.email?.trim().toLowerCase() === change.after) return;
    if (botToken() === null) return;
    // Ids only: a scheduled function's arguments are stored.
    await ctx.scheduler.runAfter(0, internal.telegram.notify, {
      taskId: change.taskId,
      actorId: change.actor._id,
    });
  } catch {
    // Never the task's problem, and what was thrown is not ours to repeat.
  }
}

// ── The hourly limit ────────────────────────────────────────────────────────

/**
 * Count one more message to a group, unless it has had its thirty this hour.
 * Rows older than an hour are deleted on the way, so the table stays small.
 */
async function reserve(ctx: MutationCtx, chat: string, now: number): Promise<boolean> {
  const since = now - HOUR_MS;
  const old = await ctx.db
    .query("telegramSends")
    .withIndex("by_chat_and_at", (q) => q.eq("chat", chat).lte("at", since))
    .take(100);
  for (const row of old) await ctx.db.delete(row._id);
  const recent = await ctx.db
    .query("telegramSends")
    .withIndex("by_chat_and_at", (q) => q.eq("chat", chat).gt("at", since))
    .take(HOURLY_LIMIT);
  if (recent.length >= HOURLY_LIMIT) return false;
  await ctx.db.insert("telegramSends", { chat, at: now });
  return true;
}

// ── A task's message ────────────────────────────────────────────────────────

/** The Telegram username on record for an address: a teammate's row, or an owner's own entry. */
async function usernameOf(
  ctx: QueryCtx,
  settings: Doc<"telegramSettings">,
  email: string,
): Promise<string | undefined> {
  if (!isOwnerEmail(email)) return (await memberByEmail(ctx.db, email))?.telegram;
  const users = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .collect();
  const ids = new Set<string>(users.map((user) => user._id));
  return settings.owners?.find((owner) => ids.has(owner.userId))?.telegram;
}

/**
 * Read the task and the people as they are now and say what to post and
 * where, or null for nothing: the feature is off, the task is gone or held by
 * nobody, it is the actor's own, its holder has left, no group is set for it,
 * or the group has had its thirty this hour (which is written down).
 */
export const prepare = internalMutation({
  args: { taskId: v.id("tasks"), actorId: v.id("users") },
  handler: async (ctx, args): Promise<{ chatId: string; text: string } | null> => {
    const settings = await settingsRow(ctx);
    if (settings === null || !settings.enabled) return null;
    const task = await ctx.db.get(args.taskId);
    if (task === null || task.assignee === undefined) return null;
    const actor = await ctx.db.get(args.actorId);
    if (actor?.email?.trim().toLowerCase() === task.assignee) return null;
    // Someone since removed is not announced to a group they may have left.
    if (!(await teamDirectory(ctx.db)).has(task.assignee)) return null;
    const chat = chatFor(task.company, { us: settings.chatUs, kz: settings.chatKz });
    if (chat === undefined) return null;

    const now = Date.now();
    if (!(await reserve(ctx, chat.id, now))) {
      await ctx.db.patch(settings._id, { lastError: TELEGRAM_FAILURES.flood, lastErrorAt: now });
      return null;
    }
    return {
      chatId: chat.id,
      text: assignmentMessage({
        username: await usernameOf(ctx, settings, task.assignee),
        name: (await nameOf(ctx.db, task.assignee)) ?? undefined,
        title: task.title,
        company: task.company,
        due: task.due,
        actor: actor?.name ?? undefined,
        boardUrl: boardUrlOf(process.env.SITE_URL),
      }),
    };
  },
});

/** Write down how the latest task message went: sent, or which fixed sentence. */
export const record = internalMutation({
  args: { failure: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await writeSettings(
      ctx,
      args.failure === undefined
        ? { lastSentAt: now, lastError: undefined, lastErrorAt: undefined }
        : { lastError: sentenceOf(args.failure), lastErrorAt: now },
    );
    return null;
  },
});

/** Post the message for a task that was just given to someone. Never throws. */
export const notify = internalAction({
  args: { taskId: v.id("tasks"), actorId: v.id("users") },
  handler: async (ctx, args) => {
    try {
      const token = botToken();
      if (token === null) return null;
      const message = await ctx.runMutation(internal.telegram.prepare, args);
      if (message === null) return null;
      const result = await sendMessage(token, message.chatId, message.text);
      await ctx.runMutation(internal.telegram.record, result.ok ? {} : { failure: result.failure });
    } catch {
      // Whatever it was, it is not passed on and not logged: it may quote the
      // request's address. One try to say that something went wrong.
      try {
        await ctx.runMutation(internal.telegram.record, { failure: "other" });
      } catch {
        // Nothing more to do.
      }
    }
    return null;
  },
});

// ── A handoff's message (convex/handoffs.ts) ────────────────────────────────

/**
 * Read the handoff as it is now and say what to post and where, or null: the
 * feature is off, it is gone, no longer open or to a person, the person has
 * left, no group is set for its company, or the group has had its thirty this
 * hour (which is written down). Title, summary and the bot; never an address.
 */
export const prepareHandoff = internalMutation({
  args: { handoffId: v.id("handoffs") },
  handler: async (ctx, args): Promise<{ chatId: string; text: string } | null> => {
    const settings = await settingsRow(ctx);
    if (settings === null || !settings.enabled) return null;
    const row = await ctx.db.get(args.handoffId);
    if (row === null || row.toKind !== "person" || row.status !== "open") return null;
    if (!(await teamDirectory(ctx.db)).has(row.to)) return null;
    const chat = chatFor(row.company, { us: settings.chatUs, kz: settings.chatKz });
    if (chat === undefined) return null;
    const now = Date.now();
    if (!(await reserve(ctx, chat.id, now))) {
      await ctx.db.patch(settings._id, { lastError: TELEGRAM_FAILURES.flood, lastErrorAt: now });
      return null;
    }
    // Everyone on the company is in its group. A bot that reads the company's
    // figures may have written them into the title or summary: then the group
    // is told who it is for and from which bot, and the words stay on
    // /handoffs, for the person and those who hold the figures' pages.
    const withheld = (await figureAreasOf(ctx, row.from, row.fromKind)).length > 0;
    return {
      chatId: chat.id,
      text: handoffMessage({
        username: await usernameOf(ctx, settings, row.to),
        name: (await nameOf(ctx.db, row.to)) ?? undefined,
        title: withheld ? null : row.title,
        summary: withheld ? "" : row.summary,
        company: row.company,
        bot: row.from,
        url: handoffsUrlOf(process.env.SITE_URL),
      }),
    };
  },
});

/** Post the message for a handoff a bot just made to a person. Never throws. */
export const notifyHandoff = internalAction({
  args: { handoffId: v.id("handoffs") },
  handler: async (ctx, args) => {
    try {
      const token = botToken();
      if (token === null) return null;
      const message = await ctx.runMutation(internal.telegram.prepareHandoff, args);
      if (message === null) return null;
      const result = await sendMessage(token, message.chatId, message.text);
      await ctx.runMutation(internal.telegram.record, result.ok ? {} : { failure: result.failure });
    } catch {
      // As for a task: nothing thrown is passed on or logged.
      try {
        await ctx.runMutation(internal.telegram.record, { failure: "other" });
      } catch {
        // Nothing more to do.
      }
    }
    return null;
  },
});

// ── What the settings page reads and writes ─────────────────────────────────

/** A picked group as the page is sent it: `left` only when the bot is known to be out of it. */
function pickedOf(chat: Chat | undefined) {
  if (chat === undefined) return null;
  return {
    id: chat.id,
    title: chat.title,
    ...(chat.members === undefined ? null : { members: chat.members }),
    ...(chat.leftAt === undefined ? null : { left: true as const }),
  };
}

/**
 * Where the bot posts and how it is doing. Says whether the token is set,
 * never what it is. A caller is sent their own companies' groups only (see
 * "Who may see and change what" above).
 */
export const settings = memberQuery("settings")({
  args: {},
  handler: async (ctx) => {
    const row = await settingsRow(ctx);
    const on = (company: CompanyId) => ctx.member.companies.includes(company);
    // At most MAX_MEMBERS rows: `team.add` refuses more. Counted among the
    // people on the caller's companies: the rest are not theirs to hear of.
    const everyone = await ctx.db.query("members").collect();
    const shares = (member: Doc<"members">) =>
      member.companies.some((company) => ctx.member.companies.includes(company));
    const team = everyone.filter(shares);
    // The groups the caller is sent, their own companies' picks first: those
    // are the ones to tell from a lookalike.
    const found = foundFor(ctx.member, row);
    const picked = companyIds().filter(on)
      .map((company) => chatOf(row, company)?.id)
      .filter((id) => id !== undefined);
    const owner = may(ctx.member, "admin");
    const mine = owner
      ? row?.owners?.find((entry) => entry.userId === ctx.member.user._id)
      : undefined;
    // Who was linked or reset, among the people the caller shares a company
    // with, each by the name they signed in with. Never a username: a
    // teammate's is read through `team.list` alone.
    const log = [];
    for (const entry of row?.log ?? []) {
      if (entry.owner !== undefined) {
        // An owner is on both companies: everyone here shares one with them.
        const user = await ctx.db.get(entry.owner);
        log.push({ event: entry.event, at: entry.at, name: user?.name ?? null, gone: false });
        continue;
      }
      const member = everyone.find((one) => one._id === entry.member);
      // Someone since removed has no company left to share: the owner's alone to hear of.
      if (!owner && (member === undefined || !shares(member))) continue;
      log.push({
        event: entry.event,
        at: entry.at,
        name: member === undefined ? null : await nameOf(ctx.db, member.email),
        gone: member === undefined,
      });
    }
    return {
      tokenSet: botToken() !== null,
      /** Whether SITE_URL gives the message a link to the board. */
      siteSet: boardUrlOf(process.env.SITE_URL) !== undefined,
      enabled: row?.enabled ?? false,
      /**
       * A company the caller is not on reads as null, picked or not: its
       * group, how many are in it and whether the bot has left it are that
       * company's.
       */
      chats: {
        us: on("us") ? pickedOf(row?.chatUs) : null,
        kz: on("kz") ? pickedOf(row?.chatKz) : null,
      },
      /** Whether the caller may change what both companies share: they are on both. */
      canChangeShared: onBothCompanies(ctx.member),
      /**
       * An owner's own username: an owner has no row on the team page. A
       * teammate's is on their row there, and is not read here.
       */
      mine: mine?.telegram ?? null,
      /** Whether a Telegram account is tied to it yet, and since when. Never which account. */
      mineLinked: mine?.telegramUserId !== undefined,
      mineLinkedAt: mine?.telegramBoundAt ?? null,
      /**
       * Each teammate who has a username on record and shares a company with
       * the caller: whether it is linked to a Telegram account yet, and since
       * when. By the name they signed in with (null until they have), never
       * by the username, which this function sends for no teammate.
       */
      people: await Promise.all(
        team
          .filter((member) => member.telegram !== undefined && !isOwnerEmail(member.email))
          .map(async (member) => ({
            id: member._id,
            name: await nameOf(ctx.db, member.email),
            linked: member.telegramUserId !== undefined,
            linkedAt: member.telegramBoundAt ?? null,
          })),
      ),
      /**
       * The last links and resets, among the people who share a company with
       * the caller, each by name. `gone` is someone since removed, whom only
       * the owner is told of.
       */
      log,
      /** The bot's own username, once Telegram has been asked: what people type to address it. */
      botUsername: row?.botUsername ?? null,
      /** Where a task with no board hashtag goes, for a group that serves both companies. */
      untagged: row?.untaggedBoard ?? ("kz" as const),
      /**
       * Whether people can add tasks from the group: `wanted` is the owner's
       * own switch, which the webhook goes by; `state` is the webhook as
       * Telegram last said. They can differ, and the page says when they do.
       */
      commands: {
        wanted: row?.commandsWanted === true,
        /**
         * The last thing that went wrong while acting on an update, in fixed
         * words, and when. It is the deployment's, not a company's, and says
         * nothing of which group or who: any holder of the area is sent it.
         */
        failure: row?.commandFailure?.what ?? null,
        failureAt: row?.commandFailure?.at ?? null,
        state: row?.commands?.state ?? ("unknown" as const),
        pending: row?.commands?.pending ?? null,
        deliveryError:
          row?.commands?.deliveryErrorAt === undefined ? null : TELEGRAM_FAILURES.delivery,
        deliveryErrorAt: row?.commands?.deliveryErrorAt ?? null,
        checkedAt: row?.commands?.checkedAt ?? null,
        working: row?.commandsWorkingSince !== undefined,
        error: row?.commandsError ?? null,
      },
      /** Whether the caller picks the groups: the owner, and nobody else. */
      canPickGroups: owner,
      /**
       * The groups the bot has seen, the picked ones first, and how the last
       * search went: the owner's alone. Whoever reads the list can tell which
       * groups exist, and whoever picks from it decides where a company's
       * tasks are announced.
       */
      found:
        !owner || found === undefined
          ? null
          : [
              ...found.filter((chat) => picked.includes(chat.id)),
              ...found.filter((chat) => !picked.includes(chat.id)),
            ],
      finding: owner && row?.findingSince !== undefined,
      foundAt: owner ? (row?.foundAt ?? null) : null,
      findError: owner ? (row?.findError ?? null) : null,
      test: row?.test && on(row.test.company) ? { ...row.test, error: row.test.error ?? null } : null,
      lastSentAt: row?.lastSentAt ?? null,
      lastError: row?.lastError ?? null,
      lastErrorAt: row?.lastErrorAt ?? null,
      teammates: team.length,
      withoutUsername: team.filter((member) => member.telegram === undefined).length,
    };
  },
});

/**
 * Switch the messages on or off, say where an untagged task goes, and pick
 * each company's group. Anything left out is kept; a group is cleared with
 * null.
 *
 * Naming a setting is asking to change it, whatever value is sent, and each
 * is refused before anything is written:
 *
 * - A company's group is the owner's alone to pick or clear. Whoever picks it
 *   decides where that company's tasks are announced, with their titles and
 *   the assignees' tags; a holder of the area could otherwise send them to a
 *   group of their choosing, or claim another company's group first. The id
 *   is one "Find my groups" listed or one already picked, and the title is
 *   taken from there, never from the caller.
 * - The two settings both companies share take someone on both.
 */
export const save = memberMutation("settings")({
  args: {
    enabled: v.optional(v.boolean()),
    chatUs: v.optional(v.union(v.string(), v.null())),
    chatKz: v.optional(v.union(v.string(), v.null())),
    /** Where an untagged task goes when one group serves both; left out keeps it. */
    untagged: v.optional(v.union(companyValidator, v.literal("both"))),
  },
  handler: async (ctx, args) => {
    if (args.enabled !== undefined || args.untagged !== undefined) {
      requireBothCompanies(ctx.member);
    }
    if ((args.chatUs !== undefined || args.chatKz !== undefined) && !may(ctx.member, "admin")) {
      throw new ConvexError(GROUPS_ARE_THE_OWNERS);
    }

    const row = await settingsRow(ctx);
    // That the bot left a group is a fact about the group, whoever picked it.
    const was = pickedChats(row);
    // What the owner is sent, and nothing else: a group cannot be picked by
    // guessing its id.
    const known: Chat[] = [...(row?.found ?? []), ...was];
    const pick = (id: string | null): Chat | undefined => {
      if (id === null) return undefined;
      const chat = known.find((candidate) => candidate.id === id);
      if (chat === undefined) throw new ConvexError(PICK_FROM_LIST);
      // That the bot left it is a fact about the group, kept whichever company it is given to.
      const leftAt = was.find((candidate) => candidate.id === id)?.leftAt;
      return {
        id: chat.id,
        title: chat.title,
        ...(chat.members === undefined ? null : { members: chat.members }),
        ...(leftAt === undefined ? null : { leftAt }),
      };
    };
    // A key that is present and undefined clears the field, so only what was
    // named goes in the patch.
    await writeSettings(ctx, {
      ...(args.enabled === undefined ? null : { enabled: args.enabled }),
      ...(args.chatUs === undefined ? null : { chatUs: pick(args.chatUs) }),
      ...(args.chatKz === undefined ? null : { chatKz: pick(args.chatKz) }),
      ...(args.untagged === undefined ? null : { untaggedBoard: args.untagged }),
    });
    return null;
  },
});

/**
 * The owner's own Telegram username; blank clears it. The owner's alone, the
 * one function here that is: it is the owner's own record (an owner has no
 * row on the team page). A teammate's username is on their row there.
 */
export const setMine = ownerMutation({
  args: { telegram: v.string() },
  handler: async (ctx, args) => {
    const telegram = cleanTelegram(args.telegram);
    await requireFreeUsername(ctx, telegram, { owner: ctx.owner._id });
    const row = await settingsRow(ctx);
    const mine = row?.owners?.find((owner) => owner.userId === ctx.owner._id);
    const others = (row?.owners ?? []).filter((owner) => owner.userId !== ctx.owner._id);
    // The same username keeps the Telegram id bound to it; another starts afresh.
    const kept =
      telegram !== undefined && mine !== undefined && sameTelegram(mine.telegram, telegram)
        ? mine
        : undefined;
    await writeSettings(ctx, {
      owners:
        telegram === undefined
          ? others
          : [
              ...others,
              {
                userId: ctx.owner._id,
                telegram,
                ...(kept?.telegramUserId === undefined
                  ? null
                  : { telegramUserId: kept.telegramUserId }),
                ...(kept?.telegramBoundAt === undefined
                  ? null
                  : { telegramBoundAt: kept.telegramBoundAt }),
              },
            ],
    });
    return null;
  },
});

/**
 * Forget which Telegram account is tied to the caller's own username, so the
 * next task from that username links afresh (and says so in the group). The
 * owner's alone, as `setMine` is: it is the owner's own record. For a
 * teammate's, `team.resetTelegram`.
 */
export const resetMine = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const row = await settingsRow(ctx);
    const mine = row?.owners?.find((owner) => owner.userId === ctx.owner._id);
    if (row === null || mine?.telegramUserId === undefined) return null;
    await ctx.db.patch(row._id, {
      owners: (row.owners ?? []).map((owner) =>
        owner.userId === ctx.owner._id ? { userId: owner.userId, telegram: owner.telegram } : owner,
      ),
      log: linkLogWith(row, { event: "reset", at: Date.now(), owner: ctx.owner._id }),
    });
    return null;
  },
});

// ── Find my groups ──────────────────────────────────────────────────────────

/**
 * Ask Telegram which groups the bot has recently seen. It runs in the
 * background and its answer arrives through `settings`. The owner's alone: it
 * fills the list the owner picks a company's group from, and nobody else is
 * sent that list.
 */
export const findChats = ownerMutation({
  args: {},
  handler: async (ctx) => {
    if (botToken() === null) throw new ConvexError(NO_TOKEN);
    await writeSettings(ctx, { findingSince: Date.now(), findError: undefined });
    await ctx.scheduler.runAfter(0, internal.telegram.readChats, {});
    return null;
  },
});

/** Store what "Find my groups" found, or why it found nothing; a failure keeps the last list. */
export const foundChats = internalMutation({
  args: {
    chats: v.optional(
      v.array(
        v.object({
          id: v.string(),
          title: v.string(),
          type: v.union(v.literal("group"), v.literal("supergroup")),
        }),
      ),
    ),
    failure: v.optional(v.string()),
    /** The search is over and the stored list stands: the groups arrive by webhook. */
    keep: v.optional(v.boolean()),
  },
  /** The ids of the groups now on offer (found or picked), for their members to be counted. */
  handler: async (ctx, args): Promise<string[]> => {
    const row = await settingsRow(ctx);
    const offered = (found: readonly FoundChat[]) => [
      ...new Set([...found, ...pickedChats(row)].map((chat) => chat.id)),
    ];
    if (args.keep === true && args.failure === undefined) {
      await writeSettings(ctx, {
        findingSince: undefined,
        findError: undefined,
        found: row?.found ?? [],
        foundAt: row?.foundAt ?? Date.now(),
      });
      return offered(row?.found ?? []);
    }
    if (args.chats === undefined || args.failure !== undefined) {
      await writeSettings(ctx, {
        findingSince: undefined,
        findError: sentenceOf(args.failure ?? "other"),
      });
      return [];
    }
    // What was counted before is kept for a group that is still listed.
    const counted = new Map((row?.found ?? []).map((chat) => [chat.id, chat.members]));
    const found = args.chats.map((chat) => {
      const members = counted.get(chat.id);
      return members === undefined ? chat : { ...chat, members };
    });
    await writeSettings(ctx, {
      findingSince: undefined,
      findError: undefined,
      found,
      foundAt: Date.now(),
    });
    return offered(found);
  },
});

/** The usernames on record, for the action that reads `getUpdates`. Sent nowhere else. */
export const vouchers = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => [
    ...(await usernamesOnRecord(ctx, await settingsRow(ctx))),
  ],
});

/** Store how many are in each group, on the list of those found and on the picked ones. */
export const countedChats = internalMutation({
  args: { counts: v.array(v.object({ id: v.string(), members: v.number() })) },
  handler: async (ctx, { counts }) => {
    const row = await settingsRow(ctx);
    if (row === null) return null;
    const of = new Map(counts.map((count) => [count.id, count.members]));
    const counted = <T extends Chat>(chat: T): T =>
      of.has(chat.id) ? { ...chat, members: of.get(chat.id)! } : chat;
    await ctx.db.patch(row._id, {
      ...(row.found === undefined ? null : { found: row.found.map(counted) }),
      ...(row.chatUs === undefined ? null : { chatUs: counted(row.chatUs) }),
      ...(row.chatKz === undefined ? null : { chatKz: counted(row.chatKz) }),
    });
    return null;
  },
});

/**
 * Ask Telegram how many are in each group on offer, and store what it says.
 * Two groups can have one title; their ids and their sizes tell them apart.
 * A group that cannot be counted is left without a number, and nothing is
 * said of why.
 */
async function countMembers(
  ctx: ActionCtx,
  token: string,
  ids: readonly string[],
) {
  const counts = await Promise.all(
    ids.map(async (id) => {
      const answer = await askTelegram(token, "getChatMemberCount", { chat_id: id });
      const members =
        answer.ok && typeof answer.json === "object" && answer.json !== null
          ? (answer.json as { result?: unknown }).result
          : undefined;
      return typeof members === "number" && Number.isSafeInteger(members) && members > 0
        ? { id, members }
        : null;
    }),
  );
  const known = counts.filter((count) => count !== null);
  if (known.length > 0) await ctx.runMutation(internal.telegram.countedChats, { counts: known });
}

/**
 * Ask Telegram who the bot is and where its updates go. The two answers are
 * read for the bot's username and the webhook's state and for nothing else.
 */
export async function lookAtBot(
  token: string,
): Promise<
  | { ok: true; botUsername: string | undefined; commands: CommandsState | undefined }
  | { ok: false; failure: TelegramFailure }
> {
  const me = await askTelegram(token, "getMe");
  if (!me.ok) return me;
  const info: TelegramResult = await askTelegram(token, "getWebhookInfo");
  if (!info.ok) return info;
  return {
    ok: true,
    botUsername: botUsernameOf(me.json),
    commands: commandsStateOf(info.json, webhookUrlOf(process.env.CONVEX_SITE_URL)),
  };
}

/** Store what Telegram said of the bot, and how the owner's last change to its commands went. */
export const noteBot = internalMutation({
  args: {
    botUsername: v.optional(v.string()),
    commands: v.optional(
      v.object({
        state: v.union(v.literal("on"), v.literal("off"), v.literal("elsewhere")),
        pending: v.number(),
        deliveryErrorAt: v.optional(v.number()),
      }),
    ),
    /** Said only by the commands' own action: it is over, and this is how it went. */
    finished: v.optional(v.boolean()),
    failure: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await writeSettings(ctx, {
      ...(args.botUsername !== undefined && /^[A-Za-z0-9_]{5,32}$/.test(args.botUsername)
        ? { botUsername: args.botUsername }
        : null),
      ...(args.commands === undefined
        ? null
        : { commands: { ...args.commands, checkedAt: Date.now() } }),
      ...(args.finished === true
        ? {
            commandsWorkingSince: undefined,
            commandsError: args.failure === undefined ? undefined : sentenceOf(args.failure),
          }
        : null),
    });
    return null;
  },
});

/**
 * Read the groups the bot has seen: each one's id, title and type, then how
 * many are in each, and nothing else.
 */
export const readChats = internalAction({
  args: {},
  handler: async (ctx) => {
    try {
      const token = botToken() ?? "";
      // Who the bot is (the page tells people what to type) and where its updates go.
      const bot = await lookAtBot(token);
      if (!bot.ok) {
        await ctx.runMutation(internal.telegram.foundChats, { failure: bot.failure });
        return null;
      }
      await ctx.runMutation(internal.telegram.noteBot, {
        botUsername: bot.botUsername,
        commands: bot.commands,
      });
      // With a webhook set Telegram refuses `getUpdates`: the groups arrive
      // through the webhook instead, and the stored list is the answer.
      if (bot.commands !== undefined && bot.commands.state !== "off") {
        const offered = await ctx.runMutation(internal.telegram.foundChats, { keep: true });
        await countMembers(ctx, token, offered);
        return null;
      }
      const result = await askTelegram(token, "getUpdates");
      // Only a group someone on record wrote in or added the bot to.
      const vouched = new Set(await ctx.runQuery(internal.telegram.vouchers, {}));
      const offered = await ctx.runMutation(
        internal.telegram.foundChats,
        result.ok ? { chats: chatsFromUpdates(vouched, result.json) } : { failure: result.failure },
      );
      await countMembers(ctx, token, offered);
    } catch {
      try {
        await ctx.runMutation(internal.telegram.foundChats, { failure: "other" });
      } catch {
        // Nothing more to do.
      }
    }
    return null;
  },
});

// ── The test message ────────────────────────────────────────────────────────

/**
 * Post the fixed test sentence to a company's group, whether or not the
 * messages are switched on. It runs in the background and how it went
 * arrives through `settings`. Only for a company the caller is on.
 */
export const sendTest = memberMutation("settings")({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    if (botToken() === null) throw new ConvexError(NO_TOKEN);
    const row = await settingsRow(ctx);
    const chat = chatOf(row, args.company);
    if (chat === undefined) {
      throw new ConvexError(`Pick a group for ${COMPANIES[args.company].name} first.`);
    }
    await writeSettings(ctx, {
      test: { company: args.company, at: Date.now(), outcome: "sending" },
    });
    await ctx.scheduler.runAfter(0, internal.telegram.deliverTest, { company: args.company });
    return null;
  },
});

/** How a test message went: sent, or which fixed sentence. */
export const tested = internalMutation({
  args: { company: companyValidator, failure: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await writeSettings(ctx, {
      test: {
        company: args.company,
        at: Date.now(),
        ...(args.failure === undefined
          ? { outcome: "sent" as const }
          : { outcome: "failed" as const, error: sentenceOf(args.failure) }),
      },
    });
    return null;
  },
});

/** The group a test goes to, counted against its hour; null when it may not be sent. */
export const reserveTest = internalMutation({
  args: { company: companyValidator },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await settingsRow(ctx);
    const chat = args.company === "us" ? row?.chatUs : row?.chatKz;
    const failure: TelegramFailure | null =
      chat === undefined ? "chat" : (await reserve(ctx, chat.id, Date.now())) ? null : "flood";
    if (failure === null) return chat!.id;
    await writeSettings(ctx, {
      test: {
        company: args.company,
        at: Date.now(),
        outcome: "failed",
        error: TELEGRAM_FAILURES[failure],
      },
    });
    return null;
  },
});

export const deliverTest = internalAction({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    try {
      const chatId = await ctx.runMutation(internal.telegram.reserveTest, args);
      if (chatId === null) return null;
      const result = await sendMessage(botToken() ?? "", chatId, TEST_MESSAGE);
      await ctx.runMutation(
        internal.telegram.tested,
        result.ok ? args : { ...args, failure: result.failure },
      );
    } catch {
      try {
        await ctx.runMutation(internal.telegram.tested, { ...args, failure: "other" });
      } catch {
        // Nothing more to do.
      }
    }
    return null;
  },
});
