import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import * as constantTime from "./lib/constantTime";
import {
  COMMAND_FAILURES,
  HELP_REPLY,
  MAX_UPDATE_AGE_MS,
  MAX_WEBHOOK_BYTES,
  REFUSALS_PER_CHAT_PER_HOUR,
  REPLIES,
  REPLIES_PER_CHAT_PER_HOUR,
  untaggedRefusal,
  TASKS_PER_CHAT_PER_HOUR,
  TASKS_PER_DAY,
  webhookSecret,
} from "./lib/telegramCommand";
import { TELEGRAM_FAILURES } from "./lib/telegramMessage";
import schema from "./schema";
import * as board from "./tasks";
import { PERSON_DUPLICATE_REASONS } from "./tasks";
import { NO_TOKEN } from "./telegram";
import {
  OWNER,
  addMember,
  memberEmail,
  modules,
  signInAs,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  type TestBackend,
} from "./test.setup";
import { finishScheduled, whileTimersRun } from "./test.timers";

// Tasks added from a Telegram group. Telegram calls the webhook; `fetch` (the
// bot's own requests) is a stub throughout, and nothing here reaches Telegram.

// Obviously not a real token; the word is what the tests look for.
const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";
const SITE = "https://os.example.test";
const CONVEX_SITE = "https://happy-otter-1.convex.site";
const HOOK = `${CONVEX_SITE}/telegram/v1/webhook`;
const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
const HOUR = 60 * 60 * 1000;
const BOT = "madeup_bot";
const US = { id: "-1001", title: "Startup team" };
const KZ = { id: "-1002", title: "Globex team" };
const LINK = `<a href="${SITE}/board">Open the board</a>`;

const COFOUNDER = memberEmail("cofounder");
const US_SALES = memberEmail("sales", ["us"]);
const KZ_ENGINEER = memberEmail("engineer", ["kz"]);
const NO_BOARD = "no.board@gmail.com";
// Who writes in the group: a Telegram username and the numeric id behind it.
const CORA = { username: "Cora_F", id: 770001 };
const SAM = { username: "Sam_Sales", id: 770002 };
const ERIK = { username: "Erik_Eng", id: 770003 };
const OLGA = { username: "Olga_Owner", id: 770000 };
const STRANGER = { username: "Some_Stranger", id: 6666 };

type Call = { method: string; url: string; body: Record<string, unknown> };
type Answer = Response | Error | (() => Promise<Response>);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const result = (value: unknown) => json({ ok: true, result: value });

/** The bot's own requests, answered by Bot API method; returns what was asked. */
function stubTelegram(answers: Record<string, Answer | Answer[]> = {}): Call[] {
  const calls: Call[] = [];
  const defaults: Record<string, Answer> = {
    sendMessage: result({ message_id: 9 }),
    getMe: result({ id: 1, is_bot: true, first_name: "SECRET bot name", username: BOT }),
    getWebhookInfo: result({ url: "", pending_update_count: 0 }),
    setWebhook: result(true),
    deleteWebhook: result(true),
    getUpdates: result([]),
    getChatMemberCount: result(7),
  };
  const used: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      calls.push({
        method,
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      const given = answers[method] ?? defaults[method]!;
      const list = Array.isArray(given) ? given : [given];
      const answer = list[Math.min(used[method] ?? 0, list.length - 1)]!;
      used[method] = (used[method] ?? 0) + 1;
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer();
      return answer.clone();
    }),
  );
  return calls;
}

let logged: unknown[][];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("CONVEX_SITE_URL", CONVEX_SITE);
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : arg)));
    });
  }
});
afterEach(() => {
  // Whatever a test did: no token, no secret, and nothing anyone typed, in a log.
  expect(JSON.stringify(logged)).not.toMatch(/SENTINEL|SECRET/);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Sender = { username?: string; id: number };
let nextUpdate = 1;
/** An update as Telegram sends it: a message in a group, with its entities marked. */
function update(
  text: string,
  from: Sender = CORA,
  chat: { id: string; title: string } = US,
  over: Record<string, unknown> = {},
) {
  nextUpdate += 1;
  const entities = [...text.matchAll(/[@#][A-Za-z0-9_]+/g)].map((m) => ({
    type: m[0].startsWith("@") ? "mention" : "hashtag",
    offset: m.index,
    length: m[0].length,
  }));
  return {
    update_id: nextUpdate,
    message: {
      message_id: 500 + nextUpdate,
      date: Math.floor(Date.now() / 1000),
      from: {
        id: from.id,
        is_bot: false,
        first_name: "SECRET first name",
        ...(from.username === undefined ? null : { username: from.username }),
      },
      chat: { id: Number(chat.id), title: chat.title, type: "supergroup" },
      text,
      entities,
      ...over,
    },
  };
}

async function deliver(t: TestBackend, body: unknown, headers?: Record<string, string>) {
  return t.fetch("/telegram/v1/webhook", {
    method: "POST",
    headers: headers ?? {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": await webhookSecret(TOKEN),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * A team with usernames on record, both groups picked, and the bot's name
 * known. Each username is already linked to its Telegram account, as it is
 * once someone has added a task; `linked: false` is the team before anyone has.
 */
async function start(settings: Record<string, unknown> = {}, { linked = true } = {}) {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const cofounder = await signInAsCofounder(t);
  await signInAsSales(t, ["us"]);
  await signInAsEngineer(t, ["kz"]);
  await addMember(t, { email: NO_BOARD, role: "engineer", areas: ["finance"] });
  await signInAs(t, { email: NO_BOARD, emailVerificationTime: 1 });
  await t.run(async (ctx) => {
    const userOf = async (email: string) =>
      (await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first())!;
    for (const [email, name, telegram, id] of [
      [COFOUNDER, "Cora Founder", CORA.username, CORA.id],
      [US_SALES, "Sam Sales", SAM.username, SAM.id],
      [KZ_ENGINEER, "Erik Engineer", ERIK.username, ERIK.id],
      [NO_BOARD, "Nora Noboard", "No_Board", undefined],
    ] as const) {
      await ctx.db.patch((await userOf(email))._id, { name });
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      await ctx.db.patch(row!._id, {
        telegram,
        ...(linked && id !== undefined ? { telegramUserId: String(id), telegramBoundAt: 1 } : null),
      });
    }
    const olga = await userOf(OWNER);
    await ctx.db.patch(olga._id, { name: "Olga Owner" });
    await ctx.db.insert("telegramSettings", {
      enabled: true,
      chatUs: US,
      chatKz: KZ,
      botUsername: BOT,
      commandsWanted: true,
      owners: [
        {
          userId: olga._id,
          telegram: OLGA.username,
          ...(linked ? { telegramUserId: String(OLGA.id), telegramBoundAt: 1 } : null),
        },
      ],
      ...settings,
    });
  });
  return { t, owner, cofounder };
}
/** The team before anyone has added a task from Telegram: no username is linked yet. */
const unlinked = () => start({}, { linked: false });

const tasks = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());
const settingsRow = (t: TestBackend) => t.run((ctx) => ctx.db.query("telegramSettings").first());
const member = (t: TestBackend, email: string) =>
  t.run((ctx) =>
    ctx.db
      .query("members")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first(),
  );
const everythingStored = async (t: TestBackend) =>
  JSON.stringify(
    await t.run(async (ctx) => ({
      settings: await ctx.db.query("telegramSettings").collect(),
      inbox: await ctx.db.query("telegramInbox").collect(),
      sends: await ctx.db.query("telegramSends").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    })),
  );
const replies = (calls: Call[]) => calls.filter((call) => call.method === "sendMessage");
const said = (calls: Call[]) => replies(calls).map((call) => call.body.text);

/** Deliver one message and say what became of it. */
async function tell(t: TestBackend, text: string, from: Sender = CORA, chat = US) {
  const calls = stubTelegram();
  const response = await deliver(t, update(text, from, chat));
  expect(response.status).toBe(200);
  await finishScheduled(t);
  return { calls, said: said(calls), tasks: await tasks(t) };
}

// ── The door ────────────────────────────────────────────────────────────────

describe("the webhook's secret", () => {
  test("the right secret is let in and answered 200", async () => {
    const { t } = await start();
    stubTelegram();
    const response = await deliver(t, update("/task Call back"));
    expect(response.status).toBe(200);
    expect(await tasks(t)).toHaveLength(1);
  });

  test.each([
    ["no header", { "Content-Type": "application/json" }],
    ["a wrong secret", { "X-Telegram-Bot-Api-Secret-Token": "a".repeat(64) }],
    ["an empty secret", { "X-Telegram-Bot-Api-Secret-Token": "" }],
    ["the token itself", { "X-Telegram-Bot-Api-Secret-Token": TOKEN }],
    ["the secret as a bearer token", { Authorization: "Bearer x" }],
  ])("%s is answered 401 with an empty body, and nothing happens", async (_what, headers) => {
    const { t } = await start();
    const calls = stubTelegram();
    const before = await everythingStored(t);
    const response = await deliver(t, update("/task Call back"), headers);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(await tasks(t)).toEqual([]);
    expect(await everythingStored(t)).toBe(before);
    expect(calls).toEqual([]);
  });

  test("with no token set there is no secret, and even an empty one is refused", async () => {
    const { t } = await start();
    const secret = await webhookSecret(TOKEN);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    for (const given of [secret, ""]) {
      const response = await deliver(t, update("/task Call back"), {
        "X-Telegram-Bot-Api-Secret-Token": given,
      });
      expect(response.status).toBe(401);
    }
    expect(await tasks(t)).toEqual([]);
  });

  test("a secret made from another token is refused", async () => {
    const { t } = await start();
    const response = await deliver(t, update("/task Call back"), {
      "X-Telegram-Bot-Api-Secret-Token": await webhookSecret(`${TOKEN}x`),
    });
    expect(response.status).toBe(401);
  });

  test.each([
    ["words", "plain-words-that-are-no-token"],
    ["a token with a path in it", "123456789:abc/../../getMe?x=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["a token too short", "123456789:short"],
  ])("a variable that is not a bot token (%s) opens nothing, even to the secret made from it", async (_what, value) => {
    const { t } = await start();
    const calls = stubTelegram();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", value);
    const before = await everythingStored(t);
    const response = await deliver(t, update("/task Call back"), {
      "X-Telegram-Bot-Api-Secret-Token": await webhookSecret(value),
    });
    expect(response.status).toBe(401);
    expect(await tasks(t)).toEqual([]);
    expect(await everythingStored(t)).toBe(before);
    expect(calls).toEqual([]);
  });

  test("the comparison is the constant-time helper's", async () => {
    const { t } = await start();
    stubTelegram();
    const spy = vi.spyOn(constantTime, "secretsEqual");
    await deliver(t, update("/task Call back"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([await webhookSecret(TOKEN), await webhookSecret(TOKEN)]);
  });
});

describe("what gets past the secret is answered 200 whatever it is", () => {
  test.each([
    ["not JSON", "{ not json"],
    ["an empty body", ""],
    ["JSON that is no update", JSON.stringify({ hello: "SECRET" })],
    ["an array", "[1,2,3]"],
    ["an update of a kind the bot does not read", JSON.stringify({ update_id: 5, poll: { id: "SECRET" } })],
    [
      "a message with hostile fields",
      JSON.stringify({
        update_id: 6,
        message: {
          message_id: { $gt: 0 },
          from: "SECRET",
          chat: { id: "-1001", title: ["SECRET"], type: "supergroup" },
          text: { toString: "SECRET" },
          entities: "SECRET",
        },
      }),
    ],
  ])("%s: 200, and nothing is written or sent", async (_what, body) => {
    const { t } = await start();
    const calls = stubTelegram();
    const before = await everythingStored(t);
    const response = await deliver(t, body);
    expect(response.status).toBe(200);
    expect(await tasks(t)).toEqual([]);
    expect(await everythingStored(t)).toBe(before);
    expect(calls).toEqual([]);
  });

  test("a body over 64 KB is not read", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const big = update(`/task ${"x".repeat(100)}`);
    (big.message as Record<string, unknown>).padding = "y".repeat(MAX_WEBHOOK_BYTES);
    const response = await deliver(t, big);
    expect(response.status).toBe(200);
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
    // The same message without the padding is read.
    delete (big.message as Record<string, unknown>).padding;
    await deliver(t, big);
    expect(await tasks(t)).toHaveLength(1);
  });

  test("a body declared over 64 KB is not read at all, whatever it holds", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const secret = await webhookSecret(TOKEN);
    const declared = (length: string) => ({
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
      "Content-Length": length,
    });
    // A small, valid update under a header that says it is too large.
    const response = await deliver(t, update("/task Call back"), declared(String(MAX_WEBHOOK_BYTES + 1)));
    expect(response.status).toBe(200);
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
    // At the limit, or with a header that is no number, it is read (and then measured).
    await deliver(t, update("/task At the limit"), declared(String(MAX_WEBHOOK_BYTES)));
    await deliver(t, update("/task No number"), declared("many"));
    expect((await tasks(t)).map((task) => task.title)).toEqual(["At the limit", "No number"]);
  });

  test("a failure of the bot's own reply is still 200, the task kept, and said in fixed words", async () => {
    const { t } = await start();
    stubTelegram({ sendMessage: json({ ok: false, description: "SECRET SENTINEL" }, 403) });
    const response = await deliver(t, update("/task Call back"));
    expect(response.status).toBe(200);
    expect(await tasks(t)).toHaveLength(1);
    expect((await settingsRow(t))?.lastError).toBe(TELEGRAM_FAILURES.chat);
    expect(await everythingStored(t)).not.toMatch(/SENTINEL|SECRET|api\.telegram\.org/);
  });
});

describe("a failure while acting on an update is written down for the owner, in fixed words", () => {
  const failure = async (t: TestBackend) => (await settingsRow(t))?.commandFailure;

  test("anything thrown while acting: still 200, nothing added or said, and the page is told which and when", async () => {
    const { t, owner } = await start();
    const calls = stubTelegram();
    vi.spyOn(board, "createTask").mockRejectedValueOnce(new Error("SECRET what somebody typed"));
    const response = await deliver(t, update("/task @Sam_Sales SECRET title", CORA));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
    // The update's own writes went with it: it can be sent again and acted on.
    expect(await t.run((ctx) => ctx.db.query("telegramInbox").collect())).toEqual([]);
    expect(await failure(t)).toEqual({ what: COMMAND_FAILURES.update, at: NOW });
    expect((await owner.query(api.telegram.settings, {})).commands).toMatchObject({
      failure: "An update from Telegram could not be acted on.",
      failureAt: NOW,
    });
    // Never the error's own words.
    expect(await everythingStored(t)).not.toMatch(/SECRET|typed/);
  });

  test("a task was added but its confirmation could not be posted: said as that, and the task is kept", async () => {
    const { t, owner } = await start();
    stubTelegram({ sendMessage: json({ ok: false, description: "SECRET SENTINEL" }, 403) });
    expect((await deliver(t, update("/task @Sam_Sales Call back", CORA))).status).toBe(200);
    expect(await tasks(t)).toHaveLength(1);
    expect(await failure(t)).toEqual({
      what: "A task was added but the reply could not be posted.",
      at: NOW,
    });
    expect((await owner.query(api.telegram.settings, {})).commands.failure).toBe(
      COMMAND_FAILURES.replyAfterTask,
    );
    // Why Telegram refused is still said where a message's failure is.
    expect((await settingsRow(t))?.lastError).toBe(TELEGRAM_FAILURES.chat);
    expect(await everythingStored(t)).not.toMatch(/SENTINEL|SECRET|api\.telegram\.org/);
  });

  test("a reply that adds nothing and could not be posted is said as that", async () => {
    const { t } = await start();
    stubTelegram({ sendMessage: new TypeError(`failed https://api.telegram.org/bot${TOKEN}/sendMessage`) });
    await whileTimersRun(deliver(t, update("/help", CORA)));
    expect(await tasks(t)).toEqual([]);
    expect(await failure(t)).toEqual({
      what: "The bot's reply could not be posted.",
      at: expect.any(Number),
    });
    expect(await everythingStored(t)).not.toMatch(/SENTINEL|api\.telegram\.org/);
  });

  test("the next reply that is posted clears it", async () => {
    const { t, owner } = await start({ commandFailure: { what: COMMAND_FAILURES.update, at: 5 } });
    await tell(t, "/task Call back", CORA);
    expect(await failure(t)).toBeUndefined();
    expect((await owner.query(api.telegram.settings, {})).commands).toMatchObject({
      failure: null,
      failureAt: null,
    });
  });

  test("an update that asks nothing leaves what was written alone", async () => {
    const kept = { what: COMMAND_FAILURES.replyAfterTask, at: 5 };
    const { t } = await start({ commandFailure: kept });
    await tell(t, "just talking", CORA);
    expect(await failure(t)).toEqual(kept);
  });

  test("only a fixed sentence can be written, whatever the action hands in", async () => {
    const { t } = await start();
    await t.mutation(internal.telegramInbound.failed, { failure: "SECRET <b>anything</b>" });
    expect(await failure(t)).toEqual({ what: COMMAND_FAILURES.update, at: NOW });
  });

  test("with commands off nothing is written, even of a failure", async () => {
    const { t } = await start({ commandsWanted: false });
    const before = await everythingStored(t);
    await t.mutation(internal.telegramInbound.failed, { failure: "update" });
    expect(await everythingStored(t)).toBe(before);
  });
});

describe("what was said a while ago is not acted on", () => {
  const sentAt = (body: ReturnType<typeof update>, at: number) => {
    body.message.date = Math.floor(at / 1000);
    return body;
  };

  test("a message more than ten minutes old adds nothing and is not answered", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const before = await everythingStored(t);
    for (const text of ["/task @Sam_Sales Old news", "/help", "@madeup_bot do it"]) {
      const response = await deliver(t, sentAt(update(text), NOW - MAX_UPDATE_AGE_MS - 1000));
      expect(response.status).toBe(200);
    }
    await deliver(t, sentAt(update("/task spam", STRANGER), NOW - 24 * HOUR));
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await everythingStored(t)).toBe(before);
  });

  test("one exactly ten minutes old is still acted on", async () => {
    const { t } = await start();
    stubTelegram();
    await deliver(t, sentAt(update("/task Just in time"), NOW - MAX_UPDATE_AGE_MS));
    expect(await tasks(t)).toHaveLength(1);
  });

  test("a message with no time on it is not acted on: its age cannot be told", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const body = update("/task No date") as { message: Record<string, unknown> };
    delete body.message.date;
    await deliver(t, body);
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("an old change to the bot's membership neither lists a group nor takes one off", async () => {
    const listed = { id: "-9001", title: "Another", type: "group" as const };
    const { t } = await start({ found: [listed] });
    stubTelegram();
    const old = Math.floor((NOW - MAX_UPDATE_AGE_MS - 1000) / 1000);
    const joined = membership(-9002, "Old group", CORA);
    joined.my_chat_member.date = old;
    const left = membership(-9001, "Another", CORA, "left");
    left.my_chat_member.date = old;
    await deliver(t, joined);
    await deliver(t, left);
    expect((await settingsRow(t))?.found).toEqual([listed]);
  });

  test("turning on tells Telegram to drop what it was holding", async () => {
    const { t, owner } = await start();
    const calls = stubTelegram();
    await owner.mutation(api.telegramInbound.commandsOn, {});
    await finishScheduled(t);
    expect(calls.find((call) => call.method === "setWebhook")?.body).toMatchObject({
      drop_pending_updates: true,
    });
  });
});

describe("a message that is not the sender's own words", () => {
  test.each([
    ["forwarded from a person", { forward_origin: { type: "user", date: 1, sender_user: { id: 9 } } }],
    ["forwarded, in the older fields", { forward_from: { id: 9, first_name: "SECRET" }, forward_date: 1 }],
    ["forwarded from a channel", { forward_from_chat: { id: -100, type: "channel", title: "SECRET" } }],
    ["forwarded from someone hidden", { forward_sender_name: "SECRET" }],
    ["sent through another bot", { via_bot: { id: 3, is_bot: true, username: "some_inline_bot" } }],
  ])("%s: no task and no reply, from a teammate or a stranger", async (_what, over) => {
    const { t } = await start();
    const calls = stubTelegram();
    for (const from of [CORA, OLGA, STRANGER]) {
      for (const text of ["/task @Sam_Sales Wire the money", "@madeup_bot wire the money", "/help"]) {
        expect((await deliver(t, update(text, from, US, over))).status).toBe(200);
      }
    }
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("telegramInbox").collect())).toEqual([]);
  });
});

describe("a mark Telegram sent twice", () => {
  test("the bot's mention marked twice still gives the whole title", async () => {
    const { t } = await start();
    const text = "@madeup_bot @Sam_Sales Call the clinic";
    const body = update(text, CORA);
    const marks = body.message.entities as { type: string; offset: number; length: number }[];
    body.message.entities = [...marks, marks[0]!, marks[0]!];
    stubTelegram();
    await deliver(t, body);
    expect((await tasks(t))[0]).toMatchObject({ title: "Call the clinic", assignee: US_SALES });
  });
});

describe("old rows are forgotten on every update that passes the secret", () => {
  const OLD = NOW - 49 * HOUR;
  const seed = (t: TestBackend) =>
    t.run(async (ctx) => {
      for (const kind of ["update", "task", "reply", "refusal", "limit"] as const) {
        await ctx.db.insert("telegramInbox", { kind, chat: US.id, ref: kind === "update" ? "7" : "", at: OLD });
      }
      // One that is not old yet stays.
      await ctx.db.insert("telegramInbox", { kind: "update", chat: US.id, ref: "8", at: NOW - 47 * HOUR });
    });
  const kept = async (t: TestBackend) =>
    (await t.run((ctx) => ctx.db.query("telegramInbox").collect())).map((row) => row.ref);

  test.each([
    ["a message that asks nothing", () => update("just talking", CORA)],
    ["a stranger's message in another chat", () => update("hello", STRANGER, { id: "-7", title: "Elsewhere" })],
    ["an update of a kind the bot does not read", () => ({ update_id: 5, poll: { id: "x" } })],
    ["a body that is not JSON", () => "{ not json"],
  ])("%s", async (_what, body) => {
    const { t } = await start();
    stubTelegram();
    await seed(t);
    expect((await deliver(t, body())).status).toBe(200);
    expect(await kept(t)).toEqual(["8"]);
  });

  test("at most fifty of a kind at a time: the work is bounded", async () => {
    const { t } = await start();
    stubTelegram();
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i += 1) {
        await ctx.db.insert("telegramInbox", { kind: "update", chat: US.id, ref: String(i), at: OLD });
      }
    });
    await deliver(t, update("just talking", CORA));
    expect(await kept(t)).toHaveLength(10);
    await deliver(t, update("just talking", CORA));
    expect(await kept(t)).toEqual([]);
  });

  test("not without the secret, and not with commands off", async () => {
    const { t, owner } = await start();
    stubTelegram();
    await seed(t);
    await deliver(t, update("just talking"), { "X-Telegram-Bot-Api-Secret-Token": "a".repeat(64) });
    expect(await kept(t)).toHaveLength(6);
    await owner.mutation(api.telegramInbound.commandsOff, {});
    await deliver(t, update("just talking"));
    expect(await kept(t)).toHaveLength(6);
  });
});

describe("the reply does not hold Telegram's request open", () => {
  test("a reply Telegram answers with a 5xx is tried once, not twice", async () => {
    const { t } = await start();
    const calls = stubTelegram({ sendMessage: json({}, 502) });
    await whileTimersRun(deliver(t, update("/task Call back")));
    expect(replies(calls)).toHaveLength(1);
    expect((await settingsRow(t))?.commandFailure?.what).toBe(COMMAND_FAILURES.replyAfterTask);
  });

  test("a 429 is not waited out: given up on at once, and said", async () => {
    const { t } = await start();
    const calls = stubTelegram({ sendMessage: json({ ok: false, parameters: { retry_after: 5 } }, 429) });
    // No timer is advanced here: the request is answered without waiting.
    const response = await deliver(t, update("/task Call back"));
    expect(response.status).toBe(200);
    expect(replies(calls)).toHaveLength(1);
    expect(await settingsRow(t)).toMatchObject({
      lastError: TELEGRAM_FAILURES.slow,
      commandFailure: { what: COMMAND_FAILURES.replyAfterTask },
    });
  });

  test("a reply Telegram never answers is given up on after eight seconds", async () => {
    const { t } = await start();
    const calls = stubTelegram({ sendMessage: () => new Promise<Response>(() => {}) });
    let status: number | undefined;
    const answered = deliver(t, update("/task Call back")).then((response) => {
      status = response.status;
    });
    // Until the reply has been handed to Telegram (the clock here is a fake one).
    while (replies(calls).length === 0) await new Promise((resolve) => setImmediate(resolve));
    const asked = Date.now();
    await vi.advanceTimersByTimeAsync(7_500);
    expect(status).toBeUndefined();
    await whileTimersRun(answered);
    expect(status).toBe(200);
    // Eight seconds, not the twenty (and a second try) an ordinary request is given.
    expect(Date.now() - asked).toBeLessThan(9_000);
    expect(replies(calls)).toHaveLength(1);
    expect(await tasks(t)).toHaveLength(1);
    expect(await settingsRow(t)).toMatchObject({
      lastError: TELEGRAM_FAILURES.timeout,
      commandFailure: { what: COMMAND_FAILURES.replyAfterTask },
    });
  });
});

// ── Which chats ─────────────────────────────────────────────────────────────

describe("a chat that is not a picked group", () => {
  const ELSEWHERE = { id: "-7777", title: "Some other group" };

  test("is ignored silently, apart from being remembered as a group the bot has seen", async () => {
    const { t } = await start();
    for (const text of ["/task @Cora_F Call back", "@madeup_bot do it", "/help", "/start@madeup_bot"]) {
      const out = await tell(t, text, CORA, ELSEWHERE);
      expect(out.said).toEqual([]);
      expect(out.tasks).toEqual([]);
    }
    const row = await settingsRow(t);
    expect(row?.found).toEqual([{ ...ELSEWHERE, type: "supergroup" }]);
    expect(await t.run((ctx) => ctx.db.query("telegramInbox").collect())).toEqual([]);
  });

  test.each([
    ["the picked group's id as a string", US.id],
    ["a fraction of it", Number(US.id) + 0.5],
    ["an object", { valueOf: US.id }],
  ])("a chat id that is no whole number (%s) is no group, the picked one included", async (_what, id) => {
    const { t } = await start();
    const calls = stubTelegram();
    const body = update("/task @Sam_Sales Call back", CORA);
    (body.message as Record<string, unknown>).chat = { id, title: US.title, type: "supergroup" };
    const before = await everythingStored(t);
    expect((await deliver(t, body)).status).toBe(200);
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await everythingStored(t)).toBe(before);
  });

  test("a private chat with the bot is ignored and not remembered", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const dm = update("/task Call back");
    (dm.message as Record<string, unknown>).chat = { id: 1001, type: "private", first_name: "SECRET" };
    expect((await deliver(t, dm)).status).toBe(200);
    expect(await tasks(t)).toEqual([]);
    expect(calls).toEqual([]);
    expect((await settingsRow(t))?.found).toBeUndefined();
  });

  test("a message that asks nothing of the bot is nothing, in a picked group too", async () => {
    const { t } = await start();
    const out = await tell(t, "just talking about @Sam_Sales and /tasks");
    expect(out.said).toEqual([]);
    expect(out.tasks).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("telegramInbox").collect())).toEqual([]);
  });
});

/** The bot's own membership of a group changing: who did it, and what the bot now is there. */
function membership(
  id: number,
  title: string,
  by: Sender | null = CORA,
  status = "member",
) {
  nextUpdate += 1;
  return {
    update_id: nextUpdate,
    my_chat_member: {
      date: Math.floor(Date.now() / 1000),
      chat: { id, title, type: "group", username: "SECRET_link" },
      ...(by === null
        ? null
        : {
            from: {
              id: by.id,
              first_name: "SECRET",
              ...(by.username === undefined ? null : { username: by.username }),
            },
          }),
      new_chat_member: { status, user: { id: 1, first_name: "SECRET" } },
    },
  };
}
const group = (n: number) => ({ id: String(-5000 - n), title: `Group ${n}`, type: "group" as const });

describe("the groups the bot has seen", () => {
  test("a group a teammate added the bot to is remembered: id, title and type, newest first", async () => {
    const { t } = await start();
    stubTelegram();
    await deliver(t, membership(-9001, "First", CORA));
    // The owner's own username counts, whatever its capitals.
    await deliver(t, membership(-9002, "Second", { username: "olga_OWNER", id: 1 }));
    const row = await settingsRow(t);
    expect(row?.found).toEqual([
      { id: "-9002", title: "Second", type: "group" },
      { id: "-9001", title: "First", type: "group" },
    ]);
    expect(JSON.stringify(row)).not.toContain("SECRET");
    // The groups already picked are untouched.
    expect(row).toMatchObject({ chatUs: US, chatKz: KZ, enabled: true });
  });

  test("a group a teammate writes in is remembered, whether or not the message asks anything", async () => {
    const { t } = await start();
    await tell(t, "just talking", SAM, { id: "-9003", title: "Sales chat" });
    expect((await settingsRow(t))?.found).toEqual([
      { id: "-9003", title: "Sales chat", type: "supergroup" },
    ]);
  });

  test.each([
    ["someone the OS does not know", STRANGER],
    ["someone with no username", { id: 4040 }],
    ["nobody named", null],
  ])("a group %s added the bot to is not stored at all", async (_who, by) => {
    const { t } = await start();
    stubTelegram();
    const before = await everythingStored(t);
    await deliver(t, membership(-9001, "Startup team", by));
    if (by !== null) await deliver(t, update("/start@madeup_bot", by, { id: "-9001", title: "Startup team" }));
    expect(await everythingStored(t)).toBe(before);
    expect((await settingsRow(t))?.found).toBeUndefined();
  });

  test("strangers cannot push the owner's group out of the list, however many groups they make", async () => {
    const real = { id: "-9001", title: "Startup team", type: "group" as const };
    const { t, owner } = await start({ found: [real] });
    stubTelegram();
    for (let i = 0; i < 25; i += 1) {
      await deliver(t, membership(-7000 - i, "Startup team", STRANGER));
      await deliver(t, update("/start", STRANGER, { id: String(-7000 - i), title: "Startup team" }));
    }
    expect((await settingsRow(t))?.found).toEqual([real]);
    expect((await owner.query(api.telegram.settings, {})).found).toEqual([real]);
  });

  test("the list is kept to twenty: the one seen longest ago goes, and a group seen again puts nobody out", async () => {
    const { t } = await start();
    stubTelegram();
    for (let i = 0; i < 20; i += 1) await deliver(t, membership(-5000 - i, `Group ${i}`));
    // The oldest again, three times, once under a new title: still the same twenty.
    for (const title of ["Group 0", "Group 0, renamed", "Group 0, renamed"]) {
      await deliver(t, membership(-5000, title));
    }
    let found = (await settingsRow(t))!.found!;
    expect(found.map((one) => one.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(-5019 + i)),
    );
    expect(found.at(-1)).toEqual({ ...group(0), title: "Group 0, renamed" });
    // A twenty-first puts out the oldest and nothing else.
    await deliver(t, membership(-5020, "Group 20"));
    found = (await settingsRow(t))!.found!;
    expect(found).toHaveLength(20);
    expect(found[0]).toEqual(group(20));
    expect(found.at(-1)).toEqual(group(1));
  });

  test("a picked group is never put out, and the owner is shown it first", async () => {
    const picked = { ...US, type: "supergroup" as const };
    const { t, owner } = await start({ found: [group(0), picked] });
    stubTelegram();
    for (let i = 1; i <= 25; i += 1) await deliver(t, membership(-5000 - i, `Group ${i}`));
    const found = (await settingsRow(t))!.found!;
    expect(found).toHaveLength(20);
    expect(found).toContainEqual(picked);
    expect(found).not.toContainEqual(group(0));
    const read = await owner.query(api.telegram.settings, {});
    expect(read.found?.[0]).toEqual(picked);
    expect(read.found?.[1]).toEqual(group(25));
  });

  test("a group already listed as it is costs no write", async () => {
    const { t } = await start({ found: [{ ...US, type: "supergroup" }] });
    const before = await settingsRow(t);
    await tell(t, "just talking");
    expect(await settingsRow(t)).toEqual(before);
  });

  test("a group already listed takes a new title from anyone in it, since it is the same group", async () => {
    const { t } = await start({ found: [{ id: "-9001", title: "Old name", type: "group" }] });
    stubTelegram();
    await deliver(t, membership(-9001, "New name", STRANGER));
    expect((await settingsRow(t))?.found).toEqual([{ id: "-9001", title: "New name", type: "group" }]);
  });
});

describe("the bot leaving a group", () => {
  const OTHER = { id: "-9001", title: "Another", type: "group" as const };

  test.each(["left", "kicked"])("status %s takes the group off the list of those found", async (status) => {
    const { t } = await start({ found: [OTHER, group(1)] });
    stubTelegram();
    // Whoever removed it: no username is needed to believe Telegram about the bot itself.
    await deliver(t, membership(-9001, "Another", STRANGER, status));
    expect((await settingsRow(t))?.found).toEqual([group(1)]);
  });

  test("a picked group stays picked, is taken off the list, and the owner is told the bot has left it", async () => {
    const { t, owner } = await start({ found: [{ ...US, type: "supergroup" }, OTHER] });
    stubTelegram();
    await deliver(t, membership(Number(US.id), US.title, null, "kicked"));
    const row = await settingsRow(t);
    expect(row?.found).toEqual([OTHER]);
    expect(row?.chatUs).toMatchObject(US);
    expect(row?.chatKz).toEqual(KZ);
    const read = await owner.query(api.telegram.settings, {});
    expect(read.chats.us).toMatchObject({ ...US, left: true });
    expect(read.chats.kz).toEqual(KZ);
    // Saving something else does not forget that it left.
    await owner.mutation(api.telegram.save, { enabled: false, chatUs: US.id, chatKz: KZ.id });
    expect((await owner.query(api.telegram.settings, {})).chats.us).toMatchObject({ left: true });
  });

  test("one group picked for both companies is said for both", async () => {
    const { t, owner } = await start({ chatKz: US });
    stubTelegram();
    await deliver(t, membership(Number(US.id), US.title, null, "left"));
    const read = await owner.query(api.telegram.settings, {});
    expect(read.chats.us).toMatchObject({ left: true });
    expect(read.chats.kz).toMatchObject({ left: true });
  });

  test("seen in the group again, the bot is back: listed, and no longer said to have left", async () => {
    const { t, owner } = await start();
    stubTelegram();
    await deliver(t, membership(Number(US.id), US.title, null, "left"));
    await deliver(t, membership(Number(US.id), US.title, STRANGER, "member"));
    const read = await owner.query(api.telegram.settings, {});
    expect(read.chats.us).toEqual(US);
    expect(read.found).toEqual([{ ...US, type: "group" }]);
  });

  test("leaving a group the OS never knew writes nothing", async () => {
    const { t } = await start();
    stubTelegram();
    const before = await everythingStored(t);
    await deliver(t, membership(-4444, "SECRET group", CORA, "left"));
    expect(await everythingStored(t)).toBe(before);
  });
});

// ── The forms ───────────────────────────────────────────────────────────────

describe("adding a task", () => {
  test("/task @person Title: a card in Backlog, for them, by the sender, from Telegram", async () => {
    const { t, cofounder } = await start();
    const out = await tell(t, "/task @Sam_Sales Call the pilot clinic");
    expect(out.tasks).toHaveLength(1);
    const [task] = out.tasks;
    expect(task).toMatchObject({
      title: "Call the pilot clinic",
      kind: "task",
      column: "backlog",
      order: 0,
      assignee: US_SALES,
      company: "us",
      origin: { source: "telegram" },
    });
    expect(task!.notes).toBeUndefined();
    const maker = await t.run((ctx) => ctx.db.get(task!.createdBy!));
    expect(maker?.email).toBe(COFOUNDER);
    // On the board like any other card.
    const board = await cofounder.query(api.tasks.board, {});
    expect(board.backlog.map((card) => card.title)).toEqual(["Call the pilot clinic"]);
  });

  test("it is confirmed once, as a reply to the message, tagging the assignee", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const sent = update("/task @sam_sales Call the pilot clinic");
    await deliver(t, sent);
    await finishScheduled(t);
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.body).toEqual({
      chat_id: US.id,
      text: `<b>Added</b> to Startup's board for @Sam_Sales: Call the pilot clinic · ${LINK}`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_parameters: { message_id: sent.message.message_id, allow_sending_without_reply: true },
    });
  });

  test("there is no second announcement: nothing is scheduled, and one message is all the group gets", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Sam_Sales Call the pilot clinic");
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
    expect(out.said).toHaveLength(1);
    expect(JSON.stringify(out.said)).not.toContain("New task");
  });

  test("a card added from the board afterwards goes after it, and is announced as usual", async () => {
    const { t, owner } = await start();
    await tell(t, "/task Call the pilot clinic");
    const calls = stubTelegram();
    await owner.mutation(api.tasks.create, { title: "From the board", assignee: US_SALES });
    await finishScheduled(t);
    expect((await tasks(t)).map((task) => [task.title, task.order])).toEqual([
      ["Call the pilot clinic", 0],
      ["From the board", 1],
    ]);
    expect(said(calls)).toHaveLength(1);
    expect(String(said(calls)[0])).toContain("<b>New task</b> for @Sam_Sales");
  });

  test("/task Title: nobody's", async () => {
    const { t } = await start();
    const out = await tell(t, "/task Update the pricing page");
    expect(out.tasks[0]).toMatchObject({ title: "Update the pricing page", company: "us" });
    expect(out.tasks[0]!.assignee).toBeUndefined();
    expect(out.said).toEqual([`<b>Added</b> to Startup's board: Update the pricing page · ${LINK}`]);
  });

  test("/task@bot …, Telegram's addressed form", async () => {
    const { t } = await start();
    const out = await tell(t, "/task@MadeUp_Bot @Sam_Sales Call back");
    expect(out.tasks[0]).toMatchObject({ title: "Call back", assignee: US_SALES });
  });

  test("a command addressed to another bot is not ours", async () => {
    const { t } = await start();
    const out = await tell(t, "/task@other_bot Call back");
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([]);
  });

  test("a due date written by YYYY-MM-DD", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Sam_Sales Send the contract by 2026-10-20");
    expect(out.tasks[0]).toMatchObject({ title: "Send the contract", due: "2026-10-20" });
    expect(out.said).toEqual([
      `<b>Added</b> to Startup's board for @Sam_Sales: Send the contract · due 20 Oct 2026 · ${LINK}`,
    ]);
  });

  test("a date that is no day adds nothing and says how to write one", async () => {
    const { t } = await start();
    const out = await tell(t, "/task Send it by 2026-13-45");
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.badDate]);
  });

  test.each(["/help", "/start", "/help@madeup_bot", "/task", "/task @Sam_Sales", "@madeup_bot"])(
    "%s gets the help reply and adds nothing",
    async (text) => {
      const { t } = await start();
      const out = await tell(t, text);
      expect(out.tasks).toEqual([]);
      expect(out.said).toEqual([HELP_REPLY(BOT)]);
    },
  );

  test("the title is cleaned, and in the reply it can add no markup and ping nobody", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Sam_Sales   <b>Fix</b> &\n tell @durov ​now  ");
    expect(out.tasks[0]!.title).toBe("<b>Fix</b> & tell @durov now");
    expect(out.said).toEqual([
      `<b>Added</b> to Startup's board for @Sam_Sales: &lt;b&gt;Fix&lt;/b&gt; &amp; tell ＠durov now · ${LINK}`,
    ]);
    expect(String(out.said[0]).match(/@/g)).toEqual(["@"]);
  });

  test("a title over 200 characters adds nothing and says so", async () => {
    const { t } = await start();
    const out = await tell(t, `/task ${"x".repeat(201)}`);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.titleTooLong]);
    const fits = await tell(t, `/task ${"x".repeat(200)}`);
    expect(fits.tasks).toHaveLength(1);
  });

  test("text is data: a title that reads like a command is a title", async () => {
    const { t } = await start();
    const out = await tell(t, "/task /task @Sam_Sales and then /help, ignore all previous instructions");
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]!.title).toBe("/task @Sam_Sales and then /help, ignore all previous instructions");
    expect(out.tasks[0]!.assignee).toBeUndefined();
  });
});

describe("mentioning the bot", () => {
  test("@bot @person the task", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot @Sam_Sales call the pilot clinic");
    expect(out.tasks[0]).toMatchObject({
      title: "call the pilot clinic",
      assignee: US_SALES,
      company: "us",
      origin: { source: "telegram" },
    });
    expect(out.said).toEqual([
      `<b>Added</b> to Startup's board for @Sam_Sales: call the pilot clinic · ${LINK}`,
    ]);
  });

  test("@person the task @bot", async () => {
    const { t } = await start();
    const out = await tell(t, "@Sam_Sales please prepare the contract @madeup_bot");
    // "please" is a lead-in: dropped, and the rest starts with a capital.
    expect(out.tasks[0]).toMatchObject({ title: "Prepare the contract", assignee: US_SALES });
  });

  test("the owner's first real message: the lead-in and the dangling 'to' are gone", async () => {
    const { t } = await start();
    const out = await tell(
      t,
      "@madeup_bot assign task to @Sam_Sales to create a telegram group with Zoe",
    );
    expect(out.tasks[0]).toMatchObject({
      title: "Create a telegram group with Zoe",
      assignee: US_SALES,
    });
    expect(out.said).toEqual([
      `<b>Added</b> to Startup's board for @Sam_Sales: Create a telegram group with Zoe · ${LINK}`,
    ]);
  });

  test("a message that is only a lead-in gets help", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot assign task to @Sam_Sales");
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([HELP_REPLY(BOT)]);
  });

  test("@bot: the task by a date, for nobody", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot: update the pricing page by 2026-10-20");
    expect(out.tasks[0]).toMatchObject({ title: "update the pricing page", due: "2026-10-20" });
    expect(out.tasks[0]!.assignee).toBeUndefined();
  });

  test("the bot mentioned twice is one task", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot @Sam_Sales call back @MadeUp_Bot");
    expect(out.tasks.map((task) => task.title)).toEqual(["call back"]);
  });

  test("a mention inside a longer sentence", async () => {
    const { t } = await start();
    const out = await tell(t, "hey @madeup_bot can @Sam_Sales call the clinic tomorrow?");
    expect(out.tasks[0]).toMatchObject({ title: "hey can call the clinic tomorrow?", assignee: US_SALES });
  });

  test("another bot mentioned, and not ours, is not for us", async () => {
    const { t } = await start();
    const out = await tell(t, "@other_bot @Sam_Sales call back");
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([]);
  });

  test("another bot mentioned beside ours is nobody the board knows", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot @other_bot do it");
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual(["I do not know ＠other_bot as a teammate on this board. Nothing was added."]);
  });

  test("a person with no username (a text mention) cannot be the assignee, and that is said", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const text = "@madeup_bot Dana call the clinic";
    await deliver(
      t,
      update(text, CORA, US, {
        entities: [
          { type: "mention", offset: 0, length: 11 },
          { type: "text_mention", offset: 12, length: 4, user: { id: 77, first_name: "SECRET" } },
        ],
      }),
    );
    expect(await tasks(t)).toEqual([]);
    expect(said(calls)).toEqual([REPLIES.noUsername]);
  });

  test("the bot's name unknown (never looked up): a mention is nobody's, a plain /task still works", async () => {
    const { t } = await start({ botUsername: undefined });
    expect((await tell(t, "@madeup_bot call back")).tasks).toEqual([]);
    expect((await tell(t, "/task call back")).tasks).toHaveLength(1);
  });

  test("a reply that only mentions the bot gets help: the message replied to is never read", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    await deliver(
      t,
      update("@madeup_bot", CORA, US, {
        reply_to_message: {
          message_id: 3,
          from: { id: 6666, first_name: "SECRET" },
          chat: { id: -1001, type: "supergroup", title: "Startup team" },
          text: "SECRET words somebody else wrote: call the clinic",
        },
      }),
    );
    expect(await tasks(t)).toEqual([]);
    expect(said(calls)).toEqual([HELP_REPLY(BOT)]);
  });

  test("a photo's caption that mentions the bot is a task; one without marks is nothing", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const caption = "@madeup_bot @Sam_Sales look at this";
    const photo = update(caption, CORA, US, { text: undefined });
    Object.assign(photo.message, {
      caption,
      caption_entities: photo.message.entities,
      entities: undefined,
      photo: [{ file_id: "SECRET" }],
    });
    await deliver(t, photo);
    expect((await tasks(t)).map((task) => task.title)).toEqual(["look at this"]);

    const bare = update("x", CORA, US, { text: undefined });
    Object.assign(bare.message, { caption, entities: undefined });
    await deliver(t, bare);
    expect(await tasks(t)).toHaveLength(1);
    expect(replies(calls)).toHaveLength(1);
  });
});

// ── Who may ─────────────────────────────────────────────────────────────────

describe("who may add a task from Telegram", () => {
  test("the owner, by the username the owner gave for themselves", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Cora_F Review the deck", OLGA);
    expect(out.tasks[0]).toMatchObject({ title: "Review the deck", assignee: COFOUNDER });
    const maker = await t.run((ctx) => ctx.db.get(out.tasks[0]!.createdBy!));
    expect(maker?.email).toBe(OWNER);
  });

  test("a username is matched whatever its capitals", async () => {
    const { t } = await start();
    const out = await tell(t, "/task Call back", { username: "cora_f", id: CORA.id });
    expect(out.tasks).toHaveLength(1);
  });

  test.each([
    ["someone the OS does not know", STRANGER],
    ["someone with no username", { id: 4040 }],
    ["a teammate without the board", { username: "No_Board", id: 3003 }],
  ])("%s gets one short refusal and adds nothing", async (_who, sender) => {
    const { t } = await start();
    for (const text of ["/task Call back", "@madeup_bot call back", "/help"]) {
      const out = await tell(t, text, sender);
      expect(out.tasks).toEqual([]);
      expect(out.said.every((reply) => reply === REPLIES.strangers)).toBe(true);
    }
    // Nothing of them is kept: no id bound, no update remembered.
    expect(await everythingStored(t)).not.toContain(String(sender.id));
    expect((await member(t, NO_BOARD))?.telegramUserId).toBeUndefined();
  });

  test("a teammate removed from the team is a stranger from then on", async () => {
    const { t, owner } = await start();
    expect((await tell(t, "/task First", SAM)).tasks).toHaveLength(1);
    const row = await member(t, US_SALES);
    await owner.mutation(api.team.remove, { id: row!._id });
    const out = await tell(t, "/task Second", SAM);
    expect(out.tasks).toHaveLength(1);
    expect(out.said).toEqual([REPLIES.strangers]);
  });

  test("a teammate who has never signed in to the OS cannot add from Telegram", async () => {
    const { t } = await start();
    await t.run(async (ctx) => {
      await ctx.db.insert("members", {
        email: "never.signed.in@gmail.com",
        role: "sales",
        companies: ["us"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
        telegram: "Never_Signed",
      });
    });
    const out = await tell(t, "/task Call back", { username: "Never_Signed", id: 5050 });
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.strangers]);
  });

  test("two people with the same username on record: neither is trusted by it", async () => {
    const { t } = await start();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", US_SALES))
        .first();
      await ctx.db.patch(row!._id, { telegram: "cora_f" });
    });
    const out = await tell(t, "/task Call back", CORA);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.strangers]);
  });

  test("the refusal is said at most twice an hour in a group, however often a stranger tries", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    for (let i = 0; i < 6; i += 1) await deliver(t, update("/task spam", STRANGER));
    for (let i = 0; i < 3; i += 1) await deliver(t, update("@madeup_bot spam", { id: 7000 + i }));
    expect(said(calls)).toEqual(Array(REFUSALS_PER_CHAT_PER_HOUR).fill(REPLIES.strangers));
    expect(await tasks(t)).toEqual([]);
    // A teammate is still served, and the other group has its own count.
    await deliver(t, update("/task Real work", CORA));
    await deliver(t, update("/task spam", STRANGER, KZ));
    expect(said(calls)).toHaveLength(REFUSALS_PER_CHAT_PER_HOUR + 2);
    vi.setSystemTime(NOW + HOUR + 1);
    await deliver(t, update("/task spam", STRANGER));
    expect(said(calls)).toHaveLength(REFUSALS_PER_CHAT_PER_HOUR + 3);
  });
});

// Each of these fails when the one check it names is taken out of
// `named` or `memberOf` in convex/telegramInbound.ts.
describe("who is let in is who the gate would let in", () => {
  /** Someone on the team with the board and a username, whose `users` row is as given. */
  const teammate = (
    t: TestBackend,
    email: string,
    telegram: string | undefined,
    user: { emailVerificationTime?: number } | null,
  ) =>
    t.run(async (ctx) => {
      await ctx.db.insert("members", {
        email,
        role: "sales",
        companies: ["us", "kz"],
        areas: ["board"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
        ...(telegram === undefined ? null : { telegram }),
      });
      return user === null ? null : await ctx.db.insert("users", { email, ...user });
    });

  test("a teammate whose address Google has not vouched for cannot add from Telegram", async () => {
    const { t } = await start();
    // A users row with the address and no verified time: the gate refuses it in the browser too.
    await teammate(t, "unverified@gmail.com", "Not_Verified", {});
    const out = await tell(t, "/task Call back", { username: "Not_Verified", id: 5151 });
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.strangers]);
    // The same person, verified, is let in: it was the one missing thing.
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", "unverified@gmail.com"))
        .first();
      await ctx.db.patch(user!._id, { emailVerificationTime: 1 });
    });
    expect((await tell(t, "/task Call back", { username: "Not_Verified", id: 5151 })).tasks).toHaveLength(1);
  });

  test.each([
    ["unset", ""],
    ["blank", "  ,  "],
  ])("with no owner configured (OWNER_EMAILS %s) nobody is let in, teammate or owner", async (_what, value) => {
    const { t } = await start();
    // A teammate is let in only while there is an owner who could remove them.
    expect((await tell(t, "/task Before", CORA)).tasks).toHaveLength(1);
    vi.stubEnv("OWNER_EMAILS", value);
    for (const from of [CORA, SAM, OLGA]) {
      const out = await tell(t, "/task @Sam_Sales Call back", from);
      expect(out.tasks).toHaveLength(1);
      expect(out.said.every((reply) => reply === REPLIES.strangers)).toBe(true);
    }
  });

  test("a members row that carries an owner's address is nobody: its username cannot act as the owner", async () => {
    const { t } = await start();
    // `team.add` refuses an owner's address; a row from before it was one, or written by hand, may hold it.
    await teammate(t, OWNER, "Fake_Owner", null);
    const impostor = { username: "Fake_Owner", id: 6161 };
    // Everything the owner could do from Telegram and a Startup salesperson could not.
    for (const text of ["/task @Erik_Eng #globex Wire the money", "/task #globex Wire the money", "/task Hello"]) {
      const out = await tell(t, text, impostor, US);
      expect(out.tasks).toEqual([]);
      expect(out.said.every((reply) => reply === REPLIES.strangers)).toBe(true);
    }
    expect((await member(t, OWNER))?.telegramUserId).toBeUndefined();
    // Nor is it the owner as an assignee: the owner's own username still is.
    const named = await tell(t, "/task @Fake_Owner Sign the lease", CORA);
    expect(named.tasks).toEqual([]);
    expect((await tell(t, "/task @Olga_Owner Sign the lease", CORA)).tasks[0]).toMatchObject({ assignee: OWNER });
  });

  test("someone who was an owner and is no longer: the username they gave themselves lets nobody in", async () => {
    const { t } = await start();
    const EX = "was.owner@gmail.com";
    // Now a teammate with the board and no username on the team page; the
    // entry they made for themselves as an owner is still in the settings.
    const exId = (await teammate(t, EX, undefined, { emailVerificationTime: 1 }))!;
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("telegramSettings").first())!;
      await ctx.db.patch(row._id, { owners: [...row.owners!, { userId: exId, telegram: "Was_Owner" }] });
    });
    const out = await tell(t, "/task Call back", { username: "Was_Owner", id: 7171 });
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.strangers]);
    expect((await settingsRow(t))?.owners?.[1]).toEqual({ userId: exId, telegram: "Was_Owner" });
    // And they are nobody a task can be given to by that username.
    expect((await tell(t, "/task @Was_Owner Call back", CORA)).tasks).toEqual([]);
    // Made an owner again, the entry is theirs once more.
    vi.stubEnv("OWNER_EMAILS", `${OWNER},${EX}`);
    expect((await tell(t, "/task Call back", { username: "Was_Owner", id: 7171 })).tasks).toHaveLength(1);
  });
});

describe("the Telegram id behind a username", () => {
  test("the first task stores the sender's id beside their record, and when", async () => {
    const { t } = await unlinked();
    expect((await member(t, COFOUNDER))?.telegramUserId).toBeUndefined();
    await tell(t, "/task From Cora", CORA);
    expect(await member(t, COFOUNDER)).toMatchObject({
      telegramUserId: String(CORA.id),
      telegramBoundAt: NOW,
    });
    vi.setSystemTime(NOW + 5000);
    await tell(t, "/task From the owner", OLGA);
    expect((await settingsRow(t))?.owners?.[0]).toMatchObject({
      telegram: OLGA.username,
      telegramUserId: String(OLGA.id),
      telegramBoundAt: NOW + 5000,
    });
  });

  test("nothing but a task binds: help, and a request that adds nothing, leave the username unused", async () => {
    const { t } = await unlinked();
    for (const text of ["/help", "/task Call back by 2026-99-99", "/task @Nobody_Here Call back"]) {
      const out = await tell(t, text, CORA);
      expect(out.tasks).toEqual([]);
      expect(JSON.stringify(out.said)).not.toContain("linked");
    }
    expect((await member(t, COFOUNDER))?.telegramUserId).toBeUndefined();
    expect((await settingsRow(t))?.log).toBeUndefined();
  });

  test("the first task's confirmation says, in the group, that the account is now linked", async () => {
    const { t } = await unlinked();
    const first = await tell(t, "/task @Sam_Sales Call back", { username: "cora_f", id: CORA.id });
    expect(first.said).toEqual([
      `<b>Added</b> to Startup's board for @Sam_Sales: Call back · ${LINK}\n` +
        "First task from @Cora_F: this Telegram account is now linked to them in Startup OS.",
    ]);
    // Only the first: from then on the account is known.
    const second = await tell(t, "/task Another", CORA);
    expect(second.said).toEqual([`<b>Added</b> to Startup's board: Another · ${LINK}`]);
    // The owner's own first task says it too.
    const owners = await tell(t, "/task Mine", OLGA);
    expect(String(owners.said[0]).split("\n")[1]).toBe(
      "First task from @Olga_Owner: this Telegram account is now linked to them in Startup OS.",
    );
  });

  test("each link is written in the settings row's log: fixed words, whose record, when, and no username", async () => {
    const { t } = await unlinked();
    await tell(t, "/task Mine", CORA);
    vi.setSystemTime(NOW + 1000);
    await tell(t, "/task Mine", OLGA);
    await tell(t, "/task Again", CORA);
    const row = (await settingsRow(t))!;
    const cora = (await member(t, COFOUNDER))!;
    expect(row.log).toEqual([
      { event: "linked", at: NOW + 1000, owner: row.owners![0]!.userId },
      { event: "linked", at: NOW, member: cora._id },
    ]);
    expect(JSON.stringify(row.log)).not.toMatch(/cora|olga|770/i);
  });

  test("the log keeps the last twenty", async () => {
    const { t, owner } = await unlinked();
    const row = (await member(t, COFOUNDER))!;
    for (let i = 0; i < 12; i += 1) {
      vi.setSystemTime(NOW + i * 1000);
      await tell(t, `/task Number ${i}`, CORA);
      vi.setSystemTime(NOW + i * 1000 + 500);
      await owner.mutation(api.team.resetTelegram, { id: row._id });
    }
    const log = (await settingsRow(t))!.log!;
    expect(log).toHaveLength(20);
    expect(log[0]).toEqual({ event: "reset", at: NOW + 11_500, member: row._id });
    expect(log[1]).toEqual({ event: "linked", at: NOW + 11_000, member: row._id });
    // The oldest four of the twenty-four are gone.
    expect(log.at(-1)).toEqual({ event: "linked", at: NOW + 2000, member: row._id });
  });

  test("from then on both must match: another account that takes the username is a stranger", async () => {
    const { t } = await unlinked();
    expect((await tell(t, "/task Mine", CORA)).tasks).toHaveLength(1);
    const thief = { username: CORA.username, id: 9999 };
    const out = await tell(t, "/task @Sam_Sales Wire the money", thief);
    expect(out.tasks).toHaveLength(1);
    expect(out.said).toEqual([REPLIES.strangers]);
    expect((await member(t, COFOUNDER))?.telegramUserId).toBe(String(CORA.id));
    // The real person still gets through.
    expect((await tell(t, "/task Mine again", CORA)).tasks).toHaveLength(2);
  });

  test("the same holds for the owner's own", async () => {
    const { t } = await unlinked();
    await tell(t, "/task Mine", OLGA);
    const out = await tell(t, "/task Not mine", { username: OLGA.username, id: 9999 });
    expect(out.tasks).toHaveLength(1);
    expect(out.said).toEqual([REPLIES.strangers]);
  });

  test("a refused message binds nobody", async () => {
    const { t } = await unlinked();
    await tell(t, "/task Call back", { username: "No_Board", id: 3003 });
    expect((await member(t, NO_BOARD))?.telegramUserId).toBeUndefined();
  });

  test("the owner typing a different username for someone clears the id; the same one keeps it", async () => {
    const { t, owner } = await unlinked();
    await tell(t, "/task First", CORA);
    const row = (await member(t, COFOUNDER))!;
    const same = { id: row._id, role: row.role, companies: row.companies, areas: row.areas ?? ["board"] };
    const linked = { telegramUserId: String(CORA.id), telegramBoundAt: NOW };
    await owner.mutation(api.team.update, { ...same, telegram: "@CORA_F" });
    expect(await member(t, COFOUNDER)).toMatchObject(linked);
    await owner.mutation(api.team.update, same);
    expect(await member(t, COFOUNDER)).toMatchObject(linked);
    await owner.mutation(api.team.update, { ...same, telegram: "Cora_New" });
    expect((await member(t, COFOUNDER))?.telegramUserId).toBeUndefined();
    expect((await member(t, COFOUNDER))?.telegramBoundAt).toBeUndefined();
    // The new username is bound by whoever first uses it.
    expect((await tell(t, "/task Hello", { username: "Cora_New", id: 8080 })).tasks).toHaveLength(2);
    expect((await member(t, COFOUNDER))?.telegramUserId).toBe("8080");
  });

  test("the owner changing their own username clears theirs", async () => {
    const { t, owner } = await unlinked();
    await tell(t, "/task Mine", OLGA);
    await owner.mutation(api.telegram.setMine, { telegram: "olga_owner" });
    expect((await settingsRow(t))?.owners?.[0]).toMatchObject({
      telegramUserId: String(OLGA.id),
      telegramBoundAt: NOW,
    });
    await owner.mutation(api.telegram.setMine, { telegram: "Olga_Other" });
    expect((await settingsRow(t))?.owners?.[0]).toEqual({
      userId: expect.any(String),
      telegram: "Olga_Other",
    });
  });

  test("no function sends the id to anyone, the owner included", async () => {
    const { t, owner, cofounder } = await unlinked();
    await tell(t, "/task @Sam_Sales Call back", CORA);
    await tell(t, "/task Mine", OLGA);
    const read = JSON.stringify([
      await owner.query(api.team.list, {}),
      await owner.query(api.telegram.settings, {}),
      await owner.query(api.tasks.board, {}),
      await cofounder.query(api.team.assignable, {}),
      await cofounder.query(api.tasks.board, {}),
    ]);
    expect(read).not.toContain(String(CORA.id));
    expect(read).not.toContain(`"${OLGA.id}"`);
    expect(read).not.toContain("telegramUserId");
  });
});

describe("what the owner is told of each link, and the way to undo one", () => {
  test("the team list says, for each person, whether their username is linked and since when", async () => {
    const { t, owner } = await unlinked();
    vi.setSystemTime(NOW + 5000);
    await tell(t, "/task Mine", CORA);
    const list = await owner.query(api.team.list, {});
    const of = (email: string) => list.find((one) => one.email === email)!;
    expect(of(COFOUNDER)).toMatchObject({ telegramLinked: true, telegramLinkedAt: NOW + 5000 });
    expect(of(US_SALES)).toMatchObject({ telegramLinked: false, telegramLinkedAt: null });
  });

  test("a link from before the date was kept is linked, with no date", async () => {
    const { t, owner } = await unlinked();
    const row = (await member(t, COFOUNDER))!;
    await t.run((ctx) => ctx.db.patch(row._id, { telegramUserId: String(CORA.id) }));
    const list = await owner.query(api.team.list, {});
    expect(list.find((one) => one.email === COFOUNDER)).toMatchObject({
      telegramLinked: true,
      telegramLinkedAt: null,
    });
  });

  test("the settings page is sent who is linked and the log, by name and never by username", async () => {
    const { t, owner } = await unlinked();
    await tell(t, "/task Mine", CORA);
    vi.setSystemTime(NOW + 1000);
    await tell(t, "/task Mine", OLGA);
    const cora = (await member(t, COFOUNDER))!;
    const read = await owner.query(api.telegram.settings, {});
    expect(read.mineLinked).toBe(true);
    expect(read.mineLinkedAt).toBe(NOW + 1000);
    expect(read.people).toContainEqual({
      id: cora._id,
      name: "Cora Founder",
      linked: true,
      linkedAt: NOW,
    });
    expect(read.people).toContainEqual(
      expect.objectContaining({ name: "Sam Sales", linked: false, linkedAt: null }),
    );
    expect(read.people).toHaveLength(4);
    expect(read.log).toEqual([
      { event: "linked", at: NOW + 1000, name: "Olga Owner", gone: false },
      { event: "linked", at: NOW, name: "Cora Founder", gone: false },
    ]);
    // A teammate's username is read on the Team page alone, the owner's own aside.
    expect(JSON.stringify({ ...read, mine: null })).not.toMatch(/Cora_F|Sam_Sales|Erik_Eng|No_Board|Olga_Owner/i);
    // Someone since removed is nobody the log can name.
    await owner.mutation(api.team.remove, { id: cora._id });
    expect((await owner.query(api.telegram.settings, {})).log[1]).toEqual({
      event: "linked",
      at: NOW,
      name: null,
      gone: true,
    });
  });

  test("Reset link clears the Telegram account behind a teammate's username, and the next task links afresh", async () => {
    const { t, owner } = await unlinked();
    await tell(t, "/task Mine", CORA);
    const row = (await member(t, COFOUNDER))!;
    vi.setSystemTime(NOW + 2000);
    expect(await owner.mutation(api.team.resetTelegram, { id: row._id })).toBeNull();
    const after = (await member(t, COFOUNDER))!;
    expect(after.telegram).toBe("Cora_F");
    expect(after.telegramUserId).toBeUndefined();
    expect(after.telegramBoundAt).toBeUndefined();
    expect((await settingsRow(t))?.log?.[0]).toEqual({ event: "reset", at: NOW + 2000, member: row._id });
    // Another account holding the username is now taken for them, and it is said in the group.
    const out = await tell(t, "/task Hello", { username: CORA.username, id: 8080 });
    expect(out.tasks).toHaveLength(2);
    expect(String(out.said[0])).toContain("First task from @Cora_F:");
    expect((await member(t, COFOUNDER))?.telegramUserId).toBe("8080");
  });

  test("resetting a username that was never used changes nothing and logs nothing", async () => {
    const { t, owner } = await unlinked();
    const row = (await member(t, COFOUNDER))!;
    const before = await everythingStored(t);
    await owner.mutation(api.team.resetTelegram, { id: row._id });
    expect(await everythingStored(t)).toBe(before);
  });

  test("the owner resets their own on the Telegram page", async () => {
    const { t, owner } = await unlinked();
    await tell(t, "/task Mine", OLGA);
    vi.setSystemTime(NOW + 2000);
    await owner.mutation(api.telegram.resetMine, {});
    const row = (await settingsRow(t))!;
    expect(row.owners).toEqual([{ userId: row.owners![0]!.userId, telegram: "Olga_Owner" }]);
    expect(row.log?.[0]).toEqual({ event: "reset", at: NOW + 2000, owner: row.owners![0]!.userId });
    expect((await owner.query(api.telegram.settings, {})).mineLinked).toBe(false);
  });

  test("resetting is the owner's alone", async () => {
    const { t, cofounder } = await unlinked();
    await tell(t, "/task Mine", SAM);
    const row = (await member(t, US_SALES))!;
    await expect(cofounder.mutation(api.team.resetTelegram, { id: row._id })).rejects.toThrow("not_owner");
    await expect(cofounder.mutation(api.telegram.resetMine, {})).rejects.toThrow("not_owner");
    expect((await member(t, US_SALES))?.telegramUserId).toBe(String(SAM.id));
  });

  test("someone no longer on the team cannot be reset", async () => {
    const { t, owner } = await unlinked();
    const row = (await member(t, US_SALES))!;
    await owner.mutation(api.team.remove, { id: row._id });
    await expect(owner.mutation(api.team.resetTelegram, { id: row._id })).rejects.toThrow(
      "That person is no longer on the team.",
    );
  });
});

describe("only the owner sets or resets anyone's Telegram username and link", () => {
  const OWNERS = "Only the owner sets or resets a Telegram username.";
  /** Sam, on Startup, is given the Team page by the owner. */
  const withManager = async (linked = true) => {
    const started = await start({}, { linked });
    await started.t.run(async (ctx) => {
      const row = await ctx.db.query("members").withIndex("by_email", (q) => q.eq("email", US_SALES)).first();
      await ctx.db.patch(row!._id, { areas: ["board", "team"], companies: ["us", "kz"] });
    });
    const manager = await signInAs(started.t, { email: US_SALES, emailVerificationTime: 1 });
    return { ...started, manager };
  };
  const rowArgs = async (t: TestBackend, email: string) => {
    const row = (await member(t, email))!;
    return { id: row._id, role: row.role, companies: row.companies, areas: row.areas ?? ["product", "board"] };
  };

  test("the reviewer's scenario: a manager cannot point a teammate's username at an account of their own and add tasks as them", async () => {
    const { t, manager } = await withManager();
    const erik = await rowArgs(t, KZ_ENGINEER);
    const MINE = { username: "Managers_Other", id: 880001 };
    // 1. It fails at the username change.
    await expect(
      manager.mutation(api.team.update, { ...erik, telegram: MINE.username }),
    ).rejects.toThrow(OWNERS);
    expect(await member(t, KZ_ENGINEER)).toMatchObject({
      telegram: ERIK.username,
      telegramUserId: String(ERIK.id),
    });
    // 2. Nor can they free Erik's own username for whoever uses it next.
    await expect(manager.mutation(api.team.resetTelegram, { id: erik.id })).rejects.toThrow("not_owner");
    // 3. So the other account is a stranger to the bot, and Erik is still Erik.
    const out = await tell(t, "/task @Cora_F Wire the money", MINE, KZ);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.strangers]);
    expect((await tell(t, "/task Mine", ERIK, KZ)).tasks).toHaveLength(1);
  });

  test("a manager's change that names a username at all is refused: a new one, the same one, blank or null", async () => {
    const { t, manager } = await withManager();
    const erik = await rowArgs(t, KZ_ENGINEER);
    const before = await member(t, KZ_ENGINEER);
    for (const telegram of ["Another_Name", ERIK.username, "", null]) {
      await expect(manager.mutation(api.team.update, { ...erik, telegram })).rejects.toThrow(OWNERS);
    }
    expect(await member(t, KZ_ENGINEER)).toEqual(before);
    // The rest of the row is still theirs to change, the username left as it is.
    await manager.mutation(api.team.update, { ...erik, areas: ["board"] });
    expect(await member(t, KZ_ENGINEER)).toMatchObject({ areas: ["board"], telegram: ERIK.username });
  });

  test("nor can a manager add someone with one", async () => {
    const { t, manager } = await withManager();
    const NEW = { email: "new.person@gmail.com", role: "sales" as const, companies: ["us" as const], areas: ["board"] };
    for (const telegram of ["New_Person", ""]) {
      await expect(manager.mutation(api.team.add, { ...NEW, telegram })).rejects.toThrow(OWNERS);
    }
    expect(await member(t, "new.person@gmail.com")).toBeNull();
    await manager.mutation(api.team.add, NEW);
    expect((await member(t, "new.person@gmail.com"))?.telegram).toBeUndefined();
  });

  test("the owner still does all of it", async () => {
    const { t, owner } = await withManager();
    const erik = await rowArgs(t, KZ_ENGINEER);
    await owner.mutation(api.team.resetTelegram, { id: erik.id });
    expect((await member(t, KZ_ENGINEER))?.telegramUserId).toBeUndefined();
    await owner.mutation(api.team.update, { ...erik, telegram: "Erik_New" });
    expect((await member(t, KZ_ENGINEER))?.telegram).toBe("Erik_New");
  });

  test("a manager still reads the username and whether it is linked, for the people they are sent", async () => {
    const { t, manager } = await withManager();
    const list = await manager.query(api.team.list, {});
    expect(list.find((person) => person.email === KZ_ENGINEER)).toMatchObject({
      telegram: ERIK.username,
      telegramLinked: true,
    });
    expect(await member(t, KZ_ENGINEER)).not.toBeNull();
  });
});

describe("a Telegram username belongs to one record", () => {
  const TAKEN = "That Telegram username is already on another record.";
  const same = async (t: TestBackend, email: string) => {
    const row = (await member(t, email))!;
    return { id: row._id, role: row.role, companies: row.companies, areas: row.areas ?? ["board"] };
  };

  test("the reviewer's scenario: nobody can be given the owner's username, so the owner is not locked out of the bot", async () => {
    const { t, owner } = await start();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("members").withIndex("by_email", (q) => q.eq("email", US_SALES)).first();
      await ctx.db.patch(row!._id, { areas: ["board", "team"] });
    });
    const manager = await signInAs(t, { email: US_SALES, emailVerificationTime: 1 });
    const erik = await same(t, KZ_ENGINEER);
    for (const telegram of ["Olga_Owner", "@olga_owner", "OLGA_OWNER"]) {
      for (const who of [manager, owner]) {
        await expect(who.mutation(api.team.update, { ...erik, telegram })).rejects.toThrow();
      }
      await expect(owner.mutation(api.team.update, { ...erik, telegram })).rejects.toThrow(TAKEN);
    }
    expect((await member(t, KZ_ENGINEER))?.telegram).toBe(ERIK.username);
    // The owner's username is still one person's: the bot takes the owner for the owner.
    const out = await tell(t, "/task From the owner", OLGA);
    expect(out.tasks).toHaveLength(1);
  });

  test("nor another teammate's, whatever its capitals, when changing someone or adding them", async () => {
    const { t, owner } = await start();
    const erik = await same(t, KZ_ENGINEER);
    await expect(owner.mutation(api.team.update, { ...erik, telegram: "cora_f" })).rejects.toThrow(TAKEN);
    await expect(
      owner.mutation(api.team.add, {
        email: "new.person@gmail.com",
        role: "sales",
        companies: ["us"],
        areas: ["board"],
        telegram: "@SAM_SALES",
      }),
    ).rejects.toThrow(TAKEN);
    expect(await member(t, "new.person@gmail.com")).toBeNull();
    expect((await tell(t, "/task Still Cora", CORA)).tasks).toHaveLength(1);
  });

  test("the owner cannot take a teammate's for their own", async () => {
    const { t, owner } = await start();
    await expect(owner.mutation(api.telegram.setMine, { telegram: "@Cora_f" })).rejects.toThrow(TAKEN);
    expect((await settingsRow(t))?.owners?.[0]?.telegram).toBe(OLGA.username);
  });

  test("a second owner cannot take the first one's", async () => {
    const { t } = await start();
    const SECOND = "second.owner@example.test";
    vi.stubEnv("OWNER_EMAILS", `${OWNER},${SECOND}`);
    const second = await signInAs(t, { email: SECOND, emailVerificationTime: 1 });
    await expect(second.mutation(api.telegram.setMine, { telegram: "olga_owner" })).rejects.toThrow(TAKEN);
    await second.mutation(api.telegram.setMine, { telegram: "Second_Owner" });
    expect((await settingsRow(t))?.owners).toHaveLength(2);
  });

  test("a record keeps its own: saved again as it is, or in other capitals, by the teammate's row or the owner's entry", async () => {
    const { t, owner } = await start();
    const cora = await same(t, COFOUNDER);
    await owner.mutation(api.team.update, { ...cora, telegram: "@CORA_F" });
    expect((await member(t, COFOUNDER))?.telegram).toBe("CORA_F");
    await owner.mutation(api.telegram.setMine, { telegram: "olga_owner" });
    expect((await settingsRow(t))?.owners?.[0]?.telegram).toBe("olga_owner");
  });

  test("a username given up is free again", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.update, { ...(await same(t, COFOUNDER)), telegram: "" });
    await owner.mutation(api.team.update, { ...(await same(t, KZ_ENGINEER)), telegram: "Cora_F" });
    expect((await member(t, KZ_ENGINEER))?.telegram).toBe("Cora_F");
  });

  test("the refusal says only that it is on another record: not whose, and not which kind", async () => {
    const { t, owner } = await start();
    const erik = await same(t, KZ_ENGINEER);
    const said = async (telegram: string) => {
      try {
        await owner.mutation(api.team.update, { ...erik, telegram });
      } catch (error) {
        // The whole of what is thrown: the sentence, with nothing added to it.
        return String((error as { data?: unknown }).data).replace(/^"|"$/g, "");
      }
      return "no refusal";
    };
    expect(await said("Olga_Owner")).toBe(TAKEN);
    expect(await said("Cora_F")).toBe(TAKEN);
  });
});

// ── Who for ─────────────────────────────────────────────────────────────────

describe("the assignee", () => {
  test("a username nobody on the team has: nothing is added, and it is said back safely", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Some_Stranger Call back");
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([
      "I do not know ＠Some_Stranger as a teammate on this board. Nothing was added.",
    ]);
  });

  test("what follows the @ is said back escaped, never an address", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @<b>x</b> Call back");
    expect(out.tasks).toEqual([]);
    expect(String(out.said[0])).toContain("＠&lt;b&gt;x&lt;/b&gt;");
    expect(JSON.stringify(out.said)).not.toMatch(/gmail|startup\.ai/);
  });

  test("a teammate who is not on the group's company is refused as the board refuses them", async () => {
    const { t } = await start();
    // Cora is on both; Erik is on Globex alone; the group is Startup's.
    const out = await tell(t, "/task @Erik_Eng Call back", CORA, US);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual(["I do not know ＠Erik_Eng as a teammate on this board. Nothing was added."]);
  });

  test("the group cannot tell a teammate of the other company from nobody at all", async () => {
    const { t } = await start();
    // In Startup's group, three names: Erik is on Globex alone, the second is
    // nobody's, the third is Erik's in other capitals. Whoever asks, the
    // answers differ only in the name, said back exactly as it was typed.
    const reply = async (typed: string, from: Sender) =>
      String((await tell(t, `/task @${typed} Call back`, from, US)).said[0]);
    const shape = (text: string, typed: string) => text.replace(`＠${typed}`, "＠…");
    for (const from of [CORA, SAM, OLGA]) {
      const real = await reply("Erik_Eng", from);
      const nobody = await reply("Erik_Enx", from);
      const lower = await reply("erik_eng", from);
      expect(shape(real, "Erik_Eng")).toBe("I do not know ＠… as a teammate on this board. Nothing was added.");
      expect(shape(nobody, "Erik_Enx")).toBe(shape(real, "Erik_Eng"));
      // Not corrected to the capitals on record: that too would say the name is someone's.
      expect(lower).toContain("＠erik_eng");
    }
    expect(await tasks(t)).toEqual([]);
  });

  test("someone the sender shares no company with is not even known to them", async () => {
    const { t } = await start();
    // Sam (Startup alone) names Erik (Globex alone), with a shared task.
    const out = await tell(t, "/task @Erik_Eng #both Call back", SAM, US);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual(["I do not know ＠Erik_Eng as a teammate on this board. Nothing was added."]);
  });

  test("who a task may go to is the board's own rule alone (`createTask`): someone the sender does not know gets the one answer", async () => {
    // One group for both companies, where an untagged task is shared: no
    // company stands between the sender and someone they share none with.
    const { t } = await start({ chatKz: US, untaggedBoard: "both" });
    const make = vi.spyOn(board, "createTask");
    // Sam is on Startup alone, Erik on Globex alone.
    for (const text of ["@madeup_bot @Erik_Eng call the clinic", "/task @Erik_Eng #both Call the clinic"]) {
      const out = await tell(t, text, SAM, US);
      expect(out.tasks).toEqual([]);
      expect(out.said).toEqual(["I do not know ＠Erik_Eng as a teammate on this board. Nothing was added."]);
    }
    // Asked of the board, which refused: no second copy of its rule here.
    expect(make).toHaveBeenCalledTimes(2);
    // Someone Sam does know is passed on to the board as usual.
    expect((await tell(t, "@madeup_bot @Cora_F call the clinic", SAM, US)).tasks).toHaveLength(1);
    expect(make).toHaveBeenCalledTimes(3);
  });

  test("the owner can be given a task, tagged by their own username", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @olga_owner Sign the lease", SAM);
    expect(out.tasks[0]).toMatchObject({ assignee: OWNER });
    expect(String(out.said[0])).toContain("for @Olga_Owner: Sign the lease");
  });

  test("someone giving a task to themselves is confirmed like any other", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot @Cora_F write the update", CORA);
    expect(out.tasks[0]).toMatchObject({ assignee: COFOUNDER });
    expect(out.said).toHaveLength(1);
  });
});

// ── Which board ─────────────────────────────────────────────────────────────

describe("which board the task goes on", () => {
  test("the group's company", async () => {
    const { t } = await start();
    expect((await tell(t, "/task For Startup", CORA, US)).tasks[0]!.company).toBe("us");
    const out = await tell(t, "/task @Erik_Eng For Globex", CORA, KZ);
    expect(out.tasks[1]).toMatchObject({ company: "kz", assignee: KZ_ENGINEER });
    expect(String(out.said[0])).toContain("<b>Added</b> to Globex's board for @Erik_Eng: For Globex");
  });

  test("one group for both companies: an untagged task goes to Globex's board unless the owner says otherwise", async () => {
    const { t } = await start({ chatKz: US });
    const out = await tell(t, "/task @Erik_Eng For Globex", CORA, US);
    expect(out.tasks[0]).toMatchObject({ company: "kz", assignee: KZ_ENGINEER });
    expect(String(out.said[0])).toContain("<b>Added</b> to Globex's board for @Erik_Eng: For Globex");
  });

  test.each([
    ["kz", "kz", "Globex's board"],
    ["us", "us", "Startup's board"],
    ["both", undefined, "both boards"],
  ] as const)("one group for both, the owner's setting %s", async (untaggedBoard, company, words) => {
    const { t } = await start({ chatKz: US, untaggedBoard });
    const out = await tell(t, "@madeup_bot @Cora_F plan the week", CORA, US);
    expect(out.tasks[0]!.company).toBe(company);
    expect(String(out.said[0])).toContain(`<b>Added</b> to ${words} for @Cora_F: plan the week`);
  });

  test("the setting is for a group that serves both: a one-company group keeps its own", async () => {
    const { t } = await start({ untaggedBoard: "kz" });
    expect((await tell(t, "/task For Startup", CORA, US)).tasks[0]!.company).toBe("us");
    const other = await start({ untaggedBoard: "us" });
    expect((await tell(other.t, "/task For Globex", CORA, KZ)).tasks[0]!.company).toBe("kz");
  });

  test("a hashtag still overrides it", async () => {
    const { t } = await start({ chatKz: US });
    expect((await tell(t, "/task #startup For Startup", CORA, US)).tasks[0]!.company).toBe("us");
    expect((await tell(t, "/task #both For all", CORA, US)).tasks[1]!.company).toBeUndefined();
  });

  test("in the shared group, someone on Startup alone is told where an untagged task goes and what to add", async () => {
    const { t } = await start({ chatKz: US });
    const out = await tell(t, "@madeup_bot call the clinic", SAM, US);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([untaggedRefusal("kz", "us")]);
    expect((await tell(t, "@madeup_bot #startup call the clinic", SAM, US)).tasks).toHaveLength(1);
  });

  test("in the shared group, an untagged task for someone not on Globex is refused", async () => {
    const { t } = await start({ chatKz: US });
    const out = await tell(t, "@madeup_bot @Sam_Sales call the clinic", CORA, US);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual(["I do not know ＠Sam_Sales as a teammate on this board. Nothing was added."]);
  });

  test.each([
    ["#startup", "us", "Startup's board"],
    ["#us", "us", "Startup's board"],
    ["#globex", "kz", "Globex's board"],
    ["#GlobexAI", "kz", "Globex's board"],
    ["#kz", "kz", "Globex's board"],
    ["#both", undefined, "both boards"],
    ["#shared", undefined, "both boards"],
  ])("%s overrides the group's company and is not in the title", async (tag, company, words) => {
    const { t } = await start();
    const out = await tell(t, `@madeup_bot @Cora_F ${tag} call the clinic`, CORA, US);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]!.title).toBe("call the clinic");
    expect(out.tasks[0]!.company).toBe(company);
    expect(out.said).toEqual([`<b>Added</b> to ${words} for @Cora_F: call the clinic · ${LINK}`]);
  });

  test("the same with /task, from the other company's group", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Sam_Sales call back #startup", CORA, KZ);
    expect(out.tasks[0]).toMatchObject({ title: "call back", company: "us", assignee: US_SALES });
  });

  test("a hashtag that is no company's stays in the title", async () => {
    const { t } = await start();
    const out = await tell(t, "/task #urgent fix the #kzt report #globex");
    expect(out.tasks[0]).toMatchObject({ title: "#urgent fix the #kzt report", company: "kz" });
  });

  test("two different boards named: nothing is added, and one line asks for one", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot #startup #globex call back");
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.oneBoard]);
  });

  test("a sender who is not on the named company cannot add to its board", async () => {
    const { t } = await start();
    const out = await tell(t, "/task #globex call back", SAM, US);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([REPLIES.notYourBoard]);
  });

  test("nor on the group's own company when they are not on it", async () => {
    const { t } = await start();
    const out = await tell(t, "/task call back", SAM, KZ);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual([untaggedRefusal("kz", "us")]);
    // Naming their own company from that group is allowed.
    expect((await tell(t, "/task call back #startup", SAM, KZ)).tasks[0]!.company).toBe("us");
  });

  test("an assignee who is not on the named company: nothing is added", async () => {
    const { t } = await start();
    const out = await tell(t, "@madeup_bot @Sam_Sales #globex call the clinic", CORA, US);
    expect(out.tasks).toEqual([]);
    expect(out.said).toEqual(["I do not know ＠Sam_Sales as a teammate on this board. Nothing was added."]);
  });

  test("anyone with the board may add a shared task, for anyone they know", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Cora_F #both plan the offsite", SAM, US);
    expect(out.tasks[0]!.company).toBeUndefined();
    expect(out.tasks[0]!.assignee).toBe(COFOUNDER);
  });
});

describe("the owner's setting for an untagged task", () => {
  test("is Globex's board until the owner says otherwise", async () => {
    const { owner } = await start();
    expect((await owner.query(api.telegram.settings, {})).untagged).toBe("kz");
  });

  test.each(["us", "kz", "both"] as const)("saved as %s, and kept by a save that does not name it", async (untagged) => {
    const { t, owner } = await start();
    await owner.mutation(api.telegram.save, { enabled: true, chatUs: US.id, chatKz: US.id, untagged });
    expect((await owner.query(api.telegram.settings, {})).untagged).toBe(untagged);
    await owner.mutation(api.telegram.save, { enabled: true, chatUs: US.id, chatKz: US.id });
    expect((await settingsRow(t))?.untaggedBoard).toBe(untagged);
  });

  test("not for a teammate without the settings area", async () => {
    const { cofounder } = await start();
    await expect(
      cofounder.mutation(api.telegram.save, { enabled: true, chatUs: null, chatKz: null, untagged: "us" }),
    ).rejects.toThrow("not_allowed");
  });
});

// ── Twice, and too often ────────────────────────────────────────────────────

describe("an update delivered twice", () => {
  test("adds one task and is confirmed once", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    const once = update("/task @Sam_Sales Call back");
    for (let i = 0; i < 3; i += 1) expect((await deliver(t, once)).status).toBe(200);
    expect(await tasks(t)).toHaveLength(1);
    expect(replies(calls)).toHaveLength(1);
  });

  test("another update with the same words is another task", async () => {
    const { t } = await start();
    stubTelegram();
    await deliver(t, update("/task Call back"));
    await deliver(t, update("/task Call back"));
    expect(await tasks(t)).toHaveLength(2);
  });

  test("what is remembered of an update is its id and nothing typed; old ones are forgotten", async () => {
    const { t } = await start();
    stubTelegram();
    await deliver(t, update("/task SECRET title one"));
    const inbox = () => t.run((ctx) => ctx.db.query("telegramInbox").collect());
    expect(JSON.stringify(await inbox())).not.toMatch(/SECRET|Cora/);
    expect((await inbox()).map((row) => row.kind).sort()).toEqual(["task", "update"]);
    vi.setSystemTime(NOW + 49 * HOUR);
    await deliver(t, update("/task SECRET title two"));
    expect(await inbox()).toHaveLength(2);
    expect((await inbox()).every((row) => row.at === NOW + 49 * HOUR)).toBe(true);
  });
});

describe("limits", () => {
  const many = async (t: TestBackend, count: number, chat = US) => {
    for (let i = 0; i < count; i += 1) await deliver(t, update(`/task Task ${i}`, CORA, chat));
  };

  test("thirty tasks an hour from one group; the next is refused once, in fixed words", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    await many(t, TASKS_PER_CHAT_PER_HOUR);
    expect(await tasks(t)).toHaveLength(TASKS_PER_CHAT_PER_HOUR);
    await many(t, 3);
    expect(await tasks(t)).toHaveLength(TASKS_PER_CHAT_PER_HOUR);
    expect(said(calls).filter((reply) => reply === REPLIES.limit)).toHaveLength(1);
    expect(replies(calls)).toHaveLength(TASKS_PER_CHAT_PER_HOUR + 1);
    // The other group has its own count, and an hour later this one can again.
    await many(t, 1, KZ);
    expect(await tasks(t)).toHaveLength(TASKS_PER_CHAT_PER_HOUR + 1);
    vi.setSystemTime(NOW + HOUR + 1);
    await many(t, 1);
    expect(await tasks(t)).toHaveLength(TASKS_PER_CHAT_PER_HOUR + 2);
  });

  test("a hundred a day through Telegram, across groups", async () => {
    const { t } = await start();
    stubTelegram();
    // Spread over hours and both groups, so no hourly limit is met.
    for (let hour = 0; hour < 2; hour += 1) {
      vi.setSystemTime(NOW + hour * (HOUR + 1));
      await many(t, 25, US);
      await many(t, 25, KZ);
    }
    expect(await tasks(t)).toHaveLength(TASKS_PER_DAY);
    vi.setSystemTime(NOW + 3 * HOUR);
    const calls = stubTelegram();
    await many(t, 2);
    expect(await tasks(t)).toHaveLength(TASKS_PER_DAY);
    expect(said(calls)).toEqual([REPLIES.limit]);
    vi.setSystemTime(NOW + 26 * HOUR);
    await many(t, 1);
    expect(await tasks(t)).toHaveLength(TASKS_PER_DAY + 1);
  });

  test("ten other replies an hour to one group, then silence; tasks are still added and confirmed", async () => {
    const { t } = await start();
    const calls = stubTelegram();
    for (let i = 0; i < REPLIES_PER_CHAT_PER_HOUR + 5; i += 1) await deliver(t, update("/help"));
    expect(replies(calls)).toHaveLength(REPLIES_PER_CHAT_PER_HOUR);
    await deliver(t, update("/task Still works"));
    expect(await tasks(t)).toHaveLength(1);
    expect(replies(calls)).toHaveLength(REPLIES_PER_CHAT_PER_HOUR + 1);
  });
});

// ── The owner's own switch ──────────────────────────────────────────────────

describe("commands are off unless the owner turned them on", () => {
  const commands = async (owner: Awaited<ReturnType<typeof signInAsOwner>>) =>
    (await owner.query(api.telegram.settings, {})).commands;
  const OFF = [
    ["never turned on", undefined],
    ["turned off", false],
  ] as const;

  test.each(OFF)("%s: a valid update writes nothing and is answered with nothing but 200", async (_what, wanted) => {
    const { t } = await start({ commandsWanted: wanted });
    const calls = stubTelegram();
    const before = await everythingStored(t);
    for (const body of [
      update("/task @Sam_Sales Call back", CORA),
      update("@madeup_bot do it", OLGA),
      update("/help", CORA),
      update("/task spam", STRANGER),
      // Nor is a group remembered or forgotten.
      membership(-9001, "A group", CORA),
      membership(Number(US.id), US.title, null, "kicked"),
    ]) {
      const response = await deliver(t, body);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    }
    await finishScheduled(t);
    expect(await tasks(t)).toEqual([]);
    expect(await everythingStored(t)).toBe(before);
    expect(calls).toEqual([]);
  });

  test("the secret is still checked first", async () => {
    const { t } = await start({ commandsWanted: false });
    const response = await deliver(t, update("/task Call back"), {
      "X-Telegram-Bot-Api-Secret-Token": "a".repeat(64),
    });
    expect(response.status).toBe(401);
  });

  test("turning on is the owner's word at once, before Telegram is asked anything", async () => {
    const { t, owner } = await start({ commandsWanted: undefined });
    const calls = stubTelegram();
    await owner.mutation(api.telegramInbound.commandsOn, {});
    expect((await settingsRow(t))?.commandsWanted).toBe(true);
    expect(calls).toEqual([]);
    expect((await tell(t, "/task Call back")).tasks).toHaveLength(1);
  });

  test("turning off is the owner's word first, then deleteWebhook", async () => {
    const { t, owner } = await start();
    const calls = stubTelegram();
    await owner.mutation(api.telegramInbound.commandsOff, {});
    // Already off here, with nothing yet asked of Telegram.
    expect((await settingsRow(t))?.commandsWanted).toBe(false);
    expect(calls).toEqual([]);
    await deliver(t, update("/task Call back"));
    expect(await tasks(t)).toEqual([]);
    await finishScheduled(t);
    expect(calls.map((call) => call.method)).toEqual(["getMe", "deleteWebhook", "getWebhookInfo"]);
  });

  test("off stays off when Telegram would not remove the webhook and goes on sending updates", async () => {
    const { t, owner } = await start({ commands: { state: "on", pending: 0, checkedAt: 1 } });
    stubTelegram({ deleteWebhook: json({ ok: false, description: "SECRET" }, 400) });
    await owner.mutation(api.telegramInbound.commandsOff, {});
    await finishScheduled(t);
    const read = await commands(owner);
    // The page says both: what the owner wants, and that Telegram was not told.
    expect(read).toMatchObject({ wanted: false, state: "on", error: TELEGRAM_FAILURES.webhook });
    const calls = stubTelegram();
    const before = await everythingStored(t);
    await deliver(t, update("/task @Sam_Sales Call back", CORA));
    expect(await tasks(t)).toEqual([]);
    expect(await everythingStored(t)).toBe(before);
    expect(calls).toEqual([]);
  });

  test("a webhook set again from elsewhere does not turn commands back on", async () => {
    const { t, owner } = await start({ commandsWanted: false });
    stubTelegram({ getWebhookInfo: result({ url: HOOK, pending_update_count: 0 }) });
    // Checking reads Telegram's state and leaves the owner's word alone.
    await owner.mutation(api.telegramInbound.checkCommands, {});
    await finishScheduled(t);
    expect(await commands(owner)).toMatchObject({ wanted: false, state: "on" });
    await deliver(t, update("/task Call back"));
    expect(await tasks(t)).toEqual([]);
  });

  test("turning on stays the owner's word when Telegram refuses the webhook", async () => {
    const { t, owner } = await start({ commandsWanted: undefined });
    stubTelegram({ setWebhook: json({ ok: false }, 400) });
    await owner.mutation(api.telegramInbound.commandsOn, {});
    await finishScheduled(t);
    expect(await commands(owner)).toMatchObject({ wanted: true, error: TELEGRAM_FAILURES.webhook });
  });

  test.each(["commandsOn", "commandsOff"] as const)(
    "%s refused for want of a token changes nothing",
    async (name) => {
      const { t, owner } = await start();
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const before = await everythingStored(t);
      await expect(owner.mutation(api.telegramInbound[name], {})).rejects.toThrow(NO_TOKEN);
      expect(await everythingStored(t)).toBe(before);
    },
  );
});

// ── Turning it on ───────────────────────────────────────────────────────────

describe("commands on and off", () => {
  const commands = async (owner: Awaited<ReturnType<typeof signInAsOwner>>) =>
    (await owner.query(api.telegram.settings, {})).commands;

  test("before anything: unknown, not wanted, and not working", async () => {
    const { owner } = await start({ commandsWanted: undefined });
    expect(await commands(owner)).toEqual({
      wanted: false,
      failure: null,
      failureAt: null,
      state: "unknown",
      pending: null,
      deliveryError: null,
      deliveryErrorAt: null,
      checkedAt: null,
      working: false,
      error: null,
    });
  });

  test("turning on: getMe, then setWebhook with the route's address, the derived secret and two kinds of update", async () => {
    const { t, owner } = await start({ botUsername: undefined });
    const calls = stubTelegram({
      getWebhookInfo: result({ url: HOOK, pending_update_count: 2, ip_address: "SECRET" }),
    });
    await owner.mutation(api.telegramInbound.commandsOn, {});
    expect((await commands(owner)).working).toBe(true);
    await finishScheduled(t);
    expect(calls.map((call) => call.method)).toEqual(["getMe", "setWebhook", "getWebhookInfo"]);
    expect(calls[1]!.body).toEqual({
      url: HOOK,
      secret_token: await webhookSecret(TOKEN),
      allowed_updates: ["message", "my_chat_member"],
      // What was said while commands were off is not acted on when they come on.
      drop_pending_updates: true,
    });
    const read = await owner.query(api.telegram.settings, {});
    expect(read.botUsername).toBe(BOT);
    expect(read.commands).toEqual({
      wanted: true,
      failure: null,
      failureAt: null,
      state: "on",
      pending: 2,
      deliveryError: null,
      deliveryErrorAt: null,
      checkedAt: expect.any(Number),
      working: false,
      error: null,
    });
    expect(read.commands.checkedAt).toBeGreaterThanOrEqual(NOW);
    // The secret is asked of Telegram and kept nowhere here.
    const stored = await everythingStored(t);
    expect(stored).not.toContain(await webhookSecret(TOKEN));
    expect(stored).not.toMatch(/SENTINEL|SECRET|api\.telegram\.org/);
    expect(JSON.stringify(read)).not.toContain(await webhookSecret(TOKEN));
  });

  test("turning off: deleteWebhook, then off", async () => {
    const { t, owner } = await start({ commands: { state: "on", pending: 0, checkedAt: 1 } });
    const calls = stubTelegram();
    await owner.mutation(api.telegramInbound.commandsOff, {});
    await finishScheduled(t);
    expect(calls.map((call) => call.method)).toEqual(["getMe", "deleteWebhook", "getWebhookInfo"]);
    expect(await commands(owner)).toMatchObject({ state: "off", working: false, error: null });
  });

  test("checking: what Telegram says of the webhook, the last failed delivery in fixed words", async () => {
    const { t, owner } = await start();
    const calls = stubTelegram({
      getWebhookInfo: result({
        url: HOOK,
        pending_update_count: 4,
        last_error_date: 1_791_000_000,
        last_error_message: "SECRET wrong response from the webhook: 500",
      }),
    });
    await owner.mutation(api.telegramInbound.checkCommands, {});
    await finishScheduled(t);
    expect(calls.map((call) => call.method)).toEqual(["getMe", "getWebhookInfo"]);
    expect(await commands(owner)).toMatchObject({
      state: "on",
      pending: 4,
      deliveryError: TELEGRAM_FAILURES.delivery,
      deliveryErrorAt: 1_791_000_000_000,
    });
    expect(await everythingStored(t)).not.toContain("SECRET");
  });

  test("a webhook that points somewhere else is said, and its address is not kept", async () => {
    const { t, owner } = await start();
    stubTelegram({ getWebhookInfo: result({ url: "https://SECRET.example/hook", pending_update_count: 0 }) });
    await owner.mutation(api.telegramInbound.checkCommands, {});
    await finishScheduled(t);
    expect((await commands(owner)).state).toBe("elsewhere");
    expect(await everythingStored(t)).not.toContain("SECRET");
  });

  test.each([
    ["a refused token", { getMe: json({ ok: false }, 401) }, TELEGRAM_FAILURES.token],
    ["a refused webhook", { setWebhook: json({ ok: false, description: `bad ${HOOK} SENTINEL` }, 400) }, TELEGRAM_FAILURES.webhook],
    ["no network", { setWebhook: new TypeError(`failed https://api.telegram.org/bot${TOKEN}/setWebhook`) }, TELEGRAM_FAILURES.unreachable],
    ["no answer about the webhook", { getWebhookInfo: json({}, 500) }, TELEGRAM_FAILURES.other],
  ] as [string, Record<string, Answer>, string][])(
    "%s is said in fixed words, with no token or secret kept",
    async (_what, answers, sentence) => {
      const { t, owner } = await start();
      stubTelegram(answers);
      await owner.mutation(api.telegramInbound.commandsOn, {});
      await finishScheduled(t);
      expect(await commands(owner)).toMatchObject({ working: false, error: sentence });
      const stored = await everythingStored(t);
      expect(stored).not.toMatch(/SENTINEL|api\.telegram\.org/);
      expect(stored).not.toContain(await webhookSecret(TOKEN));
    },
  );

  test("a later success clears the failure", async () => {
    const { t, owner } = await start({ commandsError: TELEGRAM_FAILURES.webhook });
    stubTelegram({ getWebhookInfo: result({ url: HOOK, pending_update_count: 0 }) });
    await owner.mutation(api.telegramInbound.commandsOn, {});
    await finishScheduled(t);
    expect(await commands(owner)).toMatchObject({ state: "on", error: null });
  });

  test.each(["commandsOn", "commandsOff", "checkCommands"] as const)(
    "%s without the token is refused and starts nothing",
    async (name) => {
      const { t, owner } = await start();
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const calls = stubTelegram();
      await expect(owner.mutation(api.telegramInbound[name], {})).rejects.toThrow(NO_TOKEN);
      expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
      expect(calls).toEqual([]);
    },
  );

  test("turning on without an https address for Telegram to call is refused", async () => {
    const { t, owner } = await start();
    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
    await expect(owner.mutation(api.telegramInbound.commandsOn, {})).rejects.toThrow(
      TELEGRAM_FAILURES.noSite,
    );
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  test.each(["commandsOn", "commandsOff", "checkCommands"] as const)("%s is not for a teammate without the settings area", async (name) => {
    const { cofounder } = await start();
    await expect(cofounder.mutation(api.telegramInbound[name], {})).rejects.toThrow("not_allowed");
  });
});

// ── Find my groups, in both modes ───────────────────────────────────────────

describe("Find my groups", () => {
  const GROUP = { id: -100123, title: "Startup team", type: "supergroup" };
  /** What was asked of Telegram, the counting of each group's members aside. */
  const asked = (calls: Call[]) =>
    calls.map((call) => call.method).filter((method) => method !== "getChatMemberCount");

  test("with no webhook: getMe, the webhook's state, then getUpdates as before; the bot's name is stored", async () => {
    const { t, owner } = await start({ botUsername: undefined });
    const calls = stubTelegram({
      getUpdates: result([
        { update_id: 1, message: { text: "SECRET", chat: GROUP, from: { id: 1, username: "cora_f" } } },
      ]),
    });
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect(asked(calls)).toEqual(["getMe", "getWebhookInfo", "getUpdates"]);
    const read = await owner.query(api.telegram.settings, {});
    expect(read).toMatchObject({ botUsername: BOT, finding: false, findError: null });
    expect(read.found).toEqual([
      { id: "-100123", title: "Startup team", type: "supergroup", members: 7 },
    ]);
    expect(read.commands.state).toBe("off");
    expect(await everythingStored(t)).not.toContain("SECRET");
  });

  test("with a webhook: getUpdates is never asked, and the stored list is kept", async () => {
    const kept = [{ id: "-9", title: "Seen by the webhook", type: "group" as const }];
    const { t, owner } = await start({ found: kept });
    const calls = stubTelegram({ getWebhookInfo: result({ url: HOOK, pending_update_count: 0 }) });
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect(asked(calls)).toEqual(["getMe", "getWebhookInfo"]);
    // The groups on offer are counted: the one listed and the two picked.
    expect(calls.filter((call) => call.method === "getChatMemberCount").map((call) => call.body)).toEqual(
      expect.arrayContaining([{ chat_id: "-9" }, { chat_id: US.id }, { chat_id: KZ.id }]),
    );
    const read = await owner.query(api.telegram.settings, {});
    expect(read).toMatchObject({
      finding: false,
      findError: null,
      found: [{ ...kept[0], members: 7 }],
    });
    expect(read.commands.state).toBe("on");
  });

  test("with a webhook and nothing seen yet: an empty list, not a failure", async () => {
    const { t, owner } = await start();
    stubTelegram({ getWebhookInfo: result({ url: HOOK, pending_update_count: 0 }) });
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect(await owner.query(api.telegram.settings, {})).toMatchObject({ found: [], findError: null });
  });

  test("a bot name that is not one is not stored", async () => {
    const { t, owner } = await start({ botUsername: undefined });
    stubTelegram({ getMe: result({ id: 1, username: "<b>SECRET</b>" }) });
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect((await owner.query(api.telegram.settings, {})).botUsername).toBeNull();
    expect(await everythingStored(t)).not.toContain("SECRET");
  });
});

// ── What the board shows ────────────────────────────────────────────────────

describe("a task near an open card", () => {
  test("is added, and the reply names the open card it may repeat; the card is marked", async () => {
    const { t } = await start();
    const open = await t.run((ctx) =>
      ctx.db.insert("tasks", { title: "Call back the clinic", kind: "task", column: "backlog", order: 0, company: "us" }),
    );
    const out = await tell(t, "/task Call back the clinic");
    expect(out.tasks).toHaveLength(2);
    expect(out.said[0]).toContain("Possible duplicate of: Call back the clinic");
    expect(out.tasks.at(-1)).toMatchObject({ duplicateOf: [open], forceReason: PERSON_DUPLICATE_REASONS.telegram });
  });

  test("an open card of a company the group is not is never named in it", async () => {
    const { t } = await start();
    await t.run((ctx) =>
      ctx.db.insert("tasks", { title: "Call back the clinic", kind: "task", column: "backlog", order: 0, company: "kz" }),
    );
    const out = await tell(t, "/task Call back the clinic");
    expect(out.tasks).toHaveLength(2);
    expect(out.said[0]).not.toContain("Possible duplicate");
  });
});

describe("a card added from Telegram, on the board", () => {
  test("says it came from Telegram and who added it, to those who know them", async () => {
    const { t, owner, cofounder } = await start();
    await tell(t, "/task @Sam_Sales Call back", CORA);
    for (const client of [owner, cofounder]) {
      const [card] = (await client.query(api.tasks.board, {})).backlog;
      expect(card!.origin).toEqual({ source: "telegram", by: "Cora Founder" });
    }
  });

  test("a viewer who shares no company with whoever added it is not told who", async () => {
    const { t } = await start();
    // Erik (Globex alone) adds a shared task; Sam (Startup alone) sees it.
    await tell(t, "/task #both Plan the offsite", ERIK, KZ);
    const sam = await signInAs(t, { email: US_SALES, emailVerificationTime: 1 });
    const [card] = (await sam.query(api.tasks.board, {})).backlog;
    expect(card!.origin).toEqual({ source: "telegram", by: null });
  });

  test("a standup card's origin is sent as it was", async () => {
    const { t, owner } = await start();
    const origin = { source: "standup" as const, meetingDate: "2026-10-13", meetingId: "m1" };
    await t.run((ctx) =>
      ctx.db.insert("tasks", { title: "From standup", kind: "task", column: "backlog", order: 0, origin }),
    );
    expect((await owner.query(api.tasks.board, {})).backlog[0]!.origin).toEqual(origin);
  });
});

// ── Notifications ───────────────────────────────────────────────────────────

describe("who a task from Telegram tells", () => {
  const notifications = (t: TestBackend) =>
    t.run((ctx) => ctx.db.query("notifications").collect());
  const userOf = (t: TestBackend, email: string) =>
    t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first();
      return user!._id;
    });

  test("whoever it is given to is told once, by the person who asked in the group", async () => {
    const { t, cofounder } = await start();
    const out = await tell(t, "/task @Sam_Sales Call the pilot clinic");
    const rows = await notifications(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient: await userOf(t, US_SALES),
      kind: "assigned",
      actor: { type: "user", userId: await userOf(t, COFOUNDER) },
      taskId: out.tasks[0]!._id,
      company: "us",
      title: "Call the pilot clinic",
    });
    // Nothing for the one who asked.
    expect((await cofounder.query(api.notifications.mine, {})).rows).toEqual([]);
    // And the group's reply is still the only message: no second one is sent.
    expect(replies(out.calls)).toHaveLength(1);
  });

  test("a task somebody gives themselves in the group tells nobody", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Cora_F Review the deck");
    expect(out.tasks).toHaveLength(1);
    expect(await notifications(t)).toEqual([]);
  });

  test("a task with nobody on it tells nobody, and a refused one writes nothing", async () => {
    const { t } = await start();
    await tell(t, "/task Tidy the shared drive");
    await tell(t, "/task @Some_Stranger Do a thing");
    expect(await tasks(t)).toHaveLength(1);
    expect(await notifications(t)).toEqual([]);
  });

  test("a name after an @ in what was typed is text: it mentions nobody", async () => {
    const { t } = await start();
    const out = await tell(t, "/task @Sam_Sales Ask @Erik_Eng about the export");
    expect(out.tasks).toHaveLength(1);
    expect((await notifications(t)).map((row) => row.kind)).toEqual(["assigned"]);
  });
});
