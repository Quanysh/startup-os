// A made-up clinic for tests: an active Kazakhstan clinic with every signal
// good on 2026-10-12. Every name contains "SECRET", so one assertion can
// prove a surface holds none of them.

import type { Id } from "@convex/_generated/dataModel";
import type { CustomerRow } from "@convex/lib/customerShape";

let seq = 0;

export const clinic = (patch: Partial<CustomerRow> = {}): CustomerRow => {
  seq += 1;
  return {
    id: `c${seq}` as Id<"customers">,
    name: `SECRET CLINIC ${seq}`,
    market: "kz",
    status: "active",
    monthlyFee: 200_000,
    currency: "KZT",
    lastPaymentDate: "2026-10-01",
    amountOwed: 0,
    lastUsageDate: "2026-10-09",
    contractDate: null,
    baaDate: null,
    nextTouch: null,
    note: null,
    syncedAt: Date.UTC(2026, 9, 10),
    archived: false,
    dealId: null,
    fromSales: false,
    ...patch,
  };
};

export const US = { market: "us" as const, currency: "USD" };
