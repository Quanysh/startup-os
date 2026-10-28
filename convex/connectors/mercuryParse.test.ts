import { describe, expect, test } from "vitest";
import { COMPANIES, isSubsidiaryCounterparty } from "../lib/company";
import { validateSnapshots } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import {
  ACCOUNTS,
  CHECKING_TRANSACTIONS,
  SAVINGS_TRANSACTIONS,
  SUBSIDIARY_NAME,
  TREASURY,
  toSubsidiary,
  tx,
} from "./mercury.fixtures";
import {
  monthlyFlows,
  parseAccounts,
  parseTransactions,
  parseTreasury,
  toSnapshots,
  windowMonths,
} from "./mercuryParse";

const NOW = Date.UTC(2026, 9, 12, 6);
const MONTHS = ["2026-08-01", "2026-09-01", "2026-10-01"];
const parsed = (list: unknown[]) =>
  parseTransactions({ total: list.length, transactions: list }).transactions;
const all = [
  ...parseTransactions(CHECKING_TRANSACTIONS).transactions,
  ...parseTransactions(SAVINGS_TRANSACTIONS).transactions,
];

describe("parseAccounts", () => {
  test("counts open Mercury accounts only", () => {
    expect(parseAccounts(ACCOUNTS).ids).toEqual(["acc-checking", "acc-savings"]);
    expect(parseAccounts(ACCOUNTS).balanceCents).toBe(15_000_075);
  });

  test("a closed account's payments still count in the months, though its balance does not", () => {
    const { ids, flowIds } = parseAccounts(ACCOUNTS);
    expect(ids).not.toContain("acc-closed");
    expect(flowIds).toEqual(["acc-checking", "acc-savings", "acc-closed"]);
  });

  test("pending, deleted, external and recipient accounts are in neither list, nor the balance", () => {
    const { ids, flowIds, balanceCents } = parseAccounts(ACCOUNTS);
    for (const left of ["acc-pending", "acc-deleted", "acc-external", "acc-recipient"]) {
      expect(ids, left).not.toContain(left);
      expect(flowIds, left).not.toContain(left);
    }
    // 120,000.50 + 30,000.25, and none of 999, 5,000, 111, 222 or 333.
    expect(balanceCents).toBe(15_000_075);
  });

  test("balances are added in whole cents, not as floating-point dollars", () => {
    const open = (currentBalance: number, id: string) => ({
      id,
      status: "active",
      type: "mercury",
      currentBalance,
    });
    const cents = (...balances: number[]) =>
      parseAccounts({ accounts: balances.map((b, i) => open(b, `a${i}`)) }).balanceCents;
    expect(cents(0.1, 0.2)).toBe(30);
    // 1.15 * 100 is 114.99999999999999: cutting it instead of rounding loses a cent.
    expect(cents(0.1, 0.2, 1.15)).toBe(145);
  });

  test("a response in another shape is refused, naming where", () => {
    expect(() => parseAccounts({ data: [] })).toThrow(
      "Mercury's accounts response is not in the expected shape (accounts).",
    );
    expect(() =>
      parseAccounts({ accounts: [{ id: "a", status: "active", type: "mercury" }] }),
    ).toThrow("Mercury's accounts response is not in the expected shape (accounts.0.currentBalance).");
  });

  test("the refusal is in the connector's own words, so it may be logged", () => {
    expect(() => parseAccounts(null)).toThrow(ConnectorError);
  });
});

describe("parseTransactions", () => {
  test("a timestamp that is not one is refused, naming where", () => {
    const bad = tx("b", -1, "outgoingPayment", null, { createdAt: "yesterday" });
    expect(() => parseTransactions({ total: 1, transactions: [bad] })).toThrow(
      new ConnectorError(
        "Mercury's transactions response is not in the expected shape (transactions.0.createdAt).",
      ),
    );
  });
});

describe("the subsidiary: the second company is the first's subsidiary", () => {
  test("the bank's name for it is matched whatever its capitals or alphabet", () => {
    for (const name of [SUBSIDIARY_NAME, "Too Northwind", "ТОО Northwind", "northwind llp"]) {
      expect(isSubsidiaryCounterparty(name), name).toBe(true);
    }
    for (const name of ["Example Co", "North Wind Supplies", "", null, undefined]) {
      expect(isSubsidiaryCounterparty(name), String(name)).toBe(false);
    }
  });

  test("Globex's company is named once, beside the company definitions", () => {
    expect(COMPANIES.kz).toMatchObject({ name: "Globex", legalName: "Globex LLP", parent: "us" });
    expect(COMPANIES.us).toMatchObject({ name: "Startup", legalName: "Startup Inc" });
    expect(COMPANIES.us).not.toHaveProperty("parent");
  });

  test("a counterparty's name is read only to mark a payment to the subsidiary: it is not kept", () => {
    const [mine, other] = parsed([
      toSubsidiary("r1", 500, "2026-10-02T12:00:00Z"),
      tx("o1", -20, "outgoingPayment", "2026-10-03T12:00:00Z"),
    ]);
    expect(mine).toMatchObject({ id: "r1", toSubsidiary: true });
    expect(other).toMatchObject({ id: "o1", toSubsidiary: false });
    expect(mine).not.toHaveProperty("counterpartyName");
    const text = JSON.stringify([mine, other]);
    expect(text).not.toMatch(/northwind/i);
    expect(text).not.toContain("Example Co");
  });

  test("a transaction with no counterparty name is not the subsidiary's", () => {
    const { counterpartyName: _unused, ...nameless } = tx("n", -5, "outgoingPayment", "2026-10-02T12:00:00Z");
    expect(parsed([nameless, tx("m", -5, "outgoingPayment", "2026-10-02T12:00:00Z", { counterpartyName: null })]))
      .toMatchObject([{ toSubsidiary: false }, { toSubsidiary: false }]);
  });
});

describe("parseTreasury", () => {
  test("adds up Treasury balances", () => {
    expect(parseTreasury(TREASURY)).toBe(25_000_000);
  });

  test("every Treasury account is added, not only the first", () => {
    expect(
      parseTreasury({
        accounts: [{ currentBalance: 250_000 }, { currentBalance: 1_000.5 }],
      }),
    ).toBe(25_100_050);
  });

  test("no Treasury account is zero", () => {
    expect(parseTreasury({ accounts: [], page: {} })).toBe(0);
  });
});

describe("windowMonths", () => {
  test("the current month and the ones before it, oldest first", () => {
    expect(windowMonths(NOW, 3)).toEqual(MONTHS);
  });

  test("crosses a year boundary", () => {
    expect(windowMonths(Date.UTC(2027, 0, 5), 3)).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ]);
  });
});

describe("monthlyFlows", () => {
  const flows = monthlyFlows(all, MONTHS);
  const month = (start: string) => flows.find((f) => f.periodStart === start);

  test("money in and out per month, in whole cents", () => {
    expect(month("2026-10-01")).toEqual({
      periodStart: "2026-10-01",
      inCents: 1_201_244, // 12,000.10 + 12.34
      outCents: 400_005,
      toSubsidiaryCents: 0,
    });
    expect(month("2026-08-01")).toEqual({ periodStart: "2026-08-01", inCents: 10_000_000, outCents: 0, toSubsidiaryCents: 0 });
  });

  test("transfers between Startup's own accounts are neither", () => {
    // t3, t4 and s1 would add 51,000 out and 1,000 in to October.
    expect(month("2026-10-01")?.outCents).toBe(400_005);
    expect(month("2026-10-01")?.inCents).toBe(1_201_244);
  });

  test("pending and failed transactions are left out", () => {
    expect(month("2026-09-01")).toEqual({
      periodStart: "2026-09-01",
      inCents: 0,
      outCents: 250_050,
      toSubsidiaryCents: 0,
    });
  });

  test("a transaction belongs to the month it posted, not the one it was created in", () => {
    const late = parsed([
      tx("x", -10, "outgoingPayment", "2026-10-01T00:00:01Z", { createdAt: "2026-09-30T20:00:00Z" }),
    ]);
    expect(monthlyFlows(late, MONTHS)).toEqual([
      { periodStart: "2026-10-01", inCents: 0, outCents: 1_000, toSubsidiaryCents: 0 },
    ]);
  });

  test("whole cents are rounded, not cut: 1.15 + 2.30 + 4.35 is 7.80, in and out", () => {
    // 1.15 * 100 is 114.99999999999999 in floating point. Cutting it loses a
    // cent going in (floor and trunc both) but, for a negative amount, floor
    // happens to round the right way, so both directions are checked.
    const small = parsed([
      tx("a", -1.15, "outgoingPayment", "2026-10-02T12:00:00Z"),
      tx("b", -2.3, "outgoingPayment", "2026-10-03T12:00:00Z"),
      tx("c", -4.35, "outgoingPayment", "2026-10-04T12:00:00Z"),
      tx("d", 1.15, "externalTransfer", "2026-10-05T12:00:00Z"),
      tx("e", 2.3, "externalTransfer", "2026-10-06T12:00:00Z"),
      tx("f", 4.35, "externalTransfer", "2026-10-07T12:00:00Z"),
    ]);
    expect(monthlyFlows(small, MONTHS)).toEqual([
      { periodStart: "2026-10-01", inCents: 780, outCents: 780, toSubsidiaryCents: 0 },
    ]);
  });

  test("a month with only a failed payment is a zero, so an old figure does not stand", () => {
    const failedOnly = parsed([
      tx("f", -50, "outgoingPayment", "2026-09-05T12:00:00Z", { status: "failed" }),
    ]);
    expect(monthlyFlows(failedOnly, MONTHS)).toEqual([
      { periodStart: "2026-09-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
      { periodStart: "2026-10-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
    ]);
  });

  test("a payment from before the window shows the account existed, so the window starts as zeros", () => {
    const earlier = parsed([
      tx("jul", -40, "outgoingPayment", "2026-07-20T12:00:00Z"),
      tx("sep", -60, "outgoingPayment", "2026-09-05T12:00:00Z"),
    ]);
    expect(monthlyFlows(earlier, MONTHS)).toEqual([
      { periodStart: "2026-08-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
      { periodStart: "2026-09-01", inCents: 0, outCents: 6_000, toSubsidiaryCents: 0 },
      { periodStart: "2026-10-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
    ]);
  });

  test("transactions that are all after the window give no flows", () => {
    const later = parsed([tx("n", -5, "outgoingPayment", "2026-11-02T12:00:00Z")]);
    expect(monthlyFlows(later, MONTHS)).toEqual([]);
  });

  test("a transaction returned twice, by overlapping pages, is counted once", () => {
    const paid = tx("dup", -25, "outgoingPayment", "2026-10-02T12:00:00Z");
    const once = parsed([paid, tx("in", 10, "externalTransfer", "2026-10-03T12:00:00Z")]);
    const twice = parsed([paid, tx("in", 10, "externalTransfer", "2026-10-03T12:00:00Z"), paid]);
    expect(monthlyFlows(twice, MONTHS)).toEqual(monthlyFlows(once, MONTHS));
    expect(monthlyFlows(twice, MONTHS)).toEqual([
      { periodStart: "2026-10-01", inCents: 1_000, outCents: 2_500, toSubsidiaryCents: 0 },
    ]);
  });

  test("a transaction with no postedAt at all belongs to the month it was created", () => {
    const { postedAt: _unused, ...unposted } = tx("u", -8, "outgoingPayment", null, {
      createdAt: "2026-09-15T12:00:00Z",
    });
    expect(monthlyFlows(parsed([unposted]), MONTHS)).toEqual([
      { periodStart: "2026-09-01", inCents: 0, outCents: 800, toSubsidiaryCents: 0 },
      { periodStart: "2026-10-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
    ]);
  });

  test("a quiet month after the first is a zero, not a gap", () => {
    const august = parsed([tx("a", 500, "externalTransfer", "2026-08-10T12:00:00Z")]);
    expect(monthlyFlows(august, MONTHS)).toEqual([
      { periodStart: "2026-08-01", inCents: 50_000, outCents: 0, toSubsidiaryCents: 0 },
      { periodStart: "2026-09-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
      { periodStart: "2026-10-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
    ]);
  });

  test("months before Mercury has anything are not written as zeros", () => {
    // An account opened in October has no August or September to report.
    const october = parsed([tx("o", -300, "outgoingPayment", "2026-10-02T12:00:00Z")]);
    expect(monthlyFlows(october, MONTHS).map((f) => f.periodStart)).toEqual(["2026-10-01"]);
  });

  test("no transactions at all gives no flows, rather than three months of zeros", () => {
    expect(monthlyFlows([], MONTHS)).toEqual([]);
  });

  test("what was sent to the subsidiary is counted on its own, and stays inside money out", () => {
    const september = parsed([
      toSubsidiary("r1", 50_000, "2026-09-03T12:00:00Z"),
      toSubsidiary("r2", 0.15, "2026-09-20T12:00:00Z"),
      tx("o1", -2_000, "outgoingPayment", "2026-09-04T12:00:00Z"),
      // Money the subsidiary sent back is money in, not a negative transfer.
      tx("b1", 1_000, "externalTransfer", "2026-09-05T12:00:00Z", { counterpartyName: SUBSIDIARY_NAME }),
      // Not posted, or failed: not sent.
      toSubsidiary("r3", 9_000, "2026-09-06T12:00:00Z", { status: "pending" }),
      toSubsidiary("r4", 8_000, "2026-09-07T12:00:00Z", { status: "failed" }),
    ]);
    expect(monthlyFlows(september, MONTHS)).toEqual([
      { periodStart: "2026-09-01", inCents: 100_000, outCents: 5_200_015, toSubsidiaryCents: 5_000_015 },
      { periodStart: "2026-10-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
    ]);
  });

  test("a month with nothing sent to the subsidiary is a zero from the first month with activity, never before", () => {
    const flows = monthlyFlows(
      parsed([tx("o1", -10, "outgoingPayment", "2026-09-04T12:00:00Z"), toSubsidiary("r1", 30, "2026-10-02T12:00:00Z")]),
      MONTHS,
    );
    expect(flows.map((f) => [f.periodStart, f.toSubsidiaryCents])).toEqual([
      ["2026-09-01", 0],
      ["2026-10-01", 3_000],
    ]);
  });

  test("a transfer between Startup's own accounts is never the subsidiary's, whatever it is called", () => {
    const own = parsed([
      tx("i1", -400, "internalTransfer", "2026-10-02T12:00:00Z", { counterpartyName: SUBSIDIARY_NAME }),
      tx("i2", 400, "internalTransfer", "2026-10-02T12:00:00Z", { counterpartyName: SUBSIDIARY_NAME }),
    ]);
    expect(monthlyFlows(own, MONTHS)).toEqual([
      { periodStart: "2026-10-01", inCents: 0, outCents: 0, toSubsidiaryCents: 0 },
    ]);
  });

  test("transactions outside the window are ignored", () => {
    expect(monthlyFlows(all, ["2026-10-01"])).toEqual([
      { periodStart: "2026-10-01", inCents: 1_201_244, outCents: 400_005, toSubsidiaryCents: 0 },
    ]);
  });
});

describe("toSnapshots", () => {
  const rows = toSnapshots({
    cashCents: 40_000_075,
    flows: monthlyFlows(all, MONTHS),
    now: NOW,
  });

  test("today's cash, then each month's flows, in dollars", () => {
    expect(rows[0]).toEqual({
      key: "cash",
      scope: "us",
      period: "day",
      periodStart: "2026-10-12",
      value: 400_000.75,
      currency: "USD",
    });
    expect(rows.filter((r) => r.key === "cash_in").map((r) => r.value)).toEqual([100_000, 0, 12_012.44]);
    expect(rows.filter((r) => r.key === "cash_out").map((r) => r.value)).toEqual([0, 2_500.5, 4_000.05]);
  });

  test("what was sent to the subsidiary is a month's row of its own; money out is the bank's total still", () => {
    const funded = toSnapshots({
      cashCents: 40_000_075,
      flows: monthlyFlows([...all, ...parsed([toSubsidiary("r1", 64_000, "2026-09-15T12:00:00Z")])], MONTHS),
      now: NOW,
    });
    expect(funded.filter((r) => r.key === "cash_to_subsidiary")).toEqual(
      [0, 64_000, 0].map((value, i) => ({
        key: "cash_to_subsidiary",
        scope: "us",
        period: "month",
        periodStart: MONTHS[i],
        value,
        currency: "USD",
      })),
    );
    expect(funded.filter((r) => r.key === "cash_out").map((r) => r.value)).toEqual([0, 66_500.5, 4_000.05]);
    // Only the monthly sum leaves the parser: never the name it was matched on.
    expect(JSON.stringify(funded)).not.toMatch(/northwind/i);
  });

  test("the registry accepts every row from the mercury source", () => {
    expect(rows.some((r) => r.key === "cash_to_subsidiary")).toBe(true);
    expect(validateSnapshots("mercury", rows, undefined, { now: NOW })).toEqual([]);
  });
});
