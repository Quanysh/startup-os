// Shape and registry rules for metric snapshots. Shared by every write path
// (manual entry, connectors, the ingest endpoint) so they cannot disagree.

import {
  CURRENCIES,
  METRICS,
  currencyOf,
  getMetric,
  type MetricDef,
  type Scope,
} from "./metricRegistry";
import { isCanonicalPeriodStart, periodStart, type Period } from "./periods";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SnapshotInput = {
  key: string;
  scope: string;
  period: Period;
  periodStart: string;
  value: number;
  currency?: string;
};

export type SnapshotIssue = {
  /** Position of the offending row in the batch. */
  index: number;
  field: keyof SnapshotInput | "source";
  message: string;
};

/**
 * Check a batch against the registry. Returns every problem found, at most one
 * per row (the first), so a caller can report them all at once. An empty array
 * means the batch is safe to write.
 *
 * Pass `now` to also refuse buckets in the future. The write path always
 * does: the scorecard shows the newest bucket, so a far-future row would sit
 * there as "latest" for good. One day of grace covers a sender ahead of UTC.
 */
export function validateSnapshots(
  source: string,
  rows: readonly SnapshotInput[],
  registry: readonly MetricDef[] = METRICS,
  options: { now?: number } = {},
): SnapshotIssue[] {
  const issues: SnapshotIssue[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const fail = (field: SnapshotIssue["field"], message: string) =>
      issues.push({ index, field, message });

    const metric = getMetric(row.key, registry);
    if (!metric) return fail("key", `Unknown metric "${row.key}".`);

    const owner = metric.sources[row.scope as Scope];
    if (owner === undefined) {
      return fail("scope", `"${row.key}" has no "${row.scope}" scope.`);
    }
    if (owner !== source) {
      return fail(
        "source",
        `"${row.key}" (${row.scope}) is written by "${owner}", not "${source}".`,
      );
    }
    if (row.period !== metric.grain) {
      return fail("period", `"${row.key}" is stored per ${metric.grain}.`);
    }
    if (!isCanonicalPeriodStart(row.period, row.periodStart)) {
      return fail(
        "periodStart",
        `"${row.periodStart}" is not the start of a ${row.period}.`,
      );
    }
    if (
      options.now !== undefined &&
      row.periodStart > periodStart(row.period, options.now + DAY_MS)
    ) {
      return fail("periodStart", `"${row.periodStart}" is in the future.`);
    }
    if (!Number.isFinite(row.value)) {
      return fail("value", "Value must be a finite number.");
    }
    if (metric.integer && !Number.isInteger(row.value)) {
      return fail("value", `${metric.label} must be a whole number.`);
    }
    if (metric.min !== undefined && row.value < metric.min) {
      return fail("value", `${metric.label} cannot be below ${metric.min}.`);
    }
    if (metric.max !== undefined && row.value > metric.max) {
      return fail("value", `${metric.label} cannot be above ${metric.max}.`);
    }
    if (metric.unit === "currency") {
      if (!row.currency) return fail("currency", "Money needs a currency.");
      if (!(CURRENCIES as readonly string[]).includes(row.currency)) {
        return fail("currency", `Unsupported currency "${row.currency}".`);
      }
      const expected = currencyOf(metric, row.scope);
      if (expected === undefined) {
        return fail("currency", `No currency is defined for "${row.scope}" amounts.`);
      }
      if (row.currency !== expected) {
        return fail("currency", `"${row.scope}" amounts are stored in ${expected}.`);
      }
    } else if (row.currency !== undefined) {
      return fail("currency", `"${row.key}" is not money.`);
    }

    const identity = `${row.key}|${row.scope}|${row.period}|${row.periodStart}`;
    if (seen.has(identity)) {
      return fail("periodStart", "Duplicate row for this metric, scope and period.");
    }
    seen.add(identity);
  });

  return issues;
}
