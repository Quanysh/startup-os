// Mercury's JSON turned into snapshot rows. Pure: no fetch, no clock, so it is
// tested against fixtures. Money is added up in whole cents and only divided
// back into dollars at the end, so a month of payments never drifts by a
// fraction of a cent.

import { z } from "zod";
import { isSubsidiaryCounterparty } from "../lib/company";
import { featureOn } from "../lib/featureGates";
import { periodStart, previousPeriodStart } from "../lib/periods";
import type { SnapshotInput } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";

const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a timestamp");

const accountsPage = z.object({
  accounts: z.array(
    z.object({ id: z.string(), status: z.string(), type: z.string(), currentBalance: z.number() }),
  ),
});

const treasuryPage = z.object({
  accounts: z.array(z.object({ currentBalance: z.number() })),
});

const transaction = z
  .object({
    id: z.string(),
    amount: z.number(),
    status: z.string(),
    kind: z.string(),
    postedAt: timestamp.nullish(),
    createdAt: timestamp,
    // Read for one thing only: whether the payment went to the subsidiary.
    // The name is dropped here, in the parse, so no caller can keep it.
    counterpartyName: z.string().nullish(),
  })
  .transform(({ counterpartyName, ...rest }) => ({
    ...rest,
    toSubsidiary: isSubsidiaryCounterparty(counterpartyName),
  }));
export type MercuryTransaction = z.infer<typeof transaction>;

const transactionsPage = z.object({ total: z.number(), transactions: z.array(transaction) });

/**
 * Parse, or fail in words short and safe enough for the run log: where the
 * shape differed, and nothing of what Mercury sent.
 */
function expectShape<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const where = result.error.issues[0]?.path.join(".") ?? "";
  throw new ConnectorError(`Mercury's ${what} response is not in the expected shape (${where}).`);
}

const cents = (dollars: number) => Math.round(dollars * 100);

/**
 * Startup's own Mercury accounts, sorted by what each list is for.
 *
 * - `ids` and `balanceCents`: open accounts only (`active`). Cash is what is
 *   spendable today, so a closed, pending or deleted account holds none.
 * - `flowIds`: `active` and `archived`. A closed account's payments still
 *   happened, and leaving it out would silently drop them from every month
 *   that is re-read, understating spending. `deleted` and `pending` accounts
 *   have no history worth counting.
 *
 * `external` (a linked outside bank) and `recipient` (someone Startup pays) are
 * not Startup's accounts and are in neither list: anything else is the default
 * to refuse, not to include.
 */
export function parseAccounts(raw: unknown): {
  ids: string[];
  flowIds: string[];
  balanceCents: number;
} {
  const own = expectShape(accountsPage, raw, "accounts").accounts.filter(
    (a) => a.type === "mercury",
  );
  const open = own.filter((a) => a.status === "active");
  return {
    ids: open.map((a) => a.id),
    flowIds: own.filter((a) => a.status === "active" || a.status === "archived").map((a) => a.id),
    balanceCents: open.reduce((sum, a) => sum + cents(a.currentBalance), 0),
  };
}

/**
 * What Treasury holds, in cents. No Treasury account is zero. Every account
 * listed is counted whatever its status: the docs do not list Treasury's
 * statuses, and leaving out one we did not recognise would understate cash.
 */
export function parseTreasury(raw: unknown): number {
  return expectShape(treasuryPage, raw, "treasury").accounts.reduce(
    (sum, a) => sum + cents(a.currentBalance),
    0,
  );
}

export function parseTransactions(raw: unknown) {
  return expectShape(transactionsPage, raw, "transactions");
}

/** The current month and the `count - 1` before it, oldest first. */
export function windowMonths(now: number, count: number): string[] {
  const months = [periodStart("month", now)];
  while (months.length < count) months.unshift(previousPeriodStart("month", months[0]!));
  return months;
}

// Money moving between Startup's own accounts is neither income nor spending.
const OWN_TRANSFERS = new Set(["internalTransfer", "treasuryTransfer"]);

/** The UTC month a transaction counts in: when it posted, else when it was created. */
const monthOf = (t: MercuryTransaction) =>
  periodStart("month", Date.parse(t.postedAt ?? t.createdAt));

export type MonthFlow = {
  periodStart: string;
  inCents: number;
  outCents: number;
  /** Of `outCents`, what was sent to the subsidiary (Globex). */
  toSubsidiaryCents: number;
};

/**
 * Money in and out per month, from posted transactions, and the part of
 * money out that was sent to the subsidiary. That part stays inside
 * `outCents`, which is the bank's total: Startup's own net burn includes the
 * funding, and the group takes it back out where it adds Globex's spending.
 *
 * Covers the months in `months` from the first month Mercury shows any
 * activity, counting every transaction whatever its status and including
 * any from before the window: one of those shows the account existed, so the
 * window starts as zeros rather than as a gap. From there on a quiet month is
 * a zero; before it, nothing is written, because "no transactions" there
 * means the account did not exist yet or the request did not reach that far,
 * not that nothing was spent. With no transaction at or before the window's
 * end, the result is empty.
 *
 * A transaction listed twice (overlapping pages) is counted once.
 */
export function monthlyFlows(
  transactions: readonly MercuryTransaction[],
  months: readonly string[],
): MonthFlow[] {
  if (transactions.length === 0 || months.length === 0) return [];
  const unique = [...new Map(transactions.map((t) => [t.id, t])).values()];
  // An earlier month than the window's own is no trouble: the filter below
  // starts the window at its first month, as zeros.
  const first = unique.map(monthOf).reduce((a, b) => (a < b ? a : b));

  const byMonth = new Map<string, MonthFlow>(
    months
      .filter((month) => month >= first)
      .map((month) => [month, { periodStart: month, inCents: 0, outCents: 0, toSubsidiaryCents: 0 }]),
  );
  for (const t of unique) {
    if (t.status !== "sent" || OWN_TRANSFERS.has(t.kind)) continue;
    const flow = byMonth.get(monthOf(t));
    if (!flow) continue;
    const amount = cents(t.amount);
    if (amount >= 0) flow.inCents += amount;
    else {
      flow.outCents -= amount;
      if (t.toSubsidiary) flow.toSubsidiaryCents -= amount;
    }
  }
  return [...byMonth.values()];
}

export function toSnapshots(input: {
  cashCents: number;
  flows: readonly MonthFlow[];
  now: number;
}): SnapshotInput[] {
  const usd = (
    key: string,
    period: "day" | "month",
    start: string,
    valueCents: number,
  ): SnapshotInput => ({
    key,
    scope: "us",
    period,
    periodStart: start,
    value: valueCents / 100,
    currency: "USD",
  });
  return [
    usd("cash", "day", periodStart("day", input.now), input.cashCents),
    ...input.flows.map((f) => usd("cash_in", "month", f.periodStart, f.inCents)),
    ...input.flows.map((f) => usd("cash_out", "month", f.periodStart, f.outCents)),
    // What went to the subsidiary, where the second company is one (convex/lib/features.ts).
    ...(featureOn("subsidiaryFunding")
      ? input.flows.map((f) => usd("cash_to_subsidiary", "month", f.periodStart, f.toSubsidiaryCents))
      : []),
  ];
}
