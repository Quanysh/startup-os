import { describe, expect, test } from "vitest";
import type { MetricDef } from "./metricRegistry";
import { validateSnapshots, type SnapshotInput } from "./snapshotRules";

// A fixed registry so these rules stay tested as the real one grows.
const REGISTRY: readonly MetricDef[] = [
  {
    key: "cash",
    label: "Cash",
    section: "finance",
    unit: "currency",
    grain: "day",
    better: "up",
    sources: { us: "mercury", kz: "manual" },
    staleAfterDays: 2,
    min: 0,
  },
  {
    key: "paying_clinics",
    label: "Paying clinics",
    section: "finance",
    unit: "count",
    grain: "month",
    better: "up",
    sources: { kz: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
    integer: true,
  },
  {
    key: "fx_usd_kzt",
    label: "USD/KZT rate",
    section: "finance",
    unit: "ratio",
    grain: "month",
    better: "down",
    sources: { company: "manual" },
    staleAfterDays: 45,
    min: 100,
    max: 2_000,
  },
  {
    // A money metric in a scope that has no market currency.
    key: "infra_cost",
    label: "Infrastructure cost",
    section: "product",
    unit: "currency",
    grain: "month",
    better: "down",
    sources: { startup_insights: "manual" },
    staleAfterDays: 45,
  },
  {
    // Money in a scope with no market currency, billed in one currency whatever the market.
    key: "token_cost",
    label: "Token cost",
    section: "finance",
    unit: "currency",
    currency: "USD",
    grain: "month",
    better: "down",
    sources: { kz_product: "posthog" },
    staleAfterDays: 45,
  },
];

const kzCash: SnapshotInput = {
  key: "cash",
  scope: "kz",
  period: "day",
  periodStart: "2026-10-12",
  value: 1_250_000,
  currency: "KZT",
};

const check = (source: string, rows: SnapshotInput[]) =>
  validateSnapshots(source, rows, REGISTRY);

describe("validateSnapshots", () => {
  test("a metric's own currency stands where its scope has none, and no other is taken", () => {
    const row = { key: "token_cost", scope: "kz_product", period: "month" as const, periodStart: "2026-09-01", value: 64.3 };
    expect(check("posthog", [{ ...row, currency: "USD" }])).toEqual([]);
    expect(check("posthog", [{ ...row, currency: "KZT" }])[0]).toMatchObject({
      field: "currency",
      message: '"kz_product" amounts are stored in USD.',
    });
  });

  test("accepts a row from the metric's authoritative source", () => {
    expect(check("manual", [kzCash])).toEqual([]);
  });

  test("rejects a metric key that is not in the registry", () => {
    const issues = check("manual", [{ ...kzCash, key: "vibes" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ index: 0, field: "key" });
  });

  test("rejects a scope the metric does not have", () => {
    const issues = check("manual", [{ ...kzCash, scope: "company" }]);
    expect(issues[0]).toMatchObject({ index: 0, field: "scope" });
  });

  test("rejects a write from a source that is not authoritative for that scope", () => {
    // US cash belongs to the Mercury sync; a manual entry must not overwrite it.
    const issues = check("manual", [{ ...kzCash, scope: "us", currency: "USD" }]);
    expect(issues[0]).toMatchObject({ index: 0, field: "source" });
  });

  test("rejects a period other than the metric's grain", () => {
    const issues = check("manual", [
      { ...kzCash, period: "month", periodStart: "2026-10-01" },
    ]);
    expect(issues[0]).toMatchObject({ index: 0, field: "period" });
  });

  test("rejects a periodStart that is not the start of its bucket", () => {
    const issues = check("cfo_workbook", [
      {
        key: "paying_clinics",
        scope: "kz",
        period: "month",
        periodStart: "2026-10-12",
        value: 14,
      },
    ]);
    expect(issues[0]).toMatchObject({ index: 0, field: "periodStart" });
  });

  test("rejects a value that is not a finite number", () => {
    expect(check("manual", [{ ...kzCash, value: Number.NaN }])[0]).toMatchObject({
      field: "value",
    });
    expect(
      check("manual", [{ ...kzCash, value: Number.POSITIVE_INFINITY }])[0],
    ).toMatchObject({ field: "value" });
  });

  test("requires a currency on a currency metric", () => {
    const { currency: _omit, ...noCurrency } = kzCash;
    expect(check("manual", [noCurrency])[0]).toMatchObject({ field: "currency" });
  });

  test("rejects a currency the OS does not handle", () => {
    expect(check("manual", [{ ...kzCash, currency: "EUR" }])[0]).toMatchObject({
      field: "currency",
    });
  });

  test("Kazakhstan amounts must be in tenge", () => {
    // Stored in KZT and converted at read; a dollar figure here would be
    // divided by the exchange rate a second time.
    const issues = check("manual", [{ ...kzCash, currency: "USD" }]);
    expect(issues[0]).toMatchObject({ index: 0, field: "currency" });
  });

  test("US amounts must be in dollars", () => {
    const issues = check("mercury", [{ ...kzCash, scope: "us", currency: "KZT" }]);
    expect(issues[0]).toMatchObject({ index: 0, field: "currency" });
  });

  test("rejects a currency on a metric that is not money", () => {
    const issues = check("cfo_workbook", [
      {
        key: "paying_clinics",
        scope: "kz",
        period: "month",
        periodStart: "2026-10-01",
        value: 14,
        currency: "KZT",
      },
    ]);
    expect(issues[0]).toMatchObject({ field: "currency" });
  });

  test("rejects two rows for the same metric, scope and bucket in one batch", () => {
    const issues = check("manual", [kzCash, { ...kzCash, value: 2 }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ index: 1, field: "periodStart" });
  });

  test("reports the index of the offending row", () => {
    const issues = check("manual", [kzCash, { ...kzCash, periodStart: "2026-10-13", key: "nope" }]);
    expect(issues.map((i) => i.index)).toEqual([1]);
  });
});

describe("validateSnapshots: plausibility", () => {
  const clinics = (value: number) => ({
    key: "paying_clinics",
    scope: "kz",
    period: "month" as const,
    periodStart: "2026-10-01",
    value,
  });
  const rate = (value: number) => ({
    key: "fx_usd_kzt",
    scope: "company",
    period: "month" as const,
    periodStart: "2026-10-01",
    value,
  });

  test("a value below the metric's minimum is refused", () => {
    expect(check("manual", [{ ...kzCash, value: -1 }])[0]).toMatchObject({ field: "value" });
    expect(check("cfo_workbook", [clinics(-2)])[0]).toMatchObject({ field: "value" });
  });

  test("a count must be a whole number", () => {
    expect(check("cfo_workbook", [clinics(13.5)])[0]).toMatchObject({ field: "value" });
    expect(check("cfo_workbook", [clinics(13)])).toEqual([]);
  });

  test("an exchange rate off by a factor of ten is refused", () => {
    // 44 instead of 440 would multiply Kazakhstan revenue by ten.
    expect(check("manual", [rate(44)])[0]).toMatchObject({
      field: "value",
      // Named as the owner knows it, since this is shown in the entry form.
      message: "USD/KZT rate cannot be below 100.",
    });
    expect(check("manual", [rate(4_400)])[0]).toMatchObject({ field: "value" });
    expect(check("manual", [rate(500)])).toEqual([]);
  });

  test("money in a scope with no market currency is refused rather than guessed", () => {
    const issues = check("manual", [
      {
        key: "infra_cost",
        scope: "startup_insights",
        period: "month",
        periodStart: "2026-10-01",
        value: 120,
        currency: "USD",
      },
    ]);
    expect(issues[0]).toMatchObject({ field: "currency" });
  });
});

describe("validateSnapshots: time", () => {
  const NOW = Date.UTC(2026, 9, 12, 12); // 12 Oct 2026, a Monday
  const at = (rows: SnapshotInput[]) => validateSnapshots("manual", rows, REGISTRY, { now: NOW });

  test("a bucket in the future is refused", () => {
    // The scorecard shows the newest bucket, so a far-future row would become
    // "latest" for good.
    expect(at([{ ...kzCash, periodStart: "2099-01-01" }])[0]).toMatchObject({
      field: "periodStart",
    });
    expect(at([{ ...kzCash, periodStart: "2026-10-14" }])[0]).toMatchObject({
      field: "periodStart",
    });
  });

  test("today and tomorrow are accepted, since the sender may be ahead of UTC", () => {
    expect(at([{ ...kzCash, periodStart: "2026-10-12" }])).toEqual([]);
    expect(at([{ ...kzCash, periodStart: "2026-10-13" }])).toEqual([]);
  });

  test("the current month is accepted and next month is not", () => {
    const rate = (periodStart: string) => ({
      key: "fx_usd_kzt",
      scope: "company",
      period: "month" as const,
      periodStart,
      value: 440,
    });
    expect(at([rate("2026-10-01")])).toEqual([]);
    expect(at([rate("2026-11-01")])[0]).toMatchObject({ field: "periodStart" });
  });

  test("the past is always accepted", () => {
    expect(at([{ ...kzCash, periodStart: "2019-03-04" }])).toEqual([]);
  });

  test("without a clock, dates are not checked", () => {
    expect(check("manual", [{ ...kzCash, periodStart: "2099-01-01" }])).toEqual([]);
  });
});
