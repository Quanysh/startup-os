import { describe, expect, test } from "vitest";
import { handoffAttention } from "./attention/handoffs";
import {
  HANDOFF_REPAIR_NOTE,
  HANDOFF_STALE_MS,
  HANDOFF_WORDS,
  MAX_HANDOFF_HISTORY,
  addressKeys,
  answerKeys,
  assignBot,
  botKey,
  botMayAct,
  callerName,
  cleanBotName,
  isUnaccepted,
  profileClash,
  repairedAddressee,
  sharedAgentWarning,
  withEntry,
} from "./handoffs";

describe("bot names", () => {
  test("two spellings of one bot share a key", () => {
    expect(botKey("Growth")).toBe("growth");
    expect(botKey(" growth-bot ")).toBe(botKey("Growth Bot"));
  });
  test("a blank or very long name is refused", () => {
    expect(() => cleanBotName("   ")).toThrow();
    expect(() => cleanBotName("x".repeat(41))).toThrow();
    expect(cleanBotName("  Growth \n bot ")).toBe("Growth bot");
  });
  test("the caller is the header's agent, else the argument, else the client", () => {
    expect(callerName({ header: "sales", argument: "growth", clientName: "Claude" })).toBe("sales");
    expect(callerName({ argument: "growth", clientName: "Claude" })).toBe("growth");
    expect(callerName({ clientName: "Claude Code on the Mac" })).toBe("Claude Code on the Mac");
    expect(callerName({})).toBe("agent");
  });
});

describe("who a bot id is stored as", () => {
  test("a bare external id is the bot profile, with a warning; bot: and mac: are explicit", () => {
    expect(assignBot("engineering")).toEqual({
      to: "bot:engineering",
      toKey: "bot:engineering",
      warning: sharedAgentWarning("engineering"),
    });
    expect(assignBot(" Engineering ")).toEqual(assignBot("engineering"));
    expect(assignBot("bot:chief_of_staff").warning).toBeNull();
    expect(assignBot("bot:FINANCE")).toMatchObject({ to: "bot:finance", toKey: "bot:finance", warning: null });
    expect(assignBot("mac:engineering")).toEqual({ to: "mac:engineering", toKey: "mac:engineering", warning: null });
    expect(assignBot("growth")).toEqual({ to: "growth", toKey: "growth", warning: null });
    expect(assignBot("bot:growth")).toEqual({ to: "bot:growth", toKey: "bot_growth", warning: null });
  });

  test("a to filter of the slug and of bot:id names the same stored keys", () => {
    expect(addressKeys("engineering")).toEqual(["bot:engineering", "engineering"]);
    expect(addressKeys("ENGINEERING")).toEqual(addressKeys("engineering"));
    expect(addressKeys("bot:engineering")).toEqual(["bot:engineering", "engineering"]);
    expect(addressKeys("mac:finance")).toEqual(["mac:finance"]);
    expect(addressKeys("growth")).toEqual(["growth"]);
    expect(addressKeys(" Bahram@Example.TEST ")).toEqual(["@bahram@example.test"]);
  });

  test("the profile answers the stored key and a legacy bare row; the Mac agent answers only mac:", () => {
    const open = { status: "open" } as const;
    expect(answerKeys("bot:engineering")).toEqual(["bot:engineering", "engineering"]);
    expect(answerKeys("engineering")).toEqual(["mac:engineering"]);
    expect(answerKeys("mac:engineering")).toEqual(["mac:engineering"]);
    expect(answerKeys("growth")).toEqual(["growth"]);
    expect(answerKeys("@ada@example.com")).toEqual(["@ada@example.com"]);
    expect(botMayAct({ ...open, toKey: "@ada@example.com" }, "@ada@example.com", "accept", "")).toBeNull();
    expect(botMayAct({ ...open, toKey: "@ada@example.com" }, "@other@example.com", "accept", "")).toBe(HANDOFF_WORDS.notYours);
    expect(botMayAct({ ...open, toKey: "engineering" }, "bot:engineering", "accept", "")).toBeNull();
    expect(botMayAct({ ...open, toKey: "bot:engineering" }, "bot:engineering", "accept", "")).toBeNull();
    expect(botMayAct({ ...open, toKey: "engineering" }, "engineering", "accept", "")).toBe(HANDOFF_WORDS.notYours);
    expect(botMayAct({ ...open, toKey: "mac:engineering" }, "engineering", "accept", "")).toBeNull();
    expect(botMayAct({ ...open, toKey: "bot:engineering" }, "engineering", "accept", "")).toBe(HANDOFF_WORDS.notYours);
    expect(botMayAct({ ...open, toKey: "growth" }, "growth", "accept", "")).toBeNull();
  });

  test("two profiles on one key are a clash; the Mac form matches none", () => {
    const profiles = [
      { botId: "growth", name: "Growth" },
      { botId: "research", name: "growth" },
    ];
    expect(profileClash(assignBot("growth"), profiles)).toBe(true);
    expect(profileClash(assignBot("engineering"), [{ botId: "engineering", name: "Engineering" }])).toBe(false);
    expect(profileClash(assignBot("mac:engineering"), profiles)).toBe(false);
    expect(profileClash({ toKey: "bot:growth" }, [{ botId: "growth", name: "Growth" }])).toBe(false);
  });

  test("only an open-shaped bare external id is rewritten to the profile", () => {
    expect(repairedAddressee("engineering", undefined)).toEqual({ to: "bot:engineering", toKey: "bot:engineering" });
    expect(repairedAddressee("chief_of_staff", undefined)?.to).toBe("bot:chief_of_staff");
    expect(repairedAddressee("finance", undefined)?.to).toBe("bot:finance");
    expect(repairedAddressee("engineering", "person")).toBeNull();
    expect(repairedAddressee("bot:engineering", undefined)).toBeNull();
    expect(repairedAddressee("mac:engineering", undefined)).toBeNull();
    expect(repairedAddressee("growth", undefined)).toBeNull();
    expect(HANDOFF_REPAIR_NOTE).toBe("Addressed to the bot profile.");
  });
});

describe("who may answer", () => {
  const open = { status: "open", toKey: "growth" } as const;
  test("only the receiving bot", () => {
    expect(botMayAct(open, "research", "accept", "")).toBe(HANDOFF_WORDS.notYours);
    expect(botMayAct(open, "growth", "accept", "")).toBeNull();
  });
  test("accepting needs open; done may follow open or accepted", () => {
    expect(botMayAct({ ...open, status: "accepted" }, "growth", "accept", "")).toBe(HANDOFF_WORDS.needsAccept);
    expect(botMayAct({ ...open, status: "accepted" }, "growth", "done", "")).toBeNull();
    expect(botMayAct(open, "growth", "done", "")).toBeNull();
  });
  test("a decline needs a reason; nothing finished changes", () => {
    expect(botMayAct(open, "growth", "decline", "  ")).toBe(HANDOFF_WORDS.needsReason);
    expect(botMayAct(open, "growth", "decline", "No capacity")).toBeNull();
    for (const status of ["done", "declined", "closed"] as const) {
      expect(botMayAct({ status, toKey: "growth" }, "growth", "done", "")).toBe(HANDOFF_WORDS.finished);
    }
  });
});

describe("history and staleness", () => {
  test("history keeps the newest entries", () => {
    let history: ReturnType<typeof withEntry> = [];
    for (let i = 0; i < MAX_HANDOFF_HISTORY + 5; i++) history = withEntry(history, { at: i, by: "a", action: "accept" });
    expect(history).toHaveLength(MAX_HANDOFF_HISTORY);
    expect(history[0]!.at).toBe(5);
  });
  test("open and unanswered for more than a day is unaccepted", () => {
    const now = 10 * HANDOFF_STALE_MS;
    expect(isUnaccepted({ status: "open", openSince: now - HANDOFF_STALE_MS - 1 }, now)).toBe(true);
    expect(isUnaccepted({ status: "open", openSince: now - HANDOFF_STALE_MS }, now)).toBe(false);
    expect(isUnaccepted({ status: "accepted", openSince: 0 }, now)).toBe(false);
  });
  test("Needs you gets one line with a count, or nothing", () => {
    const now = 10 * HANDOFF_STALE_MS;
    expect(handoffAttention([{ status: "open", openSince: now }], now)).toEqual([]);
    expect(handoffAttention(undefined, now)).toEqual([]);
    const old = { status: "open", openSince: 0 } as const;
    const [item] = handoffAttention([old, old], now);
    expect(item).toMatchObject({ id: "handoffs-unaccepted", href: "/handoffs", title: "2 handoffs have no taker" });
  });

  test("a person's own stale handoff is a line of its own, not counted twice", () => {
    const now = 10 * HANDOFF_STALE_MS;
    const mine = { status: "open", openSince: 0, person: true, mine: true } as const;
    const theirs = { status: "open", openSince: 0, person: true, mine: false } as const;
    const items = handoffAttention([mine, mine, theirs], now);
    expect(items).toEqual([
      expect.objectContaining({ id: "handoffs-unaccepted", title: "1 handoff has no taker" }),
      expect.objectContaining({ id: "handoffs-yours", href: "/handoffs?status=open", title: "2 handoffs to you wait for an answer" }),
    ]);
    expect(handoffAttention([mine], now).map((i) => i.id)).toEqual(["handoffs-yours"]);
  });
});
