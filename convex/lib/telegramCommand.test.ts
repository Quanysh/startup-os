import { describe, expect, test } from "vitest";
import {
  HELP_REPLY,
  LEAD_INS,
  MAX_UPDATE_AGE_MS,
  MAX_WEBHOOK_BYTES,
  REPLIES,
  WEBHOOK_PATH,
  addedReply,
  parseRequest,
  parseUpdate,
  titleFrom,
  unknownAssigneeReply,
  untaggedRefusal,
  webhookSecret,
  webhookUrlOf,
  type Entity,
} from "./telegramCommand";

const BOT = "madeup_bot";

/** The `mention` and `hashtag` entities a Telegram client would attach to a text. */
function mentions(text: string): Entity[] {
  return [...text.matchAll(/[@#][A-Za-z0-9_]+/g)].map((m) => ({
    type: m[0].startsWith("@") ? ("mention" as const) : ("hashtag" as const),
    offset: m.index!,
    length: m[0].length,
  }));
}
const ask = (text: string, bot: string | null = BOT, entities = mentions(text)) =>
  parseRequest({ text, entities, caption: false }, bot ?? undefined);

describe("webhookSecret", () => {
  const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";

  test("is 64 characters Telegram allows, the same every time, and holds none of the token", async () => {
    const secret = await webhookSecret(TOKEN);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(await webhookSecret(TOKEN)).toBe(secret);
    expect(secret).not.toContain("SENTINEL");
  });

  test("is HMAC-SHA256 of the fixed label, keyed by the token", async () => {
    // Worked out independently with node:crypto.
    const { createHmac } = await import("node:crypto");
    expect(await webhookSecret(TOKEN)).toBe(
      createHmac("sha256", TOKEN).update("startup-os-webhook-v1").digest("hex"),
    );
  });

  test("another token gives another secret", async () => {
    expect(await webhookSecret(`${TOKEN}x`)).not.toBe(await webhookSecret(TOKEN));
  });
});

describe("webhookUrlOf", () => {
  test("the deployment's own address with the route's path", () => {
    expect(WEBHOOK_PATH).toBe("/telegram/v1/webhook");
    expect(webhookUrlOf("https://happy-otter-1.convex.site")).toBe(
      "https://happy-otter-1.convex.site/telegram/v1/webhook",
    );
    expect(webhookUrlOf("https://happy-otter-1.convex.site/")).toBe(
      "https://happy-otter-1.convex.site/telegram/v1/webhook",
    );
  });

  test.each([undefined, "", "http://plain.example", "https://a b", "https://x.test/path", "ftp://x"])(
    "nothing for %j: Telegram only calls https, and the value is not echoed",
    (site) => {
      expect(webhookUrlOf(site)).toBeUndefined();
    },
  );
});

describe("parseUpdate", () => {
  const message = (over: Record<string, unknown> = {}) => ({
    update_id: 77,
    message: {
      message_id: 5,
      date: 1_791_882_000,
      from: { id: 4242, is_bot: false, first_name: "SECRET", username: "Aigerim_K" },
      chat: { id: -100123, title: "Startup team", type: "supergroup" },
      text: "/task hello",
      ...over,
    },
  });

  test("a message: the update's id, the group, the sender's id and username, the text", () => {
    expect(parseUpdate(message())).toEqual({
      updateId: 77,
      chat: { id: "-100123", title: "Startup team", type: "supergroup" },
      at: 1_791_882_000_000,
      by: "Aigerim_K",
      message: {
        chatId: "-100123",
        messageId: 5,
        from: { id: "4242", username: "Aigerim_K" },
        text: "/task hello",
        entities: [],
        caption: false,
      },
    });
  });

  test("the bot being added to a group names the group and carries no message", () => {
    expect(
      parseUpdate({
        update_id: 78,
        my_chat_member: { date: 5, chat: { id: -456, title: "Globex", type: "group" }, from: { id: 1 } },
      }),
    ).toEqual({ updateId: 78, at: 5000, chat: { id: "-456", title: "Globex", type: "group" } });
  });

  test("who added the bot is kept by username alone, when they have one and are no bot", () => {
    const added = (from: unknown, status = "member") =>
      parseUpdate({
        update_id: 78,
        my_chat_member: {
          date: 5,
          chat: { id: -456, title: "Globex", type: "group" },
          from,
          new_chat_member: { status, user: { id: 1, first_name: "SECRET" } },
        },
      });
    expect(added({ id: 9, first_name: "SECRET", username: "Aigerim_K" })).toEqual({
      updateId: 78,
      at: 5000,
      chat: { id: "-456", title: "Globex", type: "group" },
      by: "Aigerim_K",
    });
    for (const from of [
      { id: 9, first_name: "SECRET" },
      { id: 9, username: "<b>x</b>" },
      { id: 9, is_bot: true, username: "Aigerim_K" },
      "Aigerim_K",
    ]) {
      expect(added(from)?.by).toBeUndefined();
    }
  });

  test.each(["left", "kicked"])("the bot's own status %s says it is gone from the group", (status) => {
    const gone = parseUpdate({
      update_id: 79,
      my_chat_member: {
        date: 5,
        chat: { id: -456, title: "Globex", type: "group" },
        from: { id: 9 },
        new_chat_member: { status, user: { id: 1 } },
      },
    });
    expect(gone).toEqual({
      updateId: 79,
      at: 5000,
      chat: { id: "-456", title: "Globex", type: "group" },
      left: true,
    });
  });

  test.each(["member", "administrator", "restricted", 5, undefined])(
    "any other status (%j) is not that, and a message never is",
    (status) => {
      expect(
        parseUpdate({
          update_id: 79,
          my_chat_member: {
            date: 5,
            chat: { id: -456, title: "Globex", type: "group" },
            new_chat_member: { status },
          },
        })?.left,
      ).toBeUndefined();
      expect(parseUpdate(message({ new_chat_member: { status: "left" } }))?.left).toBeUndefined();
    },
  );

  test("only mention entities are kept, each checked against the text", () => {
    const text = "@madeup_bot hi @fakeone";
    const parsed = parseUpdate(
      message({
        text,
        entities: [
          { type: "mention", offset: 0, length: 11 },
          { type: "bold", offset: 12, length: 2 },
          { type: "mention", offset: 15, length: 8 },
          { type: "mention", offset: 12, length: 2 }, // not an @word
          { type: "mention", offset: 100, length: 5 }, // past the end
          { type: "mention", offset: -1, length: 5 },
          { type: "mention", offset: 0.5, length: 5 },
          { type: "text_mention", offset: 12, length: 2, user: { id: 9, first_name: "SECRET" } },
          { type: "hashtag", offset: 12, length: 2 }, // not a #word
          { type: "text_mention", offset: 20, length: 50 }, // runs past the end
          "junk",
        ],
      }),
    );
    expect(parsed?.message?.entities).toEqual([
      { type: "mention", offset: 0, length: 11 },
      { type: "mention", offset: 15, length: 8 },
      { type: "text_mention", offset: 12, length: 2 },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  test("when it was sent is kept, in milliseconds", () => {
    expect(MAX_UPDATE_AGE_MS).toBe(10 * 60 * 1000);
    expect(parseUpdate(message({ date: 1_700_000_000 }))?.at).toBe(1_700_000_000_000);
  });

  test.each([undefined, "1791882000", 1.5, -1, 0, 2 ** 60])(
    "with no time it was sent that can be read (%j), nothing of it is kept: its age cannot be told",
    (date) => {
      expect(parseUpdate(message({ date }))).toEqual({ updateId: 77 });
    },
  );

  test.each([
    ["forward_origin", { type: "user", date: 1, sender_user: { id: 9, first_name: "SECRET" } }],
    ["forward_from", { id: 9, first_name: "SECRET" }],
    ["forward_from_chat", { id: -100, type: "channel", title: "SECRET" }],
    ["forward_sender_name", "SECRET"],
    ["forward_date", 1],
    ["is_automatic_forward", true],
    ["via_bot", { id: 3, is_bot: true, username: "some_inline_bot" }],
  ])("a forwarded message, or one sent through a bot (%s), is not read; the group is still seen", (key, value) => {
    const parsed = parseUpdate(message({ [key]: value }));
    expect(parsed?.message).toBeUndefined();
    expect(parsed?.chat).toEqual({ id: "-100123", title: "Startup team", type: "supergroup" });
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  test("an entity sent twice is kept once, and one that overlaps another is dropped", () => {
    // The board by its id ("#us"), which no identity renames.
    const text = "@madeup_bot hi @fakeone #us";
    const parsed = parseUpdate(
      message({
        text,
        entities: [
          { type: "mention", offset: 0, length: 11 },
          { type: "mention", offset: 0, length: 11 },
          { type: "text_mention", offset: 5, length: 10 }, // across the bot's name and "hi"
          { type: "mention", offset: 15, length: 8 },
          { type: "text_mention", offset: 15, length: 8 }, // the same stretch, as another kind
          { type: "hashtag", offset: 24, length: 3 },
          { type: "hashtag", offset: 24, length: 3 },
        ],
      }),
    );
    expect(parsed?.message?.entities).toEqual([
      { type: "mention", offset: 0, length: 11 },
      { type: "mention", offset: 15, length: 8 },
      { type: "hashtag", offset: 24, length: 3 },
    ]);
  });

  test("a photo's caption is read only when it comes with caption entities", () => {
    const caption = "@madeup_bot fix this";
    const withEntities = parseUpdate(
      message({
        text: undefined,
        caption,
        caption_entities: [{ type: "mention", offset: 0, length: 11 }],
      }),
    );
    expect(withEntities?.message).toMatchObject({ text: caption, caption: true });
    expect(parseUpdate(message({ text: undefined, caption }))?.message).toBeUndefined();
  });

  test.each([
    ["no sender", { from: undefined }],
    ["a sender that is a bot", { from: { id: 1, is_bot: true, username: "other_bot" } }],
    ["a sender id that is no whole number", { from: { id: "4242" } }],
    ["no text", { text: undefined }],
    ["text that is not a string", { text: 5 }],
    ["text longer than Telegram sends", { text: "x".repeat(4097) }],
    ["a message id that is no whole number", { message_id: "5" }],
  ])("a message with %s is not read; the group is still seen", (_what, over) => {
    const parsed = parseUpdate(message(over));
    expect(parsed).toMatchObject({
      updateId: 77,
      chat: { id: "-100123", title: "Startup team", type: "supergroup" },
    });
    expect(parsed?.message).toBeUndefined();
  });

  test("a username that is not one is dropped, the message kept", () => {
    const parsed = parseUpdate(message({ from: { id: 4242, username: "<b>x</b>" } }));
    expect(parsed?.message?.from).toEqual({ id: "4242" });
  });

  test("a private chat or a channel is no group: nothing of it is kept", () => {
    for (const chat of [
      { id: 4242, type: "private", first_name: "SECRET" },
      { id: -100, type: "channel", title: "SECRET" },
    ]) {
      expect(parseUpdate(message({ chat }))).toEqual({ updateId: 77 });
    }
  });

  test.each([
    ["a string, even one that reads as a group's id", "-100123"],
    ["a fraction", -100123.5],
    ["a number too large to be exact", -(2 ** 60)],
    ["not a number", Number.NaN],
    ["a boolean", true],
    ["an object", { $ne: null }],
    ["an array", [-100123]],
    ["nothing", null],
  ])("a chat id that is %s is no group's: nothing of the update is kept", (_what, id) => {
    expect(parseUpdate(message({ chat: { id, title: "Startup team", type: "supergroup" } }))).toEqual({
      updateId: 77,
    });
    expect(
      parseUpdate({
        update_id: 77,
        my_chat_member: { date: 5, chat: { id, title: "Startup team", type: "group" }, from: { id: 1 } },
      }),
    ).toEqual({ updateId: 77 });
  });

  test.each([null, 5, "x", [], {}, { update_id: "7" }, { update_id: 1.5 }, { update_id: -1 }])(
    "%j is not an update",
    (json) => {
      expect(parseUpdate(json)).toBeNull();
    },
  );

  test("as many as fifty entities are looked at and no more", () => {
    const text = "@a_bot ".repeat(80);
    const entities = Array.from({ length: 80 }, (_, i) => ({ type: "mention", offset: i * 7, length: 6 }));
    expect(parseUpdate(message({ text, entities }))?.message?.entities).toHaveLength(50);
  });
});

describe("parseRequest: marks that repeat or overlap", () => {
  const BOT_AT = { type: "mention" as const, offset: 0, length: 11 };

  test("the bot's mention marked twice does not eat the title", () => {
    expect(ask("@madeup_bot Call the clinic", BOT, [BOT_AT, BOT_AT])).toEqual({
      kind: "task",
      title: "Call the clinic",
    });
  });

  test("nor three times, with a person and a board", () => {
    const text = "@madeup_bot @fakeone #globex Call the clinic";
    const marks = mentions(text);
    expect(ask(text, BOT, [...marks, ...marks, ...marks])).toEqual({
      kind: "task",
      assignee: "fakeone",
      board: "kz",
      title: "Call the clinic",
    });
  });

  test("a board's hashtag marked twice is one board and is taken out once", () => {
    const text = "/task #us Call the clinic";
    const tag = { type: "hashtag" as const, offset: 6, length: 3 };
    expect(ask(text, BOT, [tag, tag])).toEqual({ kind: "task", board: "us", title: "Call the clinic" });
  });
});

describe("parseRequest: commands", () => {
  test("/task with a person and a title", () => {
    expect(ask("/task @fakeone Call the pilot clinic")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "Call the pilot clinic",
    });
  });

  test("/task with a title alone is nobody's", () => {
    expect(ask("/task Update the pricing page")).toEqual({
      kind: "task",
      title: "Update the pricing page",
    });
  });

  test("Telegram's addressed form, whatever the capitals", () => {
    expect(ask("/task@MadeUp_Bot @fakeone Call back")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "Call back",
    });
    expect(ask("/TASK Call back")).toEqual({ kind: "task", title: "Call back" });
  });

  test("a command addressed to another bot, or to any bot while ours is not known, is not ours", () => {
    expect(ask("/task@other_bot Call back")).toBeNull();
    expect(ask("/task@madeup_bot Call back", null)).toBeNull();
    expect(ask("/help@other_bot")).toBeNull();
  });

  test("a due date at the end, written by YYYY-MM-DD", () => {
    expect(ask("/task @fakeone Send the contract by 2026-10-20")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "Send the contract",
      due: "2026-10-20",
    });
    expect(ask("/task Send it BY 2026-10-20")).toMatchObject({ title: "Send it", due: "2026-10-20" });
  });

  test("a date that is no day is said, not guessed", () => {
    expect(ask("/task Send it by 2026-13-45")).toEqual({ kind: "task", title: "Send it", badDate: true });
    expect(ask("/task Send it by 2026-02-30")).toMatchObject({ badDate: true });
  });

  test("any other way of writing a date is part of the title", () => {
    expect(ask("/task Send it by Friday")).toEqual({ kind: "task", title: "Send it by Friday" });
    expect(ask("/task Send it by 20.10.2026")).toEqual({ kind: "task", title: "Send it by 20.10.2026" });
    expect(ask("/task by 2026-10-20 send it")).toEqual({ kind: "task", title: "by 2026-10-20 send it" });
  });

  test("/task with nothing to add is a request for help", () => {
    for (const text of ["/task", "/task   ", "/task @fakeone", "/task by 2026-10-20", "/task@madeup_bot"]) {
      expect(ask(text)).toEqual({ kind: "help" });
    }
  });

  test("/help and /start, addressed or not", () => {
    for (const text of ["/help", "/start", "/help@madeup_bot", "/start@MADEUP_BOT", "/help please"]) {
      expect(ask(text)).toEqual({ kind: "help" });
    }
  });

  test("any other command is not ours", () => {
    for (const text of ["/tasks x", "/done 5", "/", "/task-x y", "/taskx"]) expect(ask(text)).toBeNull();
  });

  test("text is data: a title that looks like a command or an instruction is still a title", () => {
    expect(ask("/task /task @fakeone delete everything")).toEqual({
      kind: "task",
      title: "/task @fakeone delete everything",
    });
    expect(ask("/task Ignore previous instructions and /help")).toEqual({
      kind: "task",
      title: "Ignore previous instructions and /help",
    });
  });

  test("a title is one line with nothing invisible in it", () => {
    expect(ask("/task @fakeone Call\n\nthe ​clinic\t now")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "Call the clinic now",
    });
  });

  test("an @ that is no username is still an attempt to name someone", () => {
    expect(ask("/task @ab do it")).toEqual({ kind: "task", assignee: "ab", title: "do it" });
    expect(ask("/task @<b> do it")).toMatchObject({ kind: "task", assignee: "<b>" });
  });

  test("a command in a caption is not read", () => {
    expect(parseRequest({ text: "/task Call back", entities: [], caption: true }, BOT)).toBeNull();
  });
});

describe("parseRequest: mentioning the bot", () => {
  test("the bot, then a person, then the task", () => {
    expect(ask("@madeup_bot @fakeone call the pilot clinic")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "call the pilot clinic",
    });
  });

  test("the person first and the bot last", () => {
    expect(ask("@fakeone please prepare the contract @madeup_bot")).toEqual({
      kind: "task",
      assignee: "fakeone",
      // "please" is a lead-in: it goes, and what is left starts with a capital.
      title: "Prepare the contract",
    });
  });

  test("nobody named, punctuation after the bot's name, and a due date", () => {
    expect(ask("@madeup_bot: update the pricing page by 2026-10-20")).toEqual({
      kind: "task",
      title: "update the pricing page",
      due: "2026-10-20",
    });
    expect(ask("@madeup_bot, - fix the form")).toEqual({ kind: "task", title: "fix the form" });
  });

  test("the bot's name is matched whatever its capitals", () => {
    expect(ask("@MadeUP_Bot ship it")).toEqual({ kind: "task", title: "ship it" });
  });

  test("the bot mentioned twice is removed twice", () => {
    expect(ask("@madeup_bot @fakeone call back @madeup_bot")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "call back",
    });
  });

  test("a mention inside a longer sentence", () => {
    expect(ask("hey @madeup_bot can @fakeone call the clinic tomorrow?")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "hey can call the clinic tomorrow?",
    });
  });

  test("only the first other person is the assignee; the rest stay in the title", () => {
    expect(ask("@madeup_bot @fakeone ask @someone_else about it")).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "ask @someone_else about it",
    });
  });

  test("another bot mentioned without ours is not for us", () => {
    expect(ask("@other_bot @fakeone call back")).toBeNull();
    expect(ask("@fakeone call back")).toBeNull();
    expect(ask("just talking")).toBeNull();
  });

  test("another bot mentioned beside ours is taken for a person, to be refused as unknown", () => {
    expect(ask("@madeup_bot @other_bot do it")).toEqual({
      kind: "task",
      assignee: "other_bot",
      title: "do it",
    });
  });

  test("the bot's name typed without Telegram marking it as a mention is not a mention", () => {
    expect(ask("@madeup_bot do it", BOT, [])).toBeNull();
    // A longer name that only starts with the bot's is somebody else.
    expect(ask("@madeup_bot_two do it")).toBeNull();
  });

  test("with the bot's own name unknown, no mention can be for it", () => {
    expect(ask("@madeup_bot do it", null)).toBeNull();
  });

  test("a person with no username (a text mention) cannot be the assignee, and that is said", () => {
    const text = "@madeup_bot Dana call the clinic";
    expect(
      ask(text, BOT, [
        { type: "mention", offset: 0, length: 11 },
        { type: "text_mention", offset: 12, length: 4 },
      ]),
    ).toEqual({ kind: "task", noUsername: true, title: "call the clinic" });
  });

  test("a text mention after a person with a username is just words", () => {
    const text = "@madeup_bot @fakeone ask Dana";
    expect(
      ask(text, BOT, [...mentions(text), { type: "text_mention", offset: 25, length: 4 }]),
    ).toEqual({ kind: "task", assignee: "fakeone", title: "ask Dana" });
  });

  test("nothing left once the mentions are gone is a request for help", () => {
    for (const text of ["@madeup_bot", "@madeup_bot @fakeone", " @madeup_bot : ", "@madeup_bot by 2026-10-20"]) {
      expect(ask(text)).toEqual({ kind: "help" });
    }
  });

  test("a caption that mentions the bot is read the same way", () => {
    const text = "@madeup_bot @fakeone look at this";
    expect(parseRequest({ text, entities: mentions(text), caption: true }, BOT)).toEqual({
      kind: "task",
      assignee: "fakeone",
      title: "look at this",
    });
  });
});

describe("lead-ins", () => {
  test("the owner's first real message", () => {
    expect(ask("@madeup_bot assign task to @faketwo to create a telegram group with Zoe")).toEqual({
      kind: "task",
      assignee: "faketwo",
      title: "Create a telegram group with Zoe",
    });
  });

  test.each([
    "assign task to",
    "assign a task to",
    "assign to",
    "task for",
    "task to",
    "new task for",
    "please",
    "pls",
    "задача для",
    "задачу для",
    "поставь задачу",
    "назначь задачу",
    "пожалуйста",
  ])("%j before the person is dropped", (leadIn) => {
    expect(LEAD_INS).toContain(leadIn);
    expect(ask(`@madeup_bot ${leadIn} @faketwo call the clinic`)).toEqual({
      kind: "task",
      assignee: "faketwo",
      title: "Call the clinic",
    });
    expect(ask(`@madeup_bot ${leadIn.toUpperCase()} @faketwo call the clinic`)).toMatchObject({
      title: "Call the clinic",
    });
  });

  test("the list is the thirteen, and no more", () => {
    expect(LEAD_INS).toHaveLength(13);
  });

  test("after the person too, and with nobody named", () => {
    expect(ask("@madeup_bot @faketwo please call the clinic")).toMatchObject({ title: "Call the clinic" });
    expect(ask("@madeup_bot pls, call the clinic")).toEqual({ kind: "task", title: "Call the clinic" });
    expect(ask("/task @faketwo please call the clinic")).toMatchObject({ title: "Call the clinic" });
    expect(ask("/task new task for @faketwo")).toEqual({ kind: "help" });
  });

  test("several in a row, with punctuation between", () => {
    expect(ask("@madeup_bot please, assign a task to @faketwo: pls to fix the form")).toEqual({
      kind: "task",
      assignee: "faketwo",
      title: "Fix the form",
    });
  });

  test("a title that starts with 'to' after no lead-in keeps it, as typed", () => {
    expect(ask("@madeup_bot @faketwo to-do list cleanup")).toEqual({
      kind: "task",
      assignee: "faketwo",
      title: "to-do list cleanup",
    });
    expect(ask("@madeup_bot @faketwo to be decided: the venue")).toMatchObject({
      title: "to be decided: the venue",
    });
  });

  test("after a lead-in, 'to-do' is still not a dangling 'to'", () => {
    expect(ask("@madeup_bot assign to @faketwo to-do list cleanup")).toMatchObject({
      title: "To-do list cleanup",
    });
  });

  test("a lead-in is whole words at the very start, nothing else", () => {
    expect(ask("@madeup_bot @faketwo pleased customers report")).toMatchObject({
      title: "pleased customers report",
    });
    expect(ask("@madeup_bot @faketwo write the task for Monday please")).toMatchObject({
      title: "write the task for Monday please",
    });
    expect(ask("@madeup_bot @faketwo plsql migration")).toMatchObject({ title: "plsql migration" });
  });

  test("with no lead-in nothing is changed, capitals included", () => {
    expect(ask("@madeup_bot @faketwo iOS build is broken")).toMatchObject({
      title: "iOS build is broken",
    });
  });

  test("Russian", () => {
    expect(ask("@madeup_bot поставь задачу @faketwo чтобы создать группу с Зоей")).toEqual({
      kind: "task",
      assignee: "faketwo",
      title: "Создать группу с Зоей",
    });
    expect(ask("@madeup_bot задача для @faketwo позвонить в клинику")).toMatchObject({
      title: "Позвонить в клинику",
    });
    expect(ask("@madeup_bot @faketwo Пожалуйста, обнови прайс by 2026-10-20")).toEqual({
      kind: "task",
      assignee: "faketwo",
      title: "Обнови прайс",
      due: "2026-10-20",
    });
    expect(ask("@madeup_bot @faketwo чтобы было красиво")).toMatchObject({ title: "чтобы было красиво" });
  });

  test("a title that is only a lead-in is a request for help", () => {
    for (const text of [
      "@madeup_bot please",
      "@madeup_bot assign task to @faketwo",
      "@madeup_bot assign task to @faketwo to",
      "@madeup_bot пожалуйста",
      "/task pls",
    ]) {
      expect(ask(text)).toEqual({ kind: "help" });
    }
  });

  test("titleFrom on its own: the parts round the person, joined", () => {
    expect(titleFrom(["  assign task to ", " to create a group "])).toBe("Create a group");
    expect(titleFrom(["hey  can", "call the clinic"])).toBe("hey can call the clinic");
    expect(titleFrom([": , - fix the form"])).toBe("fix the form");
    expect(titleFrom(["", ""])).toBe("");
  });
});

describe("parseRequest: which board", () => {
  test.each([
    ["#startup", "us"],
    ["#us", "us"],
    ["#Startup", "us"],
    ["#globex", "kz"],
    ["#globexai", "kz"],
    ["#kz", "kz"],
    ["#GLOBEX", "kz"],
    ["#both", "both"],
    ["#shared", "both"],
  ])("%s names the board %s and leaves the title", (tag, board) => {
    expect(ask(`@madeup_bot @fakeone ${tag} call the clinic`)).toEqual({
      kind: "task",
      assignee: "fakeone",
      board,
      title: "call the clinic",
    });
    expect(ask(`/task @fakeone call the clinic ${tag}`)).toEqual({
      kind: "task",
      assignee: "fakeone",
      board,
      title: "call the clinic",
    });
  });

  test("no hashtag names no board: the group's rule decides", () => {
    expect(ask("/task call the clinic")).not.toHaveProperty("board");
  });

  test("a hashtag that is no company's stays in the title, untouched", () => {
    expect(ask("/task #urgent call the #clinic #kz")).toEqual({
      kind: "task",
      board: "kz",
      title: "#urgent call the #clinic",
    });
    expect(ask("@madeup_bot fix #startupos and #kzt")).toEqual({
      kind: "task",
      title: "fix #startupos and #kzt",
    });
  });

  test("the same board named twice, by two names, is one board", () => {
    expect(ask("/task #startup call back #us")).toEqual({ kind: "task", board: "us", title: "call back" });
  });

  test("two different boards named is no task", () => {
    expect(ask("/task #startup #globex call back")).toEqual({
      kind: "task",
      boardConflict: true,
      title: "call back",
    });
    expect(ask("@madeup_bot #kz call back #both")).toMatchObject({ boardConflict: true });
  });

  test("a hashtag after the date still leaves the date at the end", () => {
    expect(ask("@madeup_bot send it by 2026-10-20 #globex")).toEqual({
      kind: "task",
      board: "kz",
      title: "send it",
      due: "2026-10-20",
    });
  });

  test("where Telegram sent no hashtag entities, the text is read for them", () => {
    const text = "/task #globex call the clinic";
    expect(parseRequest({ text, entities: [], caption: false }, BOT)).toEqual({
      kind: "task",
      board: "kz",
      title: "call the clinic",
    });
    // Not a hashtag: no space before it.
    expect(parseRequest({ text: "/task see page#kz now", entities: [], caption: false }, BOT)).toEqual({
      kind: "task",
      title: "see page#kz now",
    });
  });

  test("only a board and nothing else is a request for help", () => {
    expect(ask("@madeup_bot #globex")).toEqual({ kind: "help" });
  });
});

describe("the replies", () => {
  test("help shows both ways, the mention first, in code so nothing in it pings", () => {
    const help = HELP_REPLY("madeup_bot");
    expect(help).toBe(
      [
        "<b>Add a task to the Startup OS board</b>",
        "<code>@madeup_bot @username Title of the task</code>",
        "<code>/task @username Title of the task</code>",
        "Leave the person out for a task that is nobody's yet. A due date goes at the end, written <code>by 2026-10-20</code>; no other way of writing a date is read.",
        "The task goes on this group's board. For another, add <code>#startup</code>, <code>#globex</code> or <code>#both</code>, as in <code>@madeup_bot @username #globex Title of the task</code>.",
      ].join("\n"),
    );
    expect(help.replace(/<code>[^<]*<\/code>/g, "")).not.toMatch(/[@#]/);
  });

  test("help without the bot's name shows the command alone", () => {
    expect(HELP_REPLY(undefined)).not.toContain("@undefined");
    expect(HELP_REPLY(undefined)).toContain("<code>/task @username Title of the task</code>");
  });

  test("the fixed refusals", () => {
    expect(REPLIES).toEqual({
      strangers: "Only teammates in Startup OS can add tasks here.",
      limit: "That is enough tasks from Telegram for now. Add this one on the board.",
      badDate: "I could not read that date. Write it as by YYYY-MM-DD. Nothing was added.",
      titleTooLong: "That title is too long (200 characters at most). Nothing was added.",
      noUsername:
        "That person has no Telegram username, so I cannot give them a task from here. Nothing was added.",
      oneBoard: "Name one board: #startup, #globex or #both. Nothing was added.",
      notYourBoard: "You are not on that company's board. Nothing was added.",
    });
  });

  test("an untagged task bound for a board the sender is not on: where it would go, and what to add", () => {
    expect(untaggedRefusal("kz", "us")).toBe(
      "With no hashtag a task from this group goes to Globex's board, which you are not on. Add <code>#startup</code> to put it on Startup's. Nothing was added.",
    );
    expect(untaggedRefusal("us", "kz")).toBe(
      "With no hashtag a task from this group goes to Startup's board, which you are not on. Add <code>#globex</code> to put it on Globex's. Nothing was added.",
    );
  });

  test("an unknown person is named back as typed, escaped, and pings nobody", () => {
    expect(unknownAssigneeReply("fakeone")).toBe(
      "I do not know ＠fakeone as a teammate on this board. Nothing was added.",
    );
    const hostile = unknownAssigneeReply(`<b>x</b>${"y".repeat(100)}`);
    expect(hostile).toContain("＠&lt;b&gt;x&lt;/b&gt;");
    expect(hostile).not.toContain("@");
    expect(hostile.length).toBeLessThan(200);
  });

  test("added, for someone: their real @ once, the title made safe, the board's link", () => {
    expect(
      addedReply({
        username: "Fakeone",
        title: "Tell @all <b>now</b> & then",
        company: "us",
        due: "2026-10-20",
        boardUrl: "https://os.example.test/board",
      }),
    ).toBe(
      '<b>Added</b> to Startup\'s board for @Fakeone: Tell ＠all &lt;b&gt;now&lt;/b&gt; &amp; then · due 20 Oct 2026 · <a href="https://os.example.test/board">Open the board</a>',
    );
  });

  test.each([
    ["us", "Startup's board"],
    ["kz", "Globex's board"],
    [undefined, "both boards"],
  ] as const)("the board it landed on: %s reads %s", (company, words) => {
    expect(
      addedReply({ username: undefined, title: "Fix it", company, due: undefined, boardUrl: undefined }),
    ).toBe(`<b>Added</b> to ${words}: Fix it`);
  });


  test("a username that is not one is never written as a tag", () => {
    expect(
      addedReply({ username: "<x>", title: "Fix it", company: "kz", due: undefined, boardUrl: undefined }),
    ).toBe("<b>Added</b> to Globex's board: Fix it");
  });
});

describe("the body cap", () => {
  test("is 64 KB", () => {
    expect(MAX_WEBHOOK_BYTES).toBe(64 * 1024);
  });
});
