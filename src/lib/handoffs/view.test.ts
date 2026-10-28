import { describe, expect, test } from "vitest";
import { botsOf, filterHandoffs, readView, since, unacceptedOf, writeView, type HandoffRow } from "./view";

const row = (over: Partial<HandoffRow>): HandoffRow =>
  ({
    id: "h",
    company: "us",
    from: "Research",
    to: "Growth",
    title: "T",
    summary: "",
    links: [],
    status: "open",
    reason: null,
    openSince: 0,
    createdAt: 0,
    updatedAt: 0,
    history: [],
    ...over,
  }) as HandoffRow;

describe("the view in the address", () => {
  test("reads a status and a bot, and ignores what is not one", () => {
    expect(readView(new URLSearchParams("status=done&bot=Growth Bot"))).toEqual({ status: "done", bot: "growth_bot" });
    expect(readView(new URLSearchParams("status=nope&bot=%20"))).toEqual({ status: null, bot: null });
  });
  test("writes only what differs from the default", () => {
    expect(writeView({ status: null, bot: null })).toBe("");
    expect(writeView({ status: "open", bot: "growth" })).toBe("status=open&bot=growth");
  });
});

describe("narrowing", () => {
  const rows = [row({ id: "1" as never }), row({ id: "2" as never, from: "Growth", to: "Ops", status: "done" })];
  test("by status and by bot, either end", () => {
    expect(filterHandoffs(rows, { status: "done", bot: null }).map((r) => r.id)).toEqual(["2"]);
    expect(filterHandoffs(rows, { status: null, bot: "growth" }).map((r) => r.id)).toEqual(["1", "2"]);
    expect(filterHandoffs(rows, { status: null, bot: "ops" }).map((r) => r.id)).toEqual(["2"]);
  });
  test("the bots named, once each", () => {
    expect(botsOf(rows).map((b) => b.key)).toEqual(["growth", "ops", "research"]);
  });
  test("unaccepted: open for more than a day", () => {
    const day = 24 * 3_600_000;
    expect(unacceptedOf(rows, day + 1).map((r) => r.id)).toEqual(["1"]);
    expect(unacceptedOf(rows, day)).toEqual([]);
  });
  test("since", () => {
    expect(since(0, 5 * 60_000)).toBe("5 min");
    expect(since(0, 3 * 3_600_000)).toBe("3 h");
    expect(since(0, 72 * 3_600_000)).toBe("3 days");
  });
});
