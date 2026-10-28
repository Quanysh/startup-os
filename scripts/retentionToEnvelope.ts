// Turns the CFO workbook's exported summary (startup-model/tools/retention.json)
// into an ingest envelope. Pure, so the mapping is tested without a network.

import { z } from "zod";
import { INGEST_VERSION, type SnapshotEnvelope } from "../convex/lib/ingestSchema";
import { isCanonicalPeriodStart, periodStart } from "../convex/lib/periods";

// A real calendar date: 2026-02-30 and 2026-13-01 would otherwise roll over
// into a neighbouring month and be filed there.
const isoDate = z
  .string()
  .refine((value) => isCanonicalPeriodStart("day", value), "expected a real date, YYYY-MM-DD");
const amount = z.number().nonnegative();
const count = z.number().int().nonnegative();

// The only fields read from the export. z.object drops every key it does not
// name, so client names (`usingNames`, `notes`, or anything added to the
// export later) cannot reach the envelope even by accident.
const workbook = z.object({
  cutoff: isoDate,
  fx: z.number().positive(),
  fxDate: isoDate,
  clients: z.object({ active: count, using: count }),
  rates: z.object({ monthlyChurn: z.number().min(0).max(1) }),
  // `payers` is read out of a text cell and can be empty; nothing else may be.
  money: z.object({
    register: amount,
    receipts: amount,
    payers: count.nullable(),
    owed: amount,
  }),
});

const monthOf = (date: string) => periodStart("month", new Date(`${date}T00:00:00Z`));

export function retentionToEnvelope(raw: unknown, observedAt: Date): SnapshotEnvelope {
  const w = workbook.parse(raw);
  // The workbook's figures describe the month of its cutoff date.
  const month = monthOf(w.cutoff);
  const tenge = (key: string, value: number) => ({
    key,
    scope: "kz",
    period: "month" as const,
    periodStart: month,
    value,
    currency: "KZT",
  });
  const plain = (key: string, scope: string, value: number, start = month) => ({
    key,
    scope,
    period: "month" as const,
    periodStart: start,
    value,
  });

  return {
    version: INGEST_VERSION,
    source: "cfo_workbook",
    // Named after the cutoff, so pushing the same workbook twice overwrites.
    batchId: `retention-${w.cutoff}`,
    observedAt: observedAt.toISOString(),
    snapshots: [
      tenge("mrr", w.money.receipts),
      tenge("mrr_contracted", w.money.register),
      tenge("receivables", w.money.owed),
      // Left out, not zeroed, when the workbook has no payer count this time.
      ...(w.money.payers === null ? [] : [plain("paying_clinics", "kz", w.money.payers)]),
      plain("clinics_active", "kz", w.clients.active),
      plain("clinics_using", "kz_product", w.clients.using),
      // A fraction in the workbook, a percentage in the OS.
      plain("logo_churn_monthly", "kz", Math.round(w.rates.monthlyChurn * 10_000) / 100),
      // Filed under the month the rate was taken, which may precede the cutoff.
      plain("fx_usd_kzt", "company", w.fx, monthOf(w.fxDate)),
    ],
  };
}
