import { describe, expect, test } from "vitest";
import { inCashGroup } from "./cashGroup";

const base = { goal: null, agent: "engineering", botWritesCash: false, draftAbout: null, metricSection: null };

describe("the Cash and runway group", () => {
  test("a goal tagged cash, or one whose title is about cash, a raise or collections", () => {
    expect(inCashGroup({ ...base, goal: { cash: true, title: "Made-up" } })).toBe(true);
    expect(inCashGroup({ ...base, goal: { cash: false, title: "Close the pre-seed raise" } })).toBe(true);
    expect(inCashGroup({ ...base, goal: { cash: false, title: "Collections under 30 days" } })).toBe(true);
    expect(inCashGroup({ ...base, goal: { cash: false, title: "Ship the scheduler" } })).toBe(false);
  });

  test("a proposer in fundraising or finance, a draft to an investor, a finance metric as evidence", () => {
    expect(inCashGroup({ ...base, agent: "finance" })).toBe(true);
    expect(inCashGroup({ ...base, botWritesCash: true })).toBe(true);
    expect(inCashGroup({ ...base, draftAbout: "investor" })).toBe(true);
    expect(inCashGroup({ ...base, draftAbout: "customer" })).toBe(false);
    expect(inCashGroup({ ...base, metricSection: "finance" })).toBe(true);
    expect(inCashGroup({ ...base, metricSection: "product" })).toBe(false);
    expect(inCashGroup(base)).toBe(false);
  });
});
