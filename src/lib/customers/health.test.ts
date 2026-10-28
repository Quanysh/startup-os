import { describe, expect, test } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import type { CustomerRow } from "@convex/lib/customerShape";
import { baaMissing, health, registerDayOf, type Health, type RegisterDay } from "./health";

// The day the register was last pushed. Ages are counted up to it, never to
// today: what the register said then is all that is known.
const PUSHED = "2026-09-30";
const REG: RegisterDay = { day: PUSHED, label: "Sep 30" };
const ago = (days: number) =>
  new Date(Date.parse(`${PUSHED}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** A clinic with every signal good. */
const clinic = (patch: Partial<CustomerRow> = {}): CustomerRow => ({
  id: "c1" as Id<"customers">,
  name: "SECRET CLINIC ALPHA",
  market: "kz",
  status: "active",
  monthlyFee: 200_000,
  currency: "KZT",
  lastPaymentDate: ago(11),
  amountOwed: 0,
  lastUsageDate: ago(3),
  contractDate: null,
  baaDate: null,
  nextTouch: null,
  note: null,
  syncedAt: 0,
  archived: false,
  dealId: null,
  fromSales: false,
  ...patch,
});

const assessed = (patch: Partial<CustomerRow>) => {
  const result = health(clinic(patch), REG);
  if (result.level === "not_assessed") throw new Error("expected an assessed clinic");
  return result;
};
const reason = (result: Exclude<Health, { level: "not_assessed" }>, signal: string) =>
  result.reasons.find((r) => r.signal === signal);

describe("health: overall", () => {
  test("every signal good is good, with each reason named", () => {
    expect(health(clinic(), REG)).toEqual({
      level: "good",
      unknown: [],
      reasons: [
        { signal: "payment", level: "good", text: "Paid 11 days before the register was pushed on Sep 30." },
        { signal: "owed", level: "good", text: "Owes nothing." },
        { signal: "usage", level: "good", text: "Used 3 days before the register was pushed on Sep 30." },
      ],
    });
  });

  test("the worst known signal decides", () => {
    expect(assessed({ lastUsageDate: ago(20) }).level).toBe("watch");
    expect(assessed({ lastUsageDate: ago(20), lastPaymentDate: ago(90) }).level).toBe("at_risk");
  });

  test("a clinic with no usage data is unknown on usage, not inactive", () => {
    const result = assessed({ lastUsageDate: null });
    expect(result.level).toBe("good");
    expect(result.unknown).toEqual(["usage"]);
    expect(reason(result, "usage")).toEqual({
      signal: "usage",
      level: "unknown",
      text: "No usage data.",
    });
  });

  test("nothing on record is unknown, never good and never at risk", () => {
    const result = assessed({ lastPaymentDate: null, amountOwed: null, lastUsageDate: null });
    expect(result.level).toBe("unknown");
    expect(result.unknown).toEqual(["payment", "owed", "usage"]);
  });

  test("an unknown signal does not hide a bad one", () => {
    expect(assessed({ lastPaymentDate: null, lastUsageDate: ago(40) }).level).toBe("at_risk");
  });

  test.each([
    [{ status: "paused" as const }, "Paused in the client register."],
    [{ status: "churned" as const }, "Churned in the client register."],
    [{ archived: true }, "No longer in the client register."],
    // Archived wins: it is the more final fact.
    [{ archived: true, status: "churned" as const }, "No longer in the client register."],
    // Won on the Sales board: the register holds nothing about it yet.
    [{ fromSales: true }, "Won on the Sales board and not in the client register yet: nothing on record to judge it by."],
  ])("%j is not assessed", (patch, why) => {
    // Even with a payment three months late: it is no longer a risk to act on.
    expect(health(clinic({ ...patch, lastPaymentDate: ago(90) }), REG)).toEqual({
      level: "not_assessed",
      why,
    });
  });
});

describe("health: payment", () => {
  test.each([
    [0, "good", "Paid on the day the register was pushed, Sep 30."],
    [1, "good", "Paid 1 day before the register was pushed on Sep 30."],
    [45, "good", "Paid 45 days before the register was pushed on Sep 30."],
    [46, "watch", "Last paid 46 days before the register was pushed on Sep 30 (watch after 45, at risk after 75)."],
    [75, "watch", "Last paid 75 days before the register was pushed on Sep 30 (watch after 45, at risk after 75)."],
    [76, "at_risk", "Last paid 76 days before the register was pushed on Sep 30 (watch after 45, at risk after 75)."],
  ])("%i days from the last payment to the push: %s", (days, level, text) => {
    expect(reason(assessed({ lastPaymentDate: ago(days) }), "payment")).toEqual({
      signal: "payment",
      level,
      text,
    });
  });

  test("no payment date is unknown, not late", () => {
    expect(reason(assessed({ lastPaymentDate: null }), "payment")).toMatchObject({
      level: "unknown",
      text: "No payment date on record.",
    });
  });

  test("a payment dated ahead is unknown, not good", () => {
    expect(reason(assessed({ lastPaymentDate: ago(-2) }), "payment")).toMatchObject({
      level: "unknown",
      text: "The last payment is dated after the register was pushed on Sep 30.",
    });
  });
});

describe("health: amount owed", () => {
  const owed = (amountOwed: number | null, monthlyFee: number | null = 200_000) =>
    reason(assessed({ amountOwed, monthlyFee }), "owed");

  test.each([
    [120_000, "good", "Owes ₸120K: 0.6 months of fees (watch above 1, at risk above 2)."],
    [200_000, "good", "Owes ₸200K: 1.0 months of fees (watch above 1, at risk above 2)."],
    // The level is judged on the figure as shown: 1.04 months reads "1.0",
    // and "1.0 months (watch above 1)" must not be a watch.
    [208_000, "good", "Owes ₸208K: 1.0 months of fees (watch above 1, at risk above 2)."],
    [220_000, "watch", "Owes ₸220K: 1.1 months of fees (watch above 1, at risk above 2)."],
    [400_000, "watch", "Owes ₸400K: 2.0 months of fees (watch above 1, at risk above 2)."],
    [408_000, "watch", "Owes ₸408K: 2.0 months of fees (watch above 1, at risk above 2)."],
    [420_000, "at_risk", "Owes ₸420K: 2.1 months of fees (watch above 1, at risk above 2)."],
    [600_000, "at_risk", "Owes ₸600K: 3.0 months of fees (watch above 1, at risk above 2)."],
  ])("owing %i against a fee of 200,000: %s", (amount, level, text) => {
    expect(owed(amount)).toEqual({ signal: "owed", level, text });
  });

  test("owing nothing is good, whatever the fee", () => {
    expect(owed(0, null)).toEqual({ signal: "owed", level: "good", text: "Owes nothing." });
  });

  test("no balance on record is unknown, not zero", () => {
    expect(owed(null)).toEqual({ signal: "owed", level: "unknown", text: "No balance on record." });
  });

  test.each([[null], [0]])("a balance with a fee of %j cannot be sized, so it is watched", (fee) => {
    expect(owed(120_000, fee)).toEqual({
      signal: "owed",
      level: "watch",
      text: "Owes ₸120K, with no monthly fee on record to compare it with.",
    });
  });

  test("a US clinic's balance is in dollars", () => {
    expect(
      reason(assessed({ market: "us", currency: "USD", amountOwed: 1_500, monthlyFee: 1_000 }), "owed")
        ?.text,
    ).toBe("Owes $1,500: 1.5 months of fees (watch above 1, at risk above 2).");
  });
});

describe("health: usage", () => {
  test.each([
    [0, "good", "Used on the day the register was pushed, Sep 30."],
    [1, "good", "Used 1 day before the register was pushed on Sep 30."],
    [14, "good", "Used 14 days before the register was pushed on Sep 30."],
    [15, "watch", "Not used for 15 days before the register was pushed on Sep 30 (watch after 14, at risk after 30)."],
    [30, "watch", "Not used for 30 days before the register was pushed on Sep 30 (watch after 14, at risk after 30)."],
    [31, "at_risk", "Not used for 31 days before the register was pushed on Sep 30 (watch after 14, at risk after 30)."],
  ])("%i days from the last use to the push: %s", (days, level, text) => {
    expect(reason(assessed({ lastUsageDate: ago(days) }), "usage")).toEqual({
      signal: "usage",
      level,
      text,
    });
  });

  test("a use dated ahead is unknown", () => {
    expect(reason(assessed({ lastUsageDate: ago(-1) }), "usage")).toMatchObject({
      level: "unknown",
      text: "The last use is dated after the register was pushed on Sep 30.",
    });
  });
});

describe("health: counted to the day the register was pushed", () => {
  test("the same register gives the same verdict however long ago it was pushed", () => {
    // 40 days before the push is good. Read two months later it is still 40
    // days before the push: nothing is known about the time since.
    const paid = { lastPaymentDate: ago(40), lastUsageDate: ago(10) };
    const result = assessed(paid);
    expect(result.level).toBe("good");
    expect(reason(result, "payment")?.text).toBe(
      "Paid 40 days before the register was pushed on Sep 30.",
    );
  });

  test("with no push on record there is no day to count to, so payment and usage are unknown", () => {
    const result = health(clinic(), null);
    expect(result).toMatchObject({ level: "good", unknown: ["payment", "usage"] });
    if (result.level === "not_assessed") throw new Error("expected an assessed clinic");
    expect(reason(result, "payment")?.text).toBe(
      "The register's push date is not on record, so there is no day to count to.",
    );
  });
});

describe("registerDayOf", () => {
  test("the owner's calendar day of the last push, named with its year once that is not this year", () => {
    const pushed = new Date(2026, 8, 30, 15).getTime();
    expect(registerDayOf(pushed, new Date(2026, 9, 12).getTime())).toEqual({
      day: "2026-09-30",
      label: "Sep 30",
    });
    expect(registerDayOf(pushed, new Date(2027, 0, 5).getTime())?.label).toBe("Sep 30, 2026");
    expect(registerDayOf(null, 0)).toBeNull();
  });
});

describe("health: what it never says", () => {
  test("no reason names the clinic", () => {
    const result = assessed({ lastPaymentDate: ago(90), amountOwed: 600_000, lastUsageDate: ago(40) });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("baaMissing", () => {
  const us = { market: "us" as const, currency: "USD" };

  test("an active US clinic with no BAA date on record", () => {
    expect(baaMissing(clinic(us))).toBe(true);
    expect(baaMissing(clinic({ ...us, baaDate: "2026-03-03" }))).toBe(false);
  });

  test("not a Kazakhstan clinic, and not one that is paused, churned or archived", () => {
    expect(baaMissing(clinic())).toBe(false);
    expect(baaMissing(clinic({ ...us, status: "paused" }))).toBe(false);
    expect(baaMissing(clinic({ ...us, status: "churned" }))).toBe(false);
    expect(baaMissing(clinic({ ...us, archived: true }))).toBe(false);
  });
});
