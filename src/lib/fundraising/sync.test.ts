import { describe, expect, test } from "vitest";
import type { BoardCard } from "@/lib/pipeline/derive";
import { investorCard, investorRows, syncStateOf, type InvestorCard } from "./sync";
import { bulkRefusalWords, syncErrorWords } from "./words";

const base: BoardCard = {
  id: "i1",
  name: "Example Ventures",
  stage: "meeting",
  amount: null,
  lastActivityAt: null,
  closedAt: null,
  nextStep: null,
  mirrored: true,
  source: "visible",
  contact: null,
  sourceStage: null,
  notes: null,
};
const card = (extra: Partial<InvestorCard>): InvestorCard => ({ ...investorCard(base), ...extra });

describe("investorCard", () => {
  test("a card from a server without sync reads as before: no sync, dragged only when made here", () => {
    expect(investorCard(base)).toMatchObject({ sync: null, changedInVisible: false, draggable: false, editable: false });
    expect(investorCard({ ...base, mirrored: false, source: "manual" })).toMatchObject({ draggable: true, editable: true });
  });
  test("what the server says wins", () => {
    expect(investorCard({ ...base, draggable: true, editable: true })).toMatchObject({ draggable: true, editable: true });
  });
});

describe("syncStateOf", () => {
  test("pending and sent are syncing; confirmed and none are nothing", () => {
    expect(syncStateOf(card({ sync: { status: "pending", queuedAt: 1 } }))).toBe("syncing");
    expect(syncStateOf(card({ sync: { status: "sent", queuedAt: 1 } }))).toBe("syncing");
    expect(syncStateOf(card({ sync: { status: "confirmed", queuedAt: 1 } }))).toBe("none");
    expect(syncStateOf(card({}))).toBe("none");
  });
  test("a failure outranks a change made in Visible, which outranks nothing", () => {
    expect(syncStateOf(card({ sync: { status: "failed", errorCode: "x", queuedAt: 1 }, changedInVisible: true }))).toBe("failed");
    expect(syncStateOf(card({ changedInVisible: true }))).toBe("changed");
  });
});

describe("investorRows", () => {
  test("every stage in board order, then Unsorted", () => {
    const rows = investorRows({
      unmapped: [{ ...base, id: "u" }],
      passed: [{ ...base, id: "p", stage: "passed" }],
      target: [{ ...base, id: "t", stage: "target" }],
    });
    expect(rows.map((row) => row.id)).toEqual(["t", "p", "u"]);
  });
});

describe("words", () => {
  test("a known code reads as a sentence; an unknown one never shows the code", () => {
    expect(syncErrorWords("unmapped_stage")).toBe("Visible has no stage that matches");
    expect(syncErrorWords("something_new")).toBe("Visible did not take the change");
    expect(syncErrorWords(undefined)).toBe("Visible did not take the change");
    expect(bulkRefusalWords("not_found")).toBe("It is no longer on the board.");
    expect(bulkRefusalWords("weird")).toBe("That change could not be saved.");
    expect(syncErrorWords("constructor")).toBe("Visible did not take the change");
  });
});
