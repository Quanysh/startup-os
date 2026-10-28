import { describe, expect, test } from "vitest";
import type { PartnerCard } from "@convex/lib/partnerStages";
import {
  PARTNER_COLUMNS,
  nextStepState,
  readLayout,
  sortedForTable,
  valueText,
  writeLayout,
} from "./view";

const NOW = Date.UTC(2026, 9, 18, 12);
const base: PartnerCard = {
  id: "p",
  company: "us",
  name: "Made-up Co",
  type: "channel",
  stage: "in_talks",
  owner: null,
  contact: null,
  contactRole: null,
  value: null,
  valueKind: null,
  notes: null,
  nextStep: null,
  nextStepOn: null,
  lastActivityAt: NOW,
  links: [],
  editedBy: null,
};

describe("the columns", () => {
  test("one per stage, in pipeline order, each with a hint", () => {
    expect(PARTNER_COLUMNS.map((column) => column.id)).toEqual([
      "identified",
      "contacted",
      "in_talks",
      "agreement",
      "live",
      "paused",
      "lost",
    ]);
    for (const column of PARTNER_COLUMNS) expect(column.hint).toBeTruthy();
  });
});

describe("a value in words", () => {
  test("referrals a month, and revenue in the company's currency", () => {
    expect(valueText({ ...base, value: 1, valueKind: "referrals" })).toBe("1 referral/mo");
    expect(valueText({ ...base, value: 12, valueKind: "referrals" })).toBe("12 referrals/mo");
    expect(valueText({ ...base, value: 2500, valueKind: "revenue" })).toBe("$2,500/mo");
    expect(valueText({ ...base, company: "kz", value: 400000, valueKind: "revenue" })).toBe("₸400K/mo");
  });
  test("no value, no words", () => {
    expect(valueText(base)).toBeNull();
  });
});

describe("a next step against today", () => {
  test("none, upcoming, due today, overdue", () => {
    expect(nextStepState(base, "2026-10-18")).toBe("none");
    expect(nextStepState({ ...base, nextStepOn: "2026-10-19" }, "2026-10-18")).toBe("upcoming");
    expect(nextStepState({ ...base, nextStepOn: "2026-10-18" }, "2026-10-18")).toBe("today");
    expect(nextStepState({ ...base, nextStepOn: "2026-10-17" }, "2026-10-18")).toBe("overdue");
  });
  test("a finished partnership has no overdue step", () => {
    expect(nextStepState({ ...base, stage: "live", nextStepOn: "2026-01-01" }, "2026-10-18")).toBe("upcoming");
    expect(nextStepState({ ...base, stage: "lost", nextStepOn: "2026-01-01" }, "2026-10-18")).toBe("upcoming");
  });
});

describe("the layout is in the address", () => {
  test("the board unless the table is asked for", () => {
    expect(readLayout(new URLSearchParams(""))).toBe("board");
    expect(readLayout(new URLSearchParams("view=table"))).toBe("table");
    expect(readLayout(new URLSearchParams("view=nonsense"))).toBe("board");
  });
  test("written back without the default", () => {
    expect(writeLayout("board")).toBe("");
    expect(writeLayout("table")).toBe("view=table");
  });
});

describe("the table's order", () => {
  test("by stage in pipeline order, then by name", () => {
    const rows = [
      { ...base, id: "1", name: "B", stage: "live" as const },
      { ...base, id: "2", name: "Z", stage: "identified" as const },
      { ...base, id: "3", name: "A", stage: "live" as const },
    ];
    expect(sortedForTable(rows).map((row) => row.id)).toEqual(["2", "3", "1"]);
  });
});
