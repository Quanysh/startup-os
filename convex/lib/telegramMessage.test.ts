import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  NOT_A_USERNAME,
  TELEGRAM_LIMIT,
  TEST_MESSAGE,
  assignmentMessage,
  boardUrlOf,
  chatFor,
  MAX_FOUND_CHATS,
  chatsFromUpdates,
  rememberChat,
  cleanTelegram,
  isBotToken,
  plain,
} from "./telegramMessage";

const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return error instanceof ConvexError ? (error.data as string) : `not a ConvexError: ${error}`;
  }
  return "no error";
};

describe("cleanTelegram", () => {
  test("keeps a username as typed, without the @ and the spaces round it", () => {
    expect(cleanTelegram("Aigerim_K")).toBe("Aigerim_K");
    expect(cleanTelegram("  @Aigerim_K ")).toBe("Aigerim_K");
  });

  test("nothing typed is no username", () => {
    expect(cleanTelegram("")).toBeUndefined();
    expect(cleanTelegram("   ")).toBeUndefined();
    expect(cleanTelegram("@")).toBeUndefined();
  });

  test("five to thirty-two characters", () => {
    expect(cleanTelegram("abcde")).toBe("abcde");
    expect(cleanTelegram("a".repeat(32))).toBe("a".repeat(32));
    expect(refusal(() => cleanTelegram("abcd"))).toBe(NOT_A_USERNAME);
    expect(refusal(() => cleanTelegram("a".repeat(33)))).toBe(NOT_A_USERNAME);
  });

  test.each([
    ["a space", "aig erim"],
    ["a dash", "aig-erim"],
    ["a dot", "aig.erim"],
    ["a second @", "@@aigerim"],
    ["markup", "<b>aigerim</b>"],
    ["a link", "t.me/aigerim"],
    ["a letter that is not Latin", "айгерим"],
    ["a line break", "aigerim\nboss"],
  ])("refuses %s, quoting nothing", (_what, raw) => {
    expect(refusal(() => cleanTelegram(raw))).toBe(NOT_A_USERNAME);
    expect(NOT_A_USERNAME).not.toContain(raw);
  });
});

describe("plain", () => {
  test("escapes the three characters Telegram's HTML reads", () => {
    expect(plain("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(plain("<a href='x'>hi</a>")).toBe("&lt;a href='x'&gt;hi&lt;/a&gt;");
  });

  test("an @ cannot ping anyone: it becomes the full-width sign", () => {
    expect(plain("ask @durov and @all")).toBe("ask ＠durov and ＠all");
    expect(plain("ask @durov")).not.toContain("@");
  });

  test("line breaks and runs of spaces become one space", () => {
    expect(plain("one\n\ntwo \t three")).toBe("one two three");
  });
});

describe("chatFor", () => {
  const us = { id: "-1001", title: "Startup team" };
  const kz = { id: "-1002", title: "Globex team" };

  test("a company's task goes to that company's group", () => {
    expect(chatFor("us", { us, kz })).toBe(us);
    expect(chatFor("kz", { us, kz })).toBe(kz);
  });

  test("a company's task goes nowhere when that company has no group", () => {
    expect(chatFor("us", { kz })).toBeUndefined();
    expect(chatFor("kz", { us })).toBeUndefined();
  });

  test("a shared task goes to Startup's group if set, else Globex's", () => {
    expect(chatFor(undefined, { us, kz })).toBe(us);
    expect(chatFor(undefined, { kz })).toBe(kz);
    expect(chatFor(undefined, { us })).toBe(us);
    expect(chatFor(undefined, {})).toBeUndefined();
  });
});

describe("boardUrlOf", () => {
  test("the site's address with /board", () => {
    expect(boardUrlOf("https://os.example.com")).toBe("https://os.example.com/board");
    expect(boardUrlOf("https://os.example.com/")).toBe("https://os.example.com/board");
    expect(boardUrlOf("http://localhost:3100")).toBe("http://localhost:3100/board");
  });

  test.each([
    ["unset", undefined],
    ["blank", "  "],
    ["no scheme", "os.example.com"],
    ["another scheme", "javascript:alert(1)"],
    ["a quote", 'https://os.example.com"><b>'],
    ["a path", "https://os.example.com/somewhere"],
    ["a user", "https://user@os.example.com"],
  ])("no link when SITE_URL is %s", (_what, value) => {
    expect(boardUrlOf(value)).toBeUndefined();
  });
});

describe("assignmentMessage", () => {
  const BASE = {
    username: "aigerim_k",
    name: "Aigerim K",
    title: "Call the clinic back",
    company: "us" as const,
    due: undefined,
    actor: "Ada",
    boardUrl: "https://os.example.com/board",
  };

  test("with a username: the tag, the title, then one line of the rest", () => {
    expect(assignmentMessage(BASE)).toBe(
      [
        "<b>New task</b> for @aigerim_k",
        "Call the clinic back",
        'Startup · from Ada · <a href="https://os.example.com/board">Open the board</a>',
      ].join("\n"),
    );
  });

  test("without a username: the name, with no tag", () => {
    const text = assignmentMessage({ ...BASE, username: undefined });
    expect(text.split("\n")[0]).toBe("<b>New task</b> for Aigerim K");
    expect(text).not.toContain("@");
  });

  test("a name is user text too: escaped, and it cannot ping", () => {
    const text = assignmentMessage({ ...BASE, username: undefined, name: "<i>@durov</i> & co" });
    expect(text.split("\n")[0]).toBe("<b>New task</b> for &lt;i&gt;＠durov&lt;/i&gt; &amp; co");
  });

  test("with neither a username nor a name: a teammate, never an address", () => {
    const text = assignmentMessage({ ...BASE, username: undefined, name: undefined });
    expect(text.split("\n")[0]).toBe("<b>New task</b> for a teammate");
  });

  test.each([
    ["us", "Startup"],
    ["kz", "Globex"],
    [undefined, "Both"],
  ] as const)("company %s reads %s", (company, label) => {
    expect(assignmentMessage({ ...BASE, company }).split("\n")[2]).toMatch(
      new RegExp(`^${label} · from Ada · `),
    );
  });

  test("the due date, when set, in words", () => {
    expect(assignmentMessage({ ...BASE, due: "2026-10-20" }).split("\n")[2]).toBe(
      'Startup · due 20 Oct 2026 · from Ada · <a href="https://os.example.com/board">Open the board</a>',
    );
    expect(assignmentMessage({ ...BASE, due: "2027-01-05" })).toContain("due 5 Jan 2027");
  });

  test("a due date that is not a date is left out, never echoed", () => {
    const text = assignmentMessage({ ...BASE, due: "<b>soon</b>" });
    expect(text).not.toContain("due");
    expect(text).not.toContain("soon");
  });

  test("no actor's name, no 'from'; no site address, no link", () => {
    expect(assignmentMessage({ ...BASE, actor: undefined, boardUrl: undefined }).split("\n")[2]).toBe(
      "Startup",
    );
    expect(assignmentMessage({ ...BASE, actor: "<Olga>" }).split("\n")[2]).toContain(
      "from &lt;Olga&gt;",
    );
  });

  test("a title cannot add markup", () => {
    const text = assignmentMessage({
      ...BASE,
      title: '</b><a href="https://evil.test">click</a> & <tg-spoiler>x',
    });
    expect(text.split("\n")[1]).toBe(
      '&lt;/b&gt;&lt;a href="https://evil.test"&gt;click&lt;/a&gt; &amp; &lt;tg-spoiler&gt;x',
    );
  });

  test("an @word in a title pings nobody: the only @ is the assignee's own", () => {
    const text = assignmentMessage({ ...BASE, title: "Tell @durov and @everyone" });
    expect(text.split("\n")[1]).toBe("Tell ＠durov and ＠everyone");
    expect(text.match(/@/g)).toEqual(["@"]);
    expect(text.indexOf("@")).toBe(text.indexOf("@aigerim_k"));
  });

  test("a title with a line break stays one line", () => {
    expect(assignmentMessage({ ...BASE, title: "one\n<b>New task</b> for @all" }).split("\n")).toHaveLength(
      3,
    );
  });

  test("a long title is cut with an ellipsis and the message stays within Telegram's limit", () => {
    const text = assignmentMessage({ ...BASE, title: "&".repeat(5000), name: "<".repeat(500) });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    const title = text.split("\n")[1]!;
    expect(title.endsWith("…")).toBe(true);
    // Cut before escaping, so no entity is left in half.
    expect(title.replace(/&amp;/g, "")).toBe("…");
    expect(text.split("\n")[2]).toContain("Open the board");
  });

  test("a cut never splits a character in two", () => {
    const text = assignmentMessage({ ...BASE, title: "😀".repeat(400) });
    const title = text.split("\n")[1]!;
    expect(title.endsWith("…")).toBe(true);
    expect([...title.slice(0, -1)].every((ch) => ch === "😀")).toBe(true);
  });

  test("a short title is not cut", () => {
    expect(assignmentMessage(BASE)).not.toContain("…");
  });
});

describe("the test message", () => {
  test("is the fixed sentence", () => {
    expect(TEST_MESSAGE).toBe("Startup OS is connected to this group.");
  });
});

describe("isBotToken", () => {
  test("a bot token is digits, a colon and a long tail", () => {
    expect(isBotToken("123456789:AAFakeFakeFakeFakeFakeFakeFakeFake_-x")).toBe(true);
  });
  test.each(["", "abc", "123:short", "123456:AAFake/../getMe?x=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", " 1:a"])(
    "%j is not one",
    (value) => {
      expect(isBotToken(value)).toBe(false);
    },
  );
});

describe("chatsFromUpdates", () => {
  // The usernames on record, lower-cased: only what one of them said or did names a group.
  const VOUCHED = new Set(["secret_user"]);
  const update = (chat: unknown, extra: Record<string, unknown> = {}) => ({
    update_id: 1,
    message: {
      message_id: 5,
      text: "SECRET message text",
      from: { id: 7, first_name: "SECRET", username: "SECRET_user" },
      chat,
      ...extra,
    },
  });

  test("the distinct groups and supergroups, as id, title and type only", () => {
    const found = chatsFromUpdates(VOUCHED, {
      ok: true,
      result: [
        update({ id: -100123, title: "Startup team", type: "supergroup", username: "SECRET_public" }),
        update({ id: -100123, title: "Startup team", type: "supergroup" }),
        update({ id: -456, title: "Globex", type: "group" }),
        update({ id: 99, first_name: "SECRET", type: "private" }),
        update({ id: -100777, title: "SECRET channel", type: "channel" }),
      ],
    });
    expect(found).toEqual([
      { id: "-100123", title: "Startup team", type: "supergroup" },
      { id: "-456", title: "Globex", type: "group" },
    ]);
    expect(JSON.stringify(found)).not.toContain("SECRET");
  });

  test("a group the bot was only added to is found too", () => {
    expect(
      chatsFromUpdates(VOUCHED, {
        ok: true,
        result: [
          {
            update_id: 2,
            my_chat_member: {
              chat: { id: -100555, title: "New group", type: "supergroup" },
              from: { id: 7, first_name: "SECRET", username: "Secret_User" },
            },
          },
        ],
      }),
    ).toEqual([{ id: "-100555", title: "New group", type: "supergroup" }]);
  });

  test("a group is found only through someone whose username is on record", () => {
    const by = (username: string | undefined, id: number) =>
      update(
        { id, title: `Group ${id}`, type: "group" },
        { from: { id: 7, first_name: "SECRET", ...(username === undefined ? null : { username }) } },
      );
    expect(
      chatsFromUpdates(VOUCHED, {
        ok: true,
        result: [by("A_Stranger", -1), by(undefined, -2), by("SECRET_USER", -3), by("secret_user_", -4)],
      }),
    ).toEqual([{ id: "-3", title: "Group -3", type: "group" }]);
    // A bot that says it is a teammate is not one.
    expect(
      chatsFromUpdates(VOUCHED, {
        ok: true,
        result: [update({ id: -5, title: "G", type: "group" }, { from: { id: 7, is_bot: true, username: "Secret_User" } })],
      }),
    ).toEqual([]);
    expect(chatsFromUpdates(new Set(), { ok: true, result: [by("Secret_User", -6)] })).toEqual([]);
  });

  test("a group the bot has since left or been removed from is not found", () => {
    const member = (status: string) => ({
      update_id: 3,
      my_chat_member: {
        chat: { id: -100555, title: "New group", type: "supergroup" },
        from: { id: 7, username: "Secret_User" },
        new_chat_member: { status, user: { id: 1 } },
      },
    });
    for (const gone of ["left", "kicked"]) {
      expect(chatsFromUpdates(VOUCHED, { ok: true, result: [member("member"), member(gone)] })).toEqual([]);
    }
    expect(chatsFromUpdates(VOUCHED, { ok: true, result: [member("left"), member("administrator")] })).toHaveLength(1);
  });

  test("a title is flattened and capped; a group with none is left out", () => {
    const found = chatsFromUpdates(VOUCHED, {
      ok: true,
      result: [
        update({ id: -1, title: `Team\n​${"x".repeat(300)}`, type: "group" }),
        update({ id: -2, title: "   ", type: "group" }),
        update({ id: -3, type: "group" }),
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.title.length).toBeLessThanOrEqual(100);
    expect(found[0]!.title.startsWith("Team x")).toBe(true);
  });

  test("an id that is not a whole number is left out", () => {
    expect(
      chatsFromUpdates(VOUCHED, {
        ok: true,
        result: [
          update({ id: "-100; DROP", title: "A", type: "group" }),
          update({ id: 1.5, title: "B", type: "group" }),
        ],
      }),
    ).toEqual([]);
  });

  test.each([null, "text", 5, {}, { ok: false }, { ok: true, result: "x" }, { ok: true, result: [null, 3, {}] }])(
    "anything else (%j) is no groups, not an error",
    (json) => {
      expect(chatsFromUpdates(VOUCHED, json)).toEqual([]);
    },
  );

  test("at most twenty", () => {
    const result = Array.from({ length: 40 }, (_, i) => update({ id: -1000 - i, title: `G${i}`, type: "group" }));
    expect(chatsFromUpdates(VOUCHED, { ok: true, result })).toHaveLength(20);
  });
});

describe("rememberChat", () => {
  const chat = (n: number, title = `Group ${n}`) => ({ id: String(-n), title, type: "group" as const });
  const full = Array.from({ length: MAX_FOUND_CHATS }, (_, i) => chat(MAX_FOUND_CHATS - i));

  test("a new group goes first", () => {
    expect(rememberChat([chat(1)], chat(2), [])).toEqual([chat(2), chat(1)]);
  });

  test("a group already listed is changed where it is, and puts nobody out", () => {
    const renamed = rememberChat(full, chat(1, "Renamed"), []);
    expect(renamed.map((one) => one.id)).toEqual(full.map((one) => one.id));
    expect(renamed.at(-1)).toEqual(chat(1, "Renamed"));
  });

  test("what is known of a group (its members) outlives a new title", () => {
    expect(rememberChat([{ ...chat(1), members: 12 }], chat(1, "Renamed"), [])).toEqual([
      { ...chat(1, "Renamed"), members: 12 },
    ]);
  });

  test("the same group as it is listed is the same list: nothing to write", () => {
    expect(rememberChat(full, chat(3), [])).toBe(full);
  });

  test("a full list drops the one seen longest ago", () => {
    const next = rememberChat(full, chat(99), []);
    expect(next).toHaveLength(MAX_FOUND_CHATS);
    expect(next[0]).toEqual(chat(99));
    expect(next.some((one) => one.id === "-1")).toBe(false);
    expect(next.some((one) => one.id === "-2")).toBe(true);
  });

  test("never a picked group: the oldest of the others goes instead", () => {
    const next = rememberChat(full, chat(99), ["-1", "-2"]);
    expect(next).toHaveLength(MAX_FOUND_CHATS);
    expect(next.map((one) => one.id)).toEqual(expect.arrayContaining(["-1", "-2", "-99"]));
    expect(next.some((one) => one.id === "-3")).toBe(false);
  });
});
