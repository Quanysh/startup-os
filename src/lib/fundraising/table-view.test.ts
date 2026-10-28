import { describe, expect, test } from "vitest";
import type { InvestorCard } from "./sync";
import {
  DEFAULT_INVESTOR_VIEW,
  filterInvestors,
  readInvestorView,
  sortInvestors,
  writeInvestorView,
} from "./table-view";

const DAY = 86_400_000;
const inv = (name: string, extra: Partial<InvestorCard> = {}): InvestorCard => ({
  id: name,
  name,
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
  sync: null,
  changedInVisible: false,
  editable: true,
  draggable: true,
  ...extra,
});

describe("the view in the address", () => {
  test("the default writes nothing and the board is the default layout", () => {
    expect(writeInvestorView(DEFAULT_INVESTOR_VIEW)).toBe("");
    expect(readInvestorView(new URLSearchParams(""))).toEqual(DEFAULT_INVESTOR_VIEW);
  });

  test("round-trips layout, stage, sync and sort", () => {
    const view = {
      layout: "table",
      stage: "diligence",
      sync: "failed",
      sort: { key: "amount", dir: "desc" },
    } as const;
    const written = writeInvestorView(view);
    expect(written).toBe("view=table&stage=diligence&sync=failed&sort=amount&dir=desc");
    expect(readInvestorView(new URLSearchParams(written))).toEqual(view);
  });

  test("anything it does not know falls back to the default", () => {
    expect(readInvestorView(new URLSearchParams("view=list&stage=lead&sync=x&sort=notes"))).toEqual(
      DEFAULT_INVESTOR_VIEW,
    );
  });
});

describe("filterInvestors", () => {
  const rows = [
    inv("Alpha", { stage: "target", nextStep: "Send the deck" }),
    inv("Beta", { stage: "committed", sync: { status: "pending", queuedAt: 1 } }),
    inv("Gamma", { stage: "meeting", sync: { status: "failed", errorCode: "x", queuedAt: 1 } }),
    inv("Delta", { stage: "unmapped", changedInVisible: true, contact: "Sam Example" }),
  ];
  const names = (list: InvestorCard[]) => list.map((row) => row.name);
  const view = { ...DEFAULT_INVESTOR_VIEW, layout: "table" as const };

  test("open is still in play; closed is committed and passed; all is every one", () => {
    expect(names(filterInvestors(rows, view, ""))).toEqual(["Alpha", "Gamma", "Delta"]);
    expect(names(filterInvestors(rows, { ...view, stage: "closed" }, ""))).toEqual(["Beta"]);
    expect(names(filterInvestors(rows, { ...view, stage: "all" }, ""))).toHaveLength(4);
    expect(names(filterInvestors(rows, { ...view, stage: "target" }, ""))).toEqual(["Alpha"]);
  });

  test("by what it says about Visible, and by words in its name, contact or next step", () => {
    const all = { ...view, stage: "all" as const };
    expect(names(filterInvestors(rows, { ...all, sync: "syncing" }, ""))).toEqual(["Beta"]);
    expect(names(filterInvestors(rows, { ...all, sync: "failed" }, ""))).toEqual(["Gamma"]);
    expect(names(filterInvestors(rows, { ...all, sync: "changed" }, ""))).toEqual(["Delta"]);
    expect(names(filterInvestors(rows, { ...all, sync: "none" }, ""))).toEqual(["Alpha"]);
    expect(names(filterInvestors(rows, all, "deck"))).toEqual(["Alpha"]);
    expect(names(filterInvestors(rows, all, "sam"))).toEqual(["Delta"]);
  });
});

describe("sortInvestors", () => {
  const rows = [
    inv("A", { amount: 50, lastActivityAt: 3 * DAY, stage: "diligence" }),
    inv("B", { amount: null, lastActivityAt: 9 * DAY, stage: "target", sync: { status: "failed", queuedAt: 1 } }),
    inv("C", { amount: 200, lastActivityAt: null, stage: "unmapped", changedInVisible: true, nextStep: "Call" }),
  ];
  const order = (key: "amount" | "activity" | "stage" | "sync" | "nextStep", dir: "asc" | "desc" = "asc") =>
    sortInvestors(rows, { key, dir }).map((row) => row.name);

  test("each column sorts; a blank sorts last", () => {
    expect(order("amount")).toEqual(["A", "C", "B"]);
    expect(order("amount", "desc")).toEqual(["C", "A", "B"]);
    expect(order("activity", "desc")).toEqual(["B", "A", "C"]);
    expect(order("stage")).toEqual(["B", "A", "C"]);
    expect(order("sync")).toEqual(["B", "C", "A"]);
    expect(order("nextStep")).toEqual(["C", "A", "B"]);
  });
});
