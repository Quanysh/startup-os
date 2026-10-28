import { describe, expect, test } from "vitest";
import {
  MAX_ACK_RESULTS,
  changeOf,
  mergeFields,
  mergeNote,
  noteText,
  parseAck,
  sameSyncValue,
} from "./investorSync";

const card = (extra: Record<string, unknown> = {}) => ({
  name: "Made-up Capital",
  stage: "target",
  amount: undefined as number | undefined,
  nextStep: undefined as string | undefined,
  notes: undefined as string | undefined,
  ...extra,
});

describe("changeOf: what an edit queues for Visible", () => {
  test("nothing changed queues nothing", () => {
    expect(changeOf(card(), card())).toEqual({ fields: {}, note: undefined });
  });

  test("stage, amount and name are fields; a cleared amount is null", () => {
    expect(changeOf(card({ amount: 5 }), card({ stage: "meeting", name: "Renamed", amount: undefined }))).toEqual({
      fields: { stage: "meeting", name: "Renamed", amount: null },
      note: undefined,
    });
  });

  test("a changed next step or note is a note; a cleared one is null", () => {
    expect(changeOf(card({ notes: "old" }), card({ nextStep: "Call", notes: undefined }))).toEqual({
      fields: {},
      note: { nextStep: "Call", notes: null },
    });
  });
});

describe("merging into a queued row: the latest value of each field wins", () => {
  test("fields", () => {
    expect(mergeFields({ stage: "contacted", amount: 5 }, { stage: "meeting", name: "N" })).toEqual({
      stage: "meeting",
      amount: 5,
      name: "N",
    });
  });
  test("notes", () => {
    expect(mergeNote(undefined, undefined)).toBeUndefined();
    expect(mergeNote({ nextStep: "a" }, { notes: "b" })).toEqual({ nextStep: "a", notes: "b" });
    expect(mergeNote({ nextStep: "a" }, { nextStep: null })).toEqual({ nextStep: null });
  });
});

describe("noteText: the note written to Visible", () => {
  test("says each part on its own line, and a cleared one as cleared", () => {
    expect(noteText({ nextStep: "Send the deck", notes: null })).toBe("Next step: Send the deck\nNotes: (cleared)");
    expect(noteText({ notes: "Met at the summit" })).toBe("Notes: Met at the summit");
    expect(noteText(undefined)).toBeUndefined();
    expect(noteText({})).toBeUndefined();
  });
});

describe("sameSyncValue: whether Visible now holds what was queued", () => {
  test("stage and name compare as stored; a missing amount equals a cleared one", () => {
    expect(sameSyncValue("stage", "meeting", "meeting")).toBe(true);
    expect(sameSyncValue("stage", "unmapped", "meeting")).toBe(false);
    expect(sameSyncValue("amount", undefined, null)).toBe(true);
    expect(sameSyncValue("amount", 5, 5)).toBe(true);
    expect(sameSyncValue("amount", 6, 5)).toBe(false);
    expect(sameSyncValue("name", " Fund ", "Fund")).toBe(true);
  });
});

describe("parseAck: what the run says it did", () => {
  const ok = { id: "abc", revision: 0, ok: true };

  test("a good ack passes", () => {
    const read = parseAck({
      results: [ok, { id: "def", revision: 2, ok: false, errorCode: "unmapped_stage" }, { id: "ghi", revision: 0, ok: true, visibleId: "inv_8f2c" }],
    });
    expect(read).toEqual({
      ok: true,
      results: [ok, { id: "def", revision: 2, ok: false, errorCode: "unmapped_stage" }, { id: "ghi", revision: 0, ok: true, visibleId: "inv_8f2c" }],
    });
  });

  test.each([
    ["not an object", [], "results"],
    ["no results", {}, "results"],
    ["an extra key", { results: [ok], more: 1 }, "results"],
    ["an empty list", { results: [] }, "results"],
    ["an extra field on a result", { results: [{ ...ok, name: "Made-up" }] }, "results.0"],
    ["a failure without a code", { results: [{ id: "a", revision: 0, ok: false }] }, "results.0.errorCode"],
    ["a success with a code", { results: [{ ...ok, errorCode: "x" }] }, "results.0.errorCode"],
    ["a failure with a Visible id", { results: [{ id: "a", revision: 0, ok: false, errorCode: "x", visibleId: "v" }] }, "results.0.visibleId"],
    ["a code that is free text", { results: [{ id: "a", revision: 0, ok: false, errorCode: "Visible said no" }] }, "results.0.errorCode"],
    ["a Visible id with spaces", { results: [{ ...ok, visibleId: "a b" }] }, "results.0.visibleId"],
    ["a negative revision", { results: [{ ...ok, revision: -1 }] }, "results.0.revision"],
    ["the same id twice", { results: [ok, ok] }, "results.1.id"],
  ])("refuses %s, in a path and fixed words", (_what, raw, path) => {
    const read = parseAck(raw);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.issues[0]!.path).toBe(path);
    // Nothing sent is quoted back.
    expect(JSON.stringify(read.issues)).not.toMatch(/Made-up|Visible said no|a b/);
  });

  test("refuses more results than an outbox lists", () => {
    const results = Array.from({ length: MAX_ACK_RESULTS + 1 }, (_, i) => ({ ...ok, id: `id${i}` }));
    expect(parseAck({ results }).ok).toBe(false);
  });
});
