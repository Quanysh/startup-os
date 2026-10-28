import { describe, expect, test } from "vitest";
import { ConnectorError } from "./errors";
import { AT, OWNER_ADDRESS, message, sent, thread } from "./gmail.fixtures";
import { parseFrom, parseThread, parseThreadList } from "./gmailParse";

const isOwner = (address: string) => address === OWNER_ADDRESS;
const parse = (json: unknown) => parseThread("a1", json, isOwner);

/** What was thrown, so its class and its message can both be checked. */
function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a throw.");
}

const LIST_SHAPE = "Gmail's inbox list was not in the expected shape.";
const THREAD_SHAPE = "A Gmail thread was not in the expected shape.";

describe("parseThread: a thread waiting on the owner", () => {
  test("a plain thread from a person", () => {
    expect(parse(thread(message()))).toEqual({
      kind: "mail",
      threadId: "a1",
      fromName: "Ada Example",
      fromAddress: "ada@example-fund.test",
      subject: "Made-up subject",
      lastMessageAt: AT,
    });
  });

  test("stores exactly five things about a thread, and none is a body or a snippet", () => {
    const json = {
      snippet: "REMOTE-SNIPPET",
      messages: [{ ...message(), snippet: "REMOTE-SNIPPET", payload: { ...message().payload, body: { data: "REMOTE-BODY" } } }],
    };
    const record = parse(json);
    expect(Object.keys(record ?? {}).sort()).toEqual(
      ["fromAddress", "fromName", "kind", "lastMessageAt", "subject", "threadId"].sort(),
    );
    expect(JSON.stringify(record)).not.toContain("REMOTE-");
  });

  test("the owner replied last: not waiting, though an earlier message is from someone else", () => {
    expect(parse(thread(message({ at: AT }), sent(AT + 1000)))).toBeNull();
  });

  test("someone replied after the owner: waiting, from the later message's time", () => {
    const record = parse(thread(message({ at: AT }), sent(AT + 1000), message({ at: AT + 2000 })));
    expect(record).toMatchObject({ fromAddress: "ada@example-fund.test", lastMessageAt: AT + 2000 });
  });

  test("the newest message decides, whatever order Gmail lists them in", () => {
    expect(parse(thread(sent(AT + 1000), message({ at: AT })))).toBeNull();
    expect(parse(thread(message({ at: AT + 2000 }), sent(AT + 1000)))).toMatchObject({
      lastMessageAt: AT + 2000,
    });
  });
});

describe("parseThread: each rule, one at a time", () => {
  const notWaiting: [string, Parameters<typeof message>[0]][] = [
    ["rule 2: sent by the owner (SENT label)", { labels: ["INBOX", "SENT"] }],
    ["rule 2: a draft", { labels: ["INBOX", "DRAFT"] }],
    ["rule 2: from the owner's own address, without the label", { from: OWNER_ADDRESS }],
    ["rule 2: the owner's address in another case", { from: "Founder <FOUNDER@Example.TEST>" }],
    ["rule 3: promotions", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }],
    ["rule 3: social", { labels: ["INBOX", "CATEGORY_SOCIAL"] }],
    ["rule 3: updates", { labels: ["INBOX", "CATEGORY_UPDATES"] }],
    ["rule 3: forums", { labels: ["INBOX", "CATEGORY_FORUMS"] }],
    ["rule 3: spam", { labels: ["SPAM"] }],
    ["rule 3: trash", { labels: ["TRASH"] }],
    ["rule 4: List-Unsubscribe", { headers: { "List-Unsubscribe": "<mailto:x@example.test>" } }],
    ["rule 4: List-Id", { headers: { "List-Id": "<made-up.example.test>" } }],
    ["rule 5: Precedence bulk", { headers: { Precedence: "bulk" } }],
    ["rule 5: Precedence list", { headers: { Precedence: " List " } }],
    ["rule 5: Precedence junk", { headers: { Precedence: "junk" } }],
    ["rule 5: Auto-Submitted", { headers: { "Auto-Submitted": "auto-generated" } }],
    ["rule 5: Auto-Submitted auto-replied", { headers: { "Auto-Submitted": "auto-replied" } }],
    ["rule 6: noreply", { from: "Made-up Service <noreply@service.test>" }],
    ["rule 6: no-reply", { from: "no-reply@service.test" }],
    ["rule 6: donotreply", { from: "donotreply@service.test" }],
    ["rule 6: do-not-reply", { from: "do-not-reply@service.test" }],
    ["rule 6: notification", { from: "notification@service.test" }],
    ["rule 6: notifications with a tag", { from: "notifications+abc@service.test" }],
    ["rule 6: mailer-daemon", { from: "MAILER-DAEMON@service.test" }],
    ["rule 6: postmaster", { from: "postmaster@service.test" }],
    ["rule 6: bounce", { from: "bounce@service.test" }],
    ["rule 6: bounces with a suffix", { from: "bounces.x1@service.test" }],
    ["rule 6: no From at all", { from: null }],
    ["rule 6: a From that is not an address", { from: "garbage" }],
  ];
  test.each(notWaiting)("%s → not waiting", (_name, over) => {
    expect(parse(thread(message(over)))).toBeNull();
  });

  const waiting: [string, Parameters<typeof message>[0]][] = [
    ["Precedence: first-class", { headers: { Precedence: "first-class" } }],
    ["Auto-Submitted: no", { headers: { "Auto-Submitted": "no" } }],
    ["a person whose name begins like an automated one", { from: "notifier.ada@example-fund.test" }],
    ["a person named Noreplyson", { from: "noreplyson@example-fund.test" }],
    ["an important, starred message", { labels: ["INBOX", "IMPORTANT", "STARRED"] }],
    ["a message with no category label", { labels: ["INBOX"] }],
  ];
  test.each(waiting)("%s → waiting", (_name, over) => {
    expect(parse(thread(message(over)))).not.toBeNull();
  });
});

describe("parseThread: reading the headers", () => {
  test.each([
    ['"Ada Example" <Ada@Example-Fund.test>', "Ada Example"],
    ["Ada Example <ada@example-fund.test>", "Ada Example"],
    ["ada@example-fund.test", ""],
    ["<ada@example-fund.test>", ""],
    ["'Ada Example' <ada@example-fund.test>  ", "Ada Example"],
  ])("From: %s", (from, name) => {
    expect(parseFrom(from)).toEqual({ name, address: "ada@example-fund.test" });
    expect(parse(thread(message({ from })))).toMatchObject({
      fromName: name,
      fromAddress: "ada@example-fund.test",
    });
  });

  test("a From that is not an address parses to nothing", () => {
    expect(parseFrom("garbage")).toEqual({ name: "", address: "" });
    expect(parseFrom("Ada Example <not an address>")).toEqual({ name: "Ada Example", address: "" });
  });

  test("no Subject", () => {
    expect(parse(thread(message({ subject: null })))?.subject).toBe("(no subject)");
    expect(parse(thread(message({ subject: "   " })))?.subject).toBe("(no subject)");
  });

  test("a very long subject with a line break in it becomes one line of 200 characters", () => {
    const subject = `Made-up\r\n ${"x".repeat(5000)}`;
    const stored = parse(thread(message({ subject })))?.subject ?? "";
    expect(stored).toHaveLength(200);
    expect(stored).not.toMatch(/[\r\n]/);
    expect(stored.startsWith("Made-up x")).toBe(true);
  });

  test("a very long sender name is cut to 100 characters", () => {
    const from = `${"N".repeat(500)} <ada@example-fund.test>`;
    expect(parse(thread(message({ from })))?.fromName).toHaveLength(100);
  });

  test("header names in any case", () => {
    const json = {
      messages: [
        {
          labelIds: ["INBOX"],
          internalDate: String(AT),
          payload: {
            headers: [
              { name: "FROM", value: "Ada Example <ada@example-fund.test>" },
              { name: "subject", value: "Made-up subject" },
            ],
          },
        },
      ],
    };
    expect(parse(json)).toMatchObject({ fromName: "Ada Example", subject: "Made-up subject" });
    const listed = {
      messages: [{ ...json.messages[0]!, payload: { headers: [...json.messages[0]!.payload.headers, { name: "list-id", value: "<x.example.test>" }] } }],
    };
    expect(parse(listed)).toBeNull();
  });

  test("a header that is not a name and a value is skipped, not trusted", () => {
    const json = thread(message());
    (json.messages[0]!.payload.headers as unknown[]).unshift(null, { name: "From" }, { name: 7, value: "x" });
    expect(parse(json)).toMatchObject({ fromAddress: "ada@example-fund.test" });
  });
});

describe("parseThread: a response that is not a thread", () => {
  test.each([
    ["null", null],
    ["an empty object", {}],
    ["no messages", { messages: [] }],
    ["messages that is not a list", { messages: "x" }],
    ["a message that is not an object", { messages: ["x"] }],
    ["a message with no internalDate", { messages: [{ labelIds: ["INBOX"], payload: { headers: [] } }] }],
    ["an internalDate that is not a number", { messages: [{ ...message(), internalDate: "soon" }] }],
  ])("%s fails the read", (_name, json) => {
    const error = thrown(() => parse(json));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(THREAD_SHAPE);
  });

  test("no thrown message contains anything Gmail sent", () => {
    const json = { messages: [{ ...message({ subject: "REMOTE-SUBJECT" }), internalDate: "REMOTE-DATE" }] };
    const error = thrown(() => parse(json));
    expect(error.message).toBe(THREAD_SHAPE);
    expect(error.message).not.toContain("REMOTE");
  });
});

describe("parseThreadList", () => {
  test("the ids, in order", () => {
    expect(parseThreadList({ threads: [{ id: "19a0b1c2d3e4f5a6" }, { id: "0f" }] })).toEqual([
      "19a0b1c2d3e4f5a6",
      "0f",
    ]);
  });

  test("an empty inbox answers with no threads field", () => {
    expect(parseThreadList({})).toEqual([]);
    expect(parseThreadList({ threads: [] })).toEqual([]);
  });

  test("an id listed twice is read once", () => {
    expect(parseThreadList({ threads: [{ id: "0a" }, { id: "0a" }] })).toEqual(["0a"]);
  });

  test.each([
    ["a path", "../../labels"],
    ["a query", "0a?format=full"],
    ["upper case", "0A"],
    ["empty", ""],
    ["33 characters", "a".repeat(33)],
    ["a number", 7],
  ])("an id that is %s is refused: the id goes into a URL path", (_name, id) => {
    const error = thrown(() => parseThreadList({ threads: [{ id: "0a" }, { id }] }));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(LIST_SHAPE);
  });

  test.each([["null", null], ["a list", []], ["text", "x"], ["threads as text", { threads: "x" }], ["a thread that is not an object", { threads: ["0a"] }]])(
    "%s is not an inbox list",
    (_name, json) => {
      expect(thrown(() => parseThreadList(json)).message).toBe(LIST_SHAPE);
    },
  );
});
