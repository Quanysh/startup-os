import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  httpAction,
  internalAction,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { isOwnerEmail } from "./authOwner";
import { companyIds, type CompanyId } from "./lib/company";
import { secretsEqual } from "./lib/constantTime";
import { MAX_TITLE_LENGTH } from "./lib/limits";
// The sender as the gate would see them (`getMember` without a session).
import { memberOf } from "./lib/memberOf";
import { memberMutation, type Member } from "./lib/owner";
import { may } from "./lib/roles";
import {
  COMMAND_FAILURES,
  HELP_REPLY,
  MAX_UPDATE_AGE_MS,
  MAX_WEBHOOK_BYTES,
  REFUSALS_PER_CHAT_PER_HOUR,
  REPLIES,
  REPLIES_PER_CHAT_PER_HOUR,
  TASKS_PER_CHAT_PER_HOUR,
  TASKS_PER_DAY,
  addedReply,
  botUsernameOf,
  commandFailureOf,
  commandsStateOf,
  firstTaskLine,
  nearDuplicateLine,
  parseRequest,
  parseUpdate,
  unknownAssigneeReply,
  untaggedRefusal,
  webhookSecret,
  webhookUrlOf,
  type TaskRequest,
} from "./lib/telegramCommand";
import {
  TELEGRAM_FAILURES,
  boardUrlOf,
  isBotToken,
  rememberChat,
  sameTelegram,
  type FoundChat,
} from "./lib/telegramMessage";
import { askTelegram } from "./lib/telegramRequest";
import { CANNOT_ASSIGN, PERSON_DUPLICATE_REASONS, createTask, nearMark, nearTasks } from "./tasks";
import {
  NO_TOKEN,
  botToken,
  linkLogWith,
  pickedChats,
  requireBothCompanies,
  sentenceOf,
  settingsRow,
  usernamesOnRecord,
  writeSettings,
} from "./telegram";

// Tasks added from a Telegram group. Telegram calls `POST /telegram/v1/webhook`
// with what is said to the bot in a group (a command, or a message that
// mentions it: with privacy mode on, the bot is sent nothing else). In a group
// the owner picked, from someone the OS lets in, that becomes a card on the
// board, and the bot answers once in the group.
//
// The route is the one place the OS takes input from outside with no token
// the owner set. Its guard is a secret derived from the bot's token, which
// Telegram sends back in a header. Past that, every field is still treated as
// hostile (`parseUpdate`), bad input is answered 200 and dropped (Telegram
// retries anything else for ever), and for a chat or a sender the OS does not
// know nothing is written: a group is listed only when someone with a
// username on record wrote in it or added the bot to it.
//
// The owner's own switch (`commandsWanted`) comes before all of it: unless the
// owner turned commands on, the route answers 200 and does nothing, whatever
// Telegram goes on sending.
//
// Nothing anyone typed (a title, a name, a username, a message) is logged,
// thrown, scheduled or put in the run log. What is remembered of a message is
// its update's id, for 48 hours. A failure while acting is kept as one of a
// few fixed sentences (`COMMAND_FAILURES`), never as what was thrown.

const HOUR_MS = 60 * 60 * 1000;
/** How long an update's id and a limit's rows are remembered. */
const KEPT_MS = 48 * HOUR_MS;
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

type Inbox = Doc<"telegramInbox">["kind"];
type Settings = Doc<"telegramSettings">;

// ── Who is writing ──────────────────────────────────────────────────────────

/** Someone with a Telegram username on record: a teammate's row or an owner's own entry. */
type Named = {
  email: string;
  /** The username as the owner typed it. */
  telegram: string;
  telegramUserId: string | undefined;
  /** Store the Telegram id that first added a task under the username, and write that it was. */
  bind: (ctx: MutationCtx, id: string, now: number) => Promise<void>;
};

/**
 * Whoever a username is on record for, whatever its capitals. Null when it is
 * nobody's, and also when it is two people's: a username the owner typed for
 * two records identifies neither.
 */
async function named(
  ctx: QueryCtx,
  settings: Settings,
  username: string | undefined,
): Promise<Named | null> {
  if (username === undefined) return null;
  const found: Named[] = [];
  // At most MAX_MEMBERS rows: `team.add` refuses more.
  for (const row of await ctx.db.query("members").collect()) {
    if (row.telegram === undefined || !sameTelegram(row.telegram, username)) continue;
    // An owner's address is the owner, whatever a row says.
    if (isOwnerEmail(row.email)) continue;
    found.push({
      email: row.email,
      telegram: row.telegram,
      telegramUserId: row.telegramUserId,
      bind: async (c, id, now) => {
        await c.db.patch(row._id, { telegramUserId: id, telegramBoundAt: now });
        await writeSettings(c, {
          log: linkLogWith(await settingsRow(c), { event: "linked", at: now, member: row._id }),
        });
      },
    });
  }
  for (const entry of settings.owners ?? []) {
    if (!sameTelegram(entry.telegram, username)) continue;
    const user = await ctx.db.get(entry.userId);
    const email = user?.email?.trim().toLowerCase();
    // Still an owner: the address may have left OWNER_EMAILS since.
    if (email === undefined || !isOwnerEmail(email)) continue;
    found.push({
      email,
      telegram: entry.telegram,
      telegramUserId: entry.telegramUserId,
      bind: async (c, id, now) => {
        const row = await settingsRow(c);
        await writeSettings(c, {
          owners: (row?.owners ?? []).map((owner) =>
            owner.userId === entry.userId
              ? { ...owner, telegramUserId: id, telegramBoundAt: now }
              : owner,
          ),
          log: linkLogWith(row, { event: "linked", at: now, owner: entry.userId }),
        });
      },
    });
  }
  return found.length === 1 ? found[0]! : null;
}

// ── What is remembered, and the limits ──────────────────────────────────────

/** Delete a few rows of a kind that are past keeping, so the table cannot grow without end. */
async function forget(ctx: MutationCtx, kind: Inbox, now: number) {
  const old = await ctx.db
    .query("telegramInbox")
    .withIndex("by_kind_and_at", (q) => q.eq("kind", kind).lt("at", now - KEPT_MS))
    .take(50);
  for (const row of old) await ctx.db.delete(row._id);
}

const KINDS: readonly Inbox[] = ["update", "task", "reply", "refusal", "limit"];

/**
 * Forget what is past keeping, of every kind: at most fifty rows of each, so
 * the work is bounded however much has piled up. Run for every update that
 * passes the secret, whether or not it is acted on, so the table empties even
 * when nobody the OS knows writes for days.
 */
async function forgetOld(ctx: MutationCtx, now: number) {
  for (const kind of KINDS) await forget(ctx, kind, now);
}

/** How many of a kind a group has had in the last hour, counted up to `max`. */
async function lately(ctx: QueryCtx, kind: Inbox, chat: string, now: number, max: number) {
  const rows = await ctx.db
    .query("telegramInbox")
    .withIndex("by_kind_and_chat_and_at", (q) =>
      q.eq("kind", kind).eq("chat", chat).gt("at", now - HOUR_MS),
    )
    .take(max);
  return rows.length;
}

/** Count one more of a kind for a group, unless it has had its `max` this hour. */
async function allow(ctx: MutationCtx, kind: Inbox, chat: string, now: number, max: number) {
  if ((await lately(ctx, kind, chat, now, max)) >= max) return false;
  await ctx.db.insert("telegramInbox", { kind, chat, ref: "", at: now });
  return true;
}

// ── The groups the bot has seen ─────────────────────────────────────────────

/**
 * Remember a group the bot was seen in, or forget one it has left.
 *
 * Anyone can add a bot to a group of their own and give it any title, so a
 * group the OS does not know is listed only when the update gives a reason to
 * believe the team is in it: whoever wrote there, or added the bot, has a
 * username on record. Any other is not stored at all. A group already listed
 * or picked is the same group whoever speaks in it.
 *
 * That the bot left or was removed is Telegram's word about the bot itself,
 * and needs nobody's username: the group goes off the list. A picked group
 * stays picked, and the settings page says the bot is out of it.
 */
async function seeGroup(
  ctx: MutationCtx,
  settings: Settings | null,
  seen: { chat: FoundChat; by?: string; left?: true },
) {
  const { chat } = seen;
  const now = Date.now();
  const found = settings?.found ?? [];
  const picked = pickedChats(settings);
  const listed = found.some((one) => one.id === chat.id);
  const isPicked = picked.some((one) => one.id === chat.id);
  /** The picked groups with this one marked as left at a time, or as back (`undefined`). */
  const marked = (leftAt: number | undefined) => ({
    ...(settings?.chatUs?.id === chat.id ? { chatUs: { ...settings.chatUs, leftAt } } : null),
    ...(settings?.chatKz?.id === chat.id ? { chatKz: { ...settings.chatKz, leftAt } } : null),
  });

  if (seen.left === true) {
    const news = picked.some((one) => one.id === chat.id && one.leftAt === undefined);
    if (!listed && !news) return;
    await writeSettings(ctx, {
      ...(listed ? { found: found.filter((one) => one.id !== chat.id) } : null),
      ...(news ? marked(now) : null),
    });
    return;
  }

  if (!listed && !isPicked) {
    if (seen.by === undefined) return;
    if (!(await usernamesOnRecord(ctx, settings)).has(seen.by.toLowerCase())) return;
  }
  const next = rememberChat(
    found,
    chat,
    picked.map((one) => one.id),
  );
  const back = picked.some((one) => one.id === chat.id && one.leftAt !== undefined);
  // As it is already listed: no write for every message in a busy group.
  if (next === found && !back) return;
  await writeSettings(ctx, {
    ...(next === found ? null : { found: [...next], foundAt: now }),
    ...(back ? marked(undefined) : null),
  });
}

// ── One update ──────────────────────────────────────────────────────────────

type Outcome = {
  reply: { chatId: string; text: string; replyTo: number } | null;
  /** A card was made: if its confirmation cannot be posted, the owner is told that much. */
  added: boolean;
};
const NOTHING: Outcome = { reply: null, added: false };

const entityValidator = v.object({
  type: v.union(v.literal("mention"), v.literal("text_mention"), v.literal("hashtag")),
  offset: v.number(),
  length: v.number(),
});
const chatValidator = v.object({
  id: v.string(),
  title: v.string(),
  type: v.union(v.literal("group"), v.literal("supergroup")),
});

/** What `parseUpdate` keeps of an update: see `InboundUpdate`. */
const updateValidator = v.object({
  updateId: v.number(),
  chat: v.optional(chatValidator),
  at: v.optional(v.number()),
  by: v.optional(v.string()),
  left: v.optional(v.literal(true)),
  message: v.optional(
    v.object({
      chatId: v.string(),
      messageId: v.number(),
      from: v.object({ id: v.string(), username: v.optional(v.string()) }),
      text: v.string(),
      entities: v.array(entityValidator),
      caption: v.boolean(),
    }),
  ),
});

/** The company a task lands on, or what to say instead. */
function boardFor(
  request: TaskRequest,
  groupOf: readonly CompanyId[],
  settings: Settings,
  member: Member,
): { company: CompanyId | undefined } | { refusal: string } {
  if (request.board !== undefined) {
    const company = request.board === "both" ? undefined : request.board;
    return company !== undefined && !member.companies.includes(company)
      ? { refusal: REPLIES.notYourBoard }
      : { company };
  }
  // No hashtag: the group's company. A group that serves both sends it where
  // the owner said, which is Globex's board unless they said otherwise.
  const untagged = groupOf.length === 1 ? groupOf[0]! : (settings.untaggedBoard ?? "kz");
  const company = untagged === "both" ? undefined : untagged;
  if (company === undefined || member.companies.includes(company)) return { company };
  return { refusal: untaggedRefusal(company, member.companies[0] ?? company) };
}

/**
 * Act on one update, in one transaction, and say what to answer in the group
 * (or nothing). In order: nothing at all unless the owner has turned commands
 * on; remember the group; ignore what asks nothing of the
 * bot and any chat that is not a picked group; refuse a sender the OS does
 * not know, at most twice an hour; ignore an update already acted on; then
 * help, or the task. The first task under a username links it to the account
 * that wrote, and the confirmation says so.
 */
export const handle = internalMutation({
  args: {
    /** Null for a body that passed the secret and was no update: only the housekeeping runs. */
    update: v.union(v.null(), updateValidator),
  },
  handler: async (ctx, { update }): Promise<Outcome> => {
    const now = Date.now();
    const settings = await settingsRow(ctx);
    // The owner's own switch, before anything is read or written. Telegram
    // can go on sending updates after "off" (removing the webhook failed, or
    // one was set again from elsewhere): none of them is acted on.
    if (settings?.commandsWanted !== true) return NOTHING;
    await forgetOld(ctx, now);
    if (update === null || update.chat === undefined) return NOTHING;
    // Old news: what Telegram held back while it could not deliver. Neither a
    // task from it nor a group, and a "left" that old may since be untrue.
    if (update.at === undefined || now - update.at > MAX_UPDATE_AGE_MS) return NOTHING;
    await seeGroup(ctx, settings, { chat: update.chat, by: update.by, left: update.left });

    const message = update.message;
    if (message === undefined) return NOTHING;
    const request = parseRequest(message, settings.botUsername);
    if (request === null) return NOTHING;
    // Only in a group the owner picked. Any other chat is not answered at all.
    const chat = message.chatId;
    const groupOf = companyIds().filter(
      (id) => (id === "us" ? settings.chatUs : settings.chatKz)?.id === chat,
    );
    if (groupOf.length === 0) return NOTHING;
    const say = (text: string, added = false): Outcome => ({
      reply: { chatId: chat, text, replyTo: message.messageId },
      added,
    });

    // The sender: a username on record, the Telegram id bound to it if one
    // is, someone the gate would let in, with the board.
    const sender = await named(ctx, settings, message.from.username);
    const member =
      sender === null ||
      (sender.telegramUserId !== undefined && sender.telegramUserId !== message.from.id)
        ? null
        : await memberOf(ctx, sender.email);
    if (sender === null || member === null || !may(member, "board")) {
      return (await allow(ctx, "refusal", chat, now, REFUSALS_PER_CHAT_PER_HOUR))
        ? say(REPLIES.strangers)
        : NOTHING;
    }

    // Telegram may deliver an update twice; it is acted on once.
    const ref = String(update.updateId);
    const seen = await ctx.db
      .query("telegramInbox")
      .withIndex("by_kind_and_ref", (q) => q.eq("kind", "update").eq("ref", ref))
      .first();
    if (seen !== null) return NOTHING;
    await ctx.db.insert("telegramInbox", { kind: "update", chat, ref, at: now });

    /** A reply that adds nothing: at most ten an hour to one group. */
    const answer = async (text: string): Promise<Outcome> =>
      (await allow(ctx, "reply", chat, now, REPLIES_PER_CHAT_PER_HOUR)) ? say(text) : NOTHING;

    if (request.kind === "help") return answer(HELP_REPLY(settings.botUsername));
    if (request.boardConflict) return answer(REPLIES.oneBoard);
    if (request.badDate) return answer(REPLIES.badDate);
    if (request.noUsername) return answer(REPLIES.noUsername);
    if (request.title.length > MAX_TITLE_LENGTH) return answer(REPLIES.titleTooLong);

    const board = boardFor(request, groupOf, settings, member);
    if ("refusal" in board) return answer(board.refusal);
    const { company } = board;

    // The assignee: a username on record. Whether the task may go to them
    // (someone the sender may be told of, on the task's company, with the
    // board) is `createTask`'s rule alone, below.
    let assignee: Named | null = null;
    if (request.assignee !== undefined) {
      assignee = await named(ctx, settings, request.assignee);
      if (assignee === null) return answer(unknownAssigneeReply(request.assignee));
    }

    // Thirty an hour from one group, a hundred a day from them all.
    const today = await ctx.db
      .query("telegramInbox")
      .withIndex("by_kind_and_at", (q) => q.eq("kind", "task").gt("at", now - 24 * HOUR_MS))
      .take(TASKS_PER_DAY);
    if (
      today.length >= TASKS_PER_DAY ||
      (await lately(ctx, "task", chat, now, TASKS_PER_CHAT_PER_HOUR)) >= TASKS_PER_CHAT_PER_HOUR
    ) {
      return (await allow(ctx, "limit", chat, now, 1)) ? say(REPLIES.limit) : NOTHING;
    }

    // Near an open card: added all the same, marked, and the reply names the
    // best one the sender may see that is of this group's company or shared
    // (a group never hears another company's card).
    const near = await nearTasks(ctx, member, { title: request.title, company: company ?? null, now });
    const nearOne = near.find((task) => task.company === null || groupOf.includes(task.company));
    try {
      await createTask(
        ctx,
        member,
        {
          title: request.title,
          assignee: assignee?.email ?? null,
          company: company ?? null,
          due: request.due,
        },
        { origin: { source: "telegram" }, duplicate: nearMark(near, PERSON_DUPLICATE_REASONS.telegram) },
      );
    } catch (error) {
      // The board's own refusal of the assignee, whatever its reason: one
      // answer, in the words that were typed, so the group never learns from
      // the bot that a username is a teammate's on the other company.
      // Anything else is not ours to word.
      if (error instanceof ConvexError && error.data === CANNOT_ASSIGN && request.assignee !== undefined) {
        return answer(unknownAssigneeReply(request.assignee));
      }
      throw error;
    }
    await ctx.db.insert("telegramInbox", { kind: "task", chat, ref: "", at: now });
    // The first task under a username ties it to the account that wrote. Only
    // a task does: its confirmation is always sent, so the link is never made
    // without the group being told, and the owner's log says it too.
    const linked = sender.telegramUserId === undefined;
    if (linked) await sender.bind(ctx, message.from.id, now);
    // The one confirmation. It tags the assignee, so the board's own
    // announcement is not sent for this card.
    const added = addedReply({
      username: assignee?.telegram,
      title: request.title,
      company,
      due: request.due,
      boardUrl: boardUrlOf(process.env.SITE_URL),
    });
    const lines = [
      added,
      ...(nearOne === undefined ? [] : [nearDuplicateLine(nearOne.title)]),
      ...(linked ? [firstTaskLine(sender.telegram)].filter((line): line is string => line !== undefined) : []),
    ];
    return say(lines.join("\n"), true);
  },
});

/**
 * Write down that an update could not be acted on: a fixed sentence and the
 * time, never what was thrown. With commands off nothing is written at all.
 */
export const failed = internalMutation({
  args: { failure: v.string() },
  handler: async (ctx, { failure }) => {
    const row = await settingsRow(ctx);
    if (row?.commandsWanted !== true) return null;
    await ctx.db.patch(row._id, {
      commandFailure: { what: commandFailureOf(failure), at: Date.now() },
    });
    return null;
  },
});

/**
 * How the one reply to an update went. Posted: the time, and whatever had
 * gone wrong before is cleared. Not posted: why, in the bot's fixed words
 * (`TELEGRAM_FAILURES`), and whether a task was added all the same, so the
 * owner is not left believing nothing happened.
 */
export const replied = internalMutation({
  args: { added: v.boolean(), failure: v.optional(v.string()) },
  handler: async (ctx, { added, failure }) => {
    const now = Date.now();
    await writeSettings(
      ctx,
      failure === undefined
        ? { lastSentAt: now, lastError: undefined, lastErrorAt: undefined, commandFailure: undefined }
        : {
            lastError: sentenceOf(failure),
            lastErrorAt: now,
            commandFailure: {
              what: added ? COMMAND_FAILURES.replyAfterTask : COMMAND_FAILURES.reply,
              at: now,
            },
          },
    );
    return null;
  },
});

const done = () => new Response(null, { status: 200 });

/**
 * POST /telegram/v1/webhook.
 *
 *   no secret, or a wrong one      401, and nothing is read
 *   anything else                  200, whatever it holds
 *
 * With commands not turned on by the owner (`commandsWanted`), a 200 is all
 * there is: nothing is written and nothing is said in any group.
 *
 * A wrong secret is the only refusal: Telegram sends an update again for any
 * answer but a 2xx, so a body that is too large, not JSON, not an update, or
 * that fails while being acted on is dropped with a 200. A failure while
 * acting is not lost, though: which of a few fixed sentences it was is kept
 * on the settings row for the owner (`failed`, `replied`). What was thrown is
 * never kept or logged: it may hold what somebody typed.
 */
export const webhookV1 = httpAction(async (ctx, request) => {
  const token = botToken();
  const expected = token !== null && isBotToken(token) ? await webhookSecret(token) : undefined;
  if (!(await secretsEqual(request.headers.get(SECRET_HEADER) ?? "", expected)) || token === null) {
    return new Response(null, { status: 401 });
  }
  // What is read of the body: an update, or null for anything else (too
  // large, not JSON, not an update). `handle` is called either way, so its
  // housekeeping runs for every request that passed the secret.
  let update: ReturnType<typeof parseUpdate> = null;
  try {
    // Refuse on the declared size, then measure what was read: the header can
    // be wrong, absent or no number at all (which declares nothing).
    const declaredTooLarge =
      Number(request.headers.get("Content-Length") ?? 0) > MAX_WEBHOOK_BYTES;
    if (!declaredTooLarge) {
      const body = await request.text();
      if (new TextEncoder().encode(body).length <= MAX_WEBHOOK_BYTES) {
        update = parseUpdate(JSON.parse(body));
      }
    }
  } catch {
    // Not an update: nothing was asked, so nothing went wrong.
  }

  let outcome: Outcome;
  try {
    outcome = await ctx.runMutation(internal.telegramInbound.handle, { update });
  } catch {
    await note(() => ctx.runMutation(internal.telegramInbound.failed, { failure: "update" }));
    return done();
  }
  const { reply, added } = outcome;
  if (reply === null) return done();
  let failure: string | undefined;
  try {
    // Telegram is waiting on this request: one attempt, eight seconds, no
    // waiting out a 429. A reply that cannot be posted is given up on and said.
    const sent = await askTelegram(
      token,
      "sendMessage",
      {
        chat_id: reply.chatId,
        text: reply.text,
        reply_parameters: { message_id: reply.replyTo, allow_sending_without_reply: true },
      },
      { quick: true },
    );
    failure = sent.ok ? undefined : sent.failure;
  } catch {
    failure = "other";
  }
  await note(() =>
    ctx.runMutation(internal.telegramInbound.replied, {
      added,
      ...(failure === undefined ? null : { failure }),
    }),
  );
  return done();
});

/** Write something down, and if that fails too, let it go: the answer is 200 either way. */
async function note(write: () => Promise<unknown>) {
  try {
    await write();
  } catch {
    // Nothing more to do, and nothing of it is logged.
  }
}

// ── Turning commands on and off ─────────────────────────────────────────────

async function start(ctx: MutationCtx, change: "on" | "off" | "check") {
  if (botToken() === null) throw new ConvexError(NO_TOKEN);
  if (change === "on" && webhookUrlOf(process.env.CONVEX_SITE_URL) === undefined) {
    throw new ConvexError(TELEGRAM_FAILURES.noSite);
  }
  // The switch is written here, in this transaction, before Telegram is asked
  // anything: "off" holds from now even if the webhook cannot be removed. It
  // is shared by both companies, so its two callers have already required
  // someone on both; a check writes nothing of it.
  await writeSettings(ctx, {
    ...(change === "check" ? null : { commandsWanted: change === "on" }),
    commandsWorkingSince: Date.now(),
    commandsError: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.telegramInbound.switchCommands, { change });
  return null;
}

/**
 * Let people add tasks from the group: tell Telegram to send the bot's
 * updates to this deployment. It runs in the background and how it went
 * arrives through `telegram.settings`.
 */
export const commandsOn = memberMutation("settings")({
  args: {},
  handler: (ctx) => {
    // One bot serves both companies' groups: only someone on both may switch it.
    requireBothCompanies(ctx.member);
    return start(ctx, "on");
  },
});

/**
 * Stop. From this call on the webhook acts on nothing; then Telegram is told
 * to send the bot's updates nowhere, which may fail without undoing that.
 */
export const commandsOff = memberMutation("settings")({
  args: {},
  handler: (ctx) => {
    requireBothCompanies(ctx.member);
    return start(ctx, "off");
  },
});

/** Ask Telegram where the bot's updates go now, and whether the last one arrived. */
export const checkCommands = memberMutation("settings")({
  // It changes nothing at Telegram, so any holder of the area may ask.
  args: {},
  handler: (ctx) => start(ctx, "check"),
});

/**
 * Set or remove the webhook, then read back what Telegram says of it. The
 * address is this deployment's own and the secret is derived from the token:
 * neither is stored, and a failure is kept as a fixed sentence's name.
 */
export const switchCommands = internalAction({
  args: { change: v.union(v.literal("on"), v.literal("off"), v.literal("check")) },
  handler: async (ctx, { change }): Promise<null> => {
    const finish = async (failure?: string): Promise<null> => {
      await ctx.runMutation(internal.telegram.noteBot, {
        finished: true,
        ...(failure === undefined ? null : { failure }),
      });
      return null;
    };
    try {
      const token = botToken() ?? "";
      const url = webhookUrlOf(process.env.CONVEX_SITE_URL);
      const me = await askTelegram(token, "getMe");
      if (!me.ok) return await finish(me.failure);
      if (change === "on" && url === undefined) return await finish("noSite");
      if (change !== "check") {
        const changed =
          change === "on"
            ? await askTelegram(token, "setWebhook", {
                url,
                secret_token: await webhookSecret(token),
                allowed_updates: ["message", "my_chat_member"],
                // Nothing said while commands were off is acted on now.
                drop_pending_updates: true,
              })
            : await askTelegram(token, "deleteWebhook");
        if (!changed.ok) return await finish(changed.failure);
      }
      const info = await askTelegram(token, "getWebhookInfo");
      if (!info.ok) return await finish(info.failure);
      await ctx.runMutation(internal.telegram.noteBot, {
        botUsername: botUsernameOf(me.json),
        commands: commandsStateOf(info.json, url),
        finished: true,
      });
    } catch {
      try {
        await finish("other");
      } catch {
        // Nothing more to do.
      }
    }
    return null;
  },
});
