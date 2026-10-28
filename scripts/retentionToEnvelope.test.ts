import { describe, expect, test } from "vitest";
import { parseIngestEnvelope } from "../convex/lib/ingestSchema";
import { validateSnapshots } from "../convex/lib/snapshotRules";
import { retentionToEnvelope } from "./retentionToEnvelope";

// Shaped like the real export, with made-up names where the real one has
// client names. Every name here contains "SECRET" so one assertion can prove
// none of them survive.
const WORKBOOK = {
  source: "Retention workbook (test)",
  cutoff: "2026-10-15",
  fx: 500,
  fxDate: "2026-09-18",
  us: { mrr: 0, clinics: 0 },
  clients: { ever: 25, active: 16, using: 3, churned: 6, names: ["SECRET CLINIC ALPHA"] },
  usingNames: "SECRET CLINIC BETA, SECRET CLINIC GAMMA",
  rates: { retention: 0.64, monthlyChurn: 0.0375, annualChurn: 0.3679 },
  money: {
    register: 1_800_000,
    receipts: 1_650_000,
    payers: 14,
    owed: 2_400_000,
    largestPayer: "SECRET CLINIC DELTA",
  },
  notes: ["SECRET NOTE about one client"],
};
// The push happens in the month after the cutoff, so a figure filed under the
// month it was pushed, rather than the month it describes, fails a test.
const AT = new Date("2026-11-03T09:30:00Z");

describe("retentionToEnvelope", () => {
  const envelope = retentionToEnvelope(WORKBOOK, AT);
  const row = (key: string) => envelope.snapshots.find((s) => s.key === key);

  test("carries no client name, wherever it sat in the export", () => {
    expect(JSON.stringify(envelope)).not.toContain("SECRET");
  });

  test("names the push after the workbook's cutoff, so a re-push overwrites", () => {
    expect(envelope).toMatchObject({
      version: 1,
      source: "cfo_workbook",
      batchId: "retention-2026-10-15",
      observedAt: "2026-11-03T09:30:00.000Z",
    });
  });

  test("Kazakhstan MRR is what was received, in tenge, for the cutoff month", () => {
    expect(row("mrr")).toEqual({
      key: "mrr",
      scope: "kz",
      period: "month",
      periodStart: "2026-10-01",
      value: 1_650_000,
      currency: "KZT",
    });
  });

  test("the contracted fees and the amount owed travel beside it", () => {
    expect(row("mrr_contracted")).toMatchObject({ scope: "kz", value: 1_800_000, currency: "KZT" });
    expect(row("receivables")).toMatchObject({ scope: "kz", value: 2_400_000, currency: "KZT" });
  });

  test("counts carry no currency", () => {
    expect(row("paying_clinics")).toEqual({
      key: "paying_clinics",
      scope: "kz",
      period: "month",
      periodStart: "2026-10-01",
      value: 14,
    });
    expect(row("clinics_active")).toMatchObject({ scope: "kz", value: 16 });
    expect(row("clinics_using")).toMatchObject({ scope: "kz_product", value: 3 });
  });

  test("churn is sent as a percentage with two decimals", () => {
    expect(row("logo_churn_monthly")).toMatchObject({ scope: "kz", value: 3.75 });
  });

  test("the rate is filed under the month it was taken, not the cutoff month", () => {
    expect(row("fx_usd_kzt")).toEqual({
      key: "fx_usd_kzt",
      scope: "company",
      period: "month",
      periodStart: "2026-09-01",
      value: 500,
    });
  });

  test("the endpoint's own schema and the registry both accept it", () => {
    expect(parseIngestEnvelope(JSON.parse(JSON.stringify(envelope))).ok).toBe(true);
    expect(
      validateSnapshots("cfo_workbook", envelope.snapshots, undefined, { now: AT.getTime() }),
    ).toEqual([]);
  });

  test("a date that does not exist is refused, naming the field", () => {
    for (const [field, value] of [
      ["cutoff", "2026-02-30"],
      ["cutoff", "2026-13-01"],
      ["fxDate", "2026-02-30"],
      ["fxDate", "2026-13-01"],
    ] as const) {
      const broken = { ...WORKBOOK, [field]: value };
      expect(() => retentionToEnvelope(broken, AT), `${field} ${value}`).toThrow(
        new RegExp(`"${field}"`),
      );
    }
  });

  test("an empty payer count leaves out paying clinics and sends the rest", () => {
    const without = retentionToEnvelope(
      { ...WORKBOOK, money: { ...WORKBOOK.money, payers: null } },
      AT,
    );
    expect(without.snapshots.map((s) => s.key)).toEqual([
      "mrr",
      "mrr_contracted",
      "receivables",
      "clinics_active",
      "clinics_using",
      "logo_churn_monthly",
      "fx_usd_kzt",
    ]);
  });

  test("an export missing a figure is refused, naming the figure", () => {
    const broken = { ...WORKBOOK, money: { receipts: 1_650_000, payers: 14, owed: 0 } };
    expect(() => retentionToEnvelope(broken, AT)).toThrow(/register/);
  });

  test("a negative amount is refused rather than pushed", () => {
    const broken = { ...WORKBOOK, money: { ...WORKBOOK.money, receipts: -1 } };
    expect(() => retentionToEnvelope(broken, AT)).toThrow(/receipts/);
  });
});
