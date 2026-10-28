import { describe, expect, test } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import type { CustomerRow } from "@convex/lib/customerShape";
import { customerAttention, registerIsStale } from "./attention";

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 86_400_000;
const FRESH = NOW - 2 * DAY;

let seq = 0;
const clinic = (patch: Partial<CustomerRow> = {}): CustomerRow => ({
  id: `c${++seq}` as Id<"customers">,
  name: `SECRET CLINIC ${seq}`,
  market: "kz",
  status: "active",
  monthlyFee: 200_000,
  currency: "KZT",
  lastPaymentDate: "2026-10-01",
  amountOwed: 0,
  lastUsageDate: null,
  contractDate: null,
  baaDate: null,
  nextTouch: null,
  note: null,
  syncedAt: FRESH,
  archived: false,
  dealId: null,
  fromSales: false,
  ...patch,
});
const late = { lastPaymentDate: "2026-06-01" };

describe("customerAttention", () => {
  test("nothing to say about healthy clinics", () => {
    expect(customerAttention([clinic(), clinic()], FRESH, NOW)).toEqual([]);
  });

  test("clinics at risk are counted, not named", () => {
    const items = customerAttention([clinic(late), clinic(late), clinic()], FRESH, NOW);
    expect(items).toEqual([
      {
        id: "customers:at_risk",
        severity: "risk",
        title: "2 clinics are at risk",
        detail: "Late payment, a large balance or no recent use. The list gives each reason.",
        href: "/customers?health=at_risk",
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("SECRET");
  });

  test("one clinic reads in the singular", () => {
    expect(customerAttention([clinic(late)], FRESH, NOW)[0]?.title).toBe(
      "1 clinic is at risk",
    );
  });

  test("a churned or archived clinic is never counted as at risk", () => {
    expect(
      customerAttention(
        [clinic({ ...late, status: "churned" }), clinic({ ...late, archived: true })],
        FRESH,
        NOW,
      ),
    ).toEqual([]);
  });

  test("an ageing register does not make a clinic later than it is known to be", () => {
    // Paid 30 days before a push made 60 days ago. Counted to today that is 90
    // days and at risk; counted to the push it is 30 and good. The register
    // being old is said once, on its own line.
    const pushed = NOW - 60 * DAY;
    const paid = new Date(pushed - 30 * DAY).toISOString().slice(0, 10);
    expect(customerAttention([clinic({ lastPaymentDate: paid })], pushed, NOW).map((i) => i.id)).toEqual(
      ["customers:stale"],
    );
  });

  test("a churned clinic that still owes money is counted, on its own line", () => {
    const churned = { status: "churned" as const };
    const items = customerAttention(
      [
        clinic({ ...churned, amountOwed: 450_000 }),
        clinic({ ...churned, amountOwed: 1 }),
        clinic({ ...churned, amountOwed: 0 }),
        clinic({ ...churned, amountOwed: null }),
        clinic({ ...churned, amountOwed: 450_000, archived: true }),
        clinic({ status: "paused", amountOwed: 450_000 }),
      ],
      FRESH,
      NOW,
    );
    expect(items).toEqual([
      {
        id: "customers:churned_owing",
        severity: "risk",
        title: "2 churned clinics still owe money",
        detail: "They are not assessed for health, so the balance shows nowhere else.",
        href: "/customers?health=not_assessed",
      },
    ]);
    expect(
      customerAttention([clinic({ ...churned, amountOwed: 5 })], FRESH, NOW)[0]?.title,
    ).toBe("1 churned clinic still owes money");
    expect(JSON.stringify(items)).not.toContain("SECRET");
  });

  test("a US clinic with no BAA date is said to have none on record", () => {
    const us = { market: "us" as const, currency: "USD" };
    const items = customerAttention(
      [clinic(us), clinic({ ...us, baaDate: "2026-03-03" }), clinic({ ...us, status: "churned" })],
      FRESH,
      NOW,
    );
    expect(items).toEqual([
      {
        id: "customers:baa",
        severity: "empty",
        title: "1 US clinic has no BAA date on record",
        detail: "Add the date to the client register once the agreement is signed.",
        href: "/customers?baa=missing",
      },
    ]);
  });

  test("a Kazakhstan clinic needs no BAA", () => {
    expect(customerAttention([clinic({ baaDate: null })], FRESH, NOW)).toEqual([]);
  });

  test("a register not pushed for more than 14 days is said to be out of date", () => {
    const pushed = Date.UTC(2026, 7, 20, 9);
    expect(customerAttention([clinic({ lastPaymentDate: "2026-08-10" })], pushed, NOW)).toEqual([
      {
        id: "customers:stale",
        severity: "stale",
        title: "The client register is out of date",
        detail: "Last pushed Aug 20. Nothing since then is known: each clinic reads as it stood that day.",
        href: "/customers",
      },
    ]);
  });

  test("before any push there is nothing to be out of date", () => {
    expect(customerAttention([], null, NOW)).toEqual([]);
  });

  test("no item ever names a clinic, whatever is wrong", () => {
    const us = { market: "us" as const, currency: "USD" };
    const items = customerAttention(
      [
        clinic({ lastPaymentDate: "2026-01-01" }),
        clinic({ ...us, lastPaymentDate: "2026-01-01" }),
        clinic({ amountOwed: 900_000 }),
        clinic({ status: "churned", amountOwed: 900_000 }),
      ],
      Date.UTC(2026, 5, 1),
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual([
      "customers:at_risk",
      "customers:churned_owing",
      "customers:baa",
      "customers:stale",
    ]);
    expect(JSON.stringify(items)).not.toContain("SECRET");
  });
});

describe("registerIsStale", () => {
  test("14 days is still current; a moment more is not", () => {
    expect(registerIsStale(NOW - 14 * DAY, NOW)).toBe(false);
    expect(registerIsStale(NOW - 14 * DAY - 1, NOW)).toBe(true);
  });

  test("never pushed is not stale: there is nothing to be stale", () => {
    expect(registerIsStale(null, NOW)).toBe(false);
  });
});
