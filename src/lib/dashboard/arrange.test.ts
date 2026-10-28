import { describe, expect, test } from "vitest";
import { FOCUSES, type Focus } from "@convex/lib/focus";
import { AREAS, areasOf, type Area } from "@convex/lib/roles";
import {
  BLOCK_AREAS,
  DASHBOARD_BLOCKS,
  DASHBOARD_ORDER,
  arrange,
  arrangementNote,
  type BlockId,
} from "./arrange";

const flat = (focus: Focus, areas: readonly Area[]) => {
  const { lead, rest } = arrange(focus, areas);
  return [...lead, ...rest];
};
// Everything a teammate could hold: `personal` is the owner's alone.
const without = (...gone: Area[]) => AREAS.filter((area) => !gone.includes(area));

// The whole table, written out: the order of each focus for someone with
// every area, the lead blocks first (before the bar).
const TABLE: Record<Focus, string> = {
  founder: "money | customers sales fundraising product engineering gtm work compliance",
  sales: "sales | gtm customers money fundraising product engineering work compliance",
  engineering: "engineering | product money customers sales fundraising gtm work compliance",
  marketing: "gtm | product money customers sales fundraising engineering work compliance",
  customers: "customers | sales money fundraising product engineering gtm work compliance",
  finance: "money | compliance customers sales fundraising product engineering gtm work",
  general: "money | customers sales fundraising product engineering gtm work compliance",
};

describe("the dashboard's order, by focus", () => {
  test.each(FOCUSES)("%s, with every area", (focus) => {
    const [lead, rest] = TABLE[focus].split(" | ").map((part) => part.split(" "));
    expect(arrange(focus, AREAS)).toEqual({ lead, rest });
  });

  test("every focus places every block, once", () => {
    for (const focus of FOCUSES) {
      const order = DASHBOARD_ORDER[focus];
      const placed = [...order.lead, ...order.rest];
      expect(new Set(placed).size).toBe(placed.length);
      expect([...placed].sort()).toEqual([...DASHBOARD_BLOCKS].sort());
      // One or two of the focus's own lead.
      expect(order.lead.length).toBeGreaterThanOrEqual(1);
      expect(order.lead.length).toBeLessThanOrEqual(2);
    }
  });

  test("the company's numbers and health only: no brief, no ask, no tasks of the viewer's own", () => {
    // The Dashboard answers "how is the company doing?". The brief is Today's
    // and the Assistant's, asking is the Assistant's, a person's own tasks Today's.
    expect(DASHBOARD_BLOCKS).not.toContain("brief");
    expect(DASHBOARD_BLOCKS).not.toContain("tasks");
    // The work block is the team's goals, issues and board counts, not a person's own day.
    expect(BLOCK_AREAS.work).toEqual(["scorecard", "board"]);
  });

  test("the founder's order is the page as it was", () => {
    const before = ["money", "customers", "sales", "fundraising", "product", "gtm", "work", "compliance"];
    expect(flat("founder", AREAS).filter((id) => before.includes(id))).toEqual(before);
  });
});

describe("a block whose area the person lacks", () => {
  test("is absent, and the rest keep their order", () => {
    // Without the area the focus is named for: nothing is put in its place.
    expect(arrange("sales", without("sales"))).toEqual({
      lead: [],
      rest: ["gtm", "customers", "money", "fundraising", "product", "engineering", "work", "compliance"],
    });
  });

  test.each(FOCUSES)("%s: each block is there exactly when one of its areas is held", (focus) => {
    for (const block of DASHBOARD_BLOCKS) {
      const lacking = without(...BLOCK_AREAS[block]);
      expect(flat(focus, lacking)).not.toContain(block);
      // And the others are as they were, in the same order.
      expect(flat(focus, lacking)).toEqual(
        flat(focus, AREAS).filter((id) => BLOCK_AREAS[id as BlockId].some((a) => lacking.includes(a))),
      );
    }
  });

  test("a focus gives nothing: an engineer arranged for finance gets no money and no payroll", () => {
    expect(arrange("finance", areasOf("engineer"))).toEqual({
      lead: [],
      rest: ["product", "engineering", "work"],
    });
    expect(arrange("founder", [])).toEqual({ lead: [], rest: [] });
  });

  test("payroll has no block: its link left the Dashboard (the page is in the navigation)", () => {
    expect(DASHBOARD_BLOCKS as readonly string[]).not.toContain("payroll");
    expect(flat("finance", [...areasOf("cofounder"), "payroll"])).not.toContain("payroll");
    expect(Object.keys(BLOCK_AREAS)).not.toContain("payroll");
  });
});

describe("the line under the title", () => {
  test("a teammate is told what it is arranged for and who sets it", () => {
    expect(arrangementNote({ focus: "sales", roleName: "Sales", isOwner: false })).toBe(
      "Arranged for Sales. The owner sets this on the Team page.",
    );
    expect(arrangementNote({ focus: "customers", roleName: "Clinic care", isOwner: false })).toBe(
      "Arranged for Customers (your role: Clinic care). The owner sets this on the Team page.",
    );
  });

  test("the owner is told where it is set", () => {
    expect(arrangementNote({ focus: "founder", roleName: "Owner", isOwner: true })).toBe(
      "Arranged for Founder. You set what each role's pages are arranged for on the Team page.",
    );
  });
});
