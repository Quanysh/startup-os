import { periodStart, previousPeriodStart } from "@convex/lib/periods";
import { BenchmarkChip } from "@/components/metrics/benchmark-chip";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { formatExact, formatPeriod, formatValue, monthRange } from "@/lib/format";
import { BENCHMARKS } from "@/lib/metrics/benchmarks";
import { BOTH_MARKETS, type BurnMultiple, type Market } from "@/lib/metrics/finance";
import { Note } from "./notes";

/** The published band is for a run at least this long. */
const BENCHMARK_MONTHS = 6;

/**
 * Dollars burned for each dollar of net new ARR, over the run of complete
 * months ending last month. Where there is nothing to divide by, or nothing
 * burned, it says so in words rather than printing a number.
 */
export function BurnMultipleTile({
  burnMultiple,
  now,
  markets = BOTH_MARKETS,
}: {
  burnMultiple: BurnMultiple | null;
  now: number;
  markets?: readonly Market[];
}) {
  const label = "Burn multiple";

  if (burnMultiple === null) {
    return (
      <DerivedTile label={label} value={null}>
        {/* "Company MRR" is the two markets added up; one company's view has only its own. */}
        <Note>
          {markets.length > 1 ? "Needs net burn and company MRR." : "Needs net burn and MRR."}
        </Note>
      </DerivedTile>
    );
  }

  if (burnMultiple.kind === "none") {
    switch (burnMultiple.reason) {
      case "last_month_incomplete": {
        const lastMonth = previousPeriodStart("month", periodStart("month", now));
        return (
          <DerivedTile label={label} value={null}>
            <Note>{`Appears once ${formatPeriod("month", lastMonth)} has complete burn and MRR.`}</Note>
          </DerivedTile>
        );
      }
      case "too_little_history":
        return (
          <DerivedTile label={label} value={null}>
            <Note>
              Needs three complete months of burn in a row, and MRR for the month before them.
            </Note>
          </DerivedTile>
        );
      case "no_growth":
        return (
          <DerivedTile label={label} value="No growth">
            <Note>MRR did not grow over the run, so there is nothing to divide the burn by.</Note>
          </DerivedTile>
        );
      case "not_burning":
        return (
          <DerivedTile label={label} value="Not burning">
            <Note>Money in exceeded money out over the run.</Note>
          </DerivedTile>
        );
    }
  }

  const { value, months, from, to } = burnMultiple;
  const run = <Note>{`Net burn ÷ net new ARR, ${monthRange(from, to)}.`}</Note>;
  return (
    <DerivedTile
      label={label}
      value={formatValue(value, "ratio")}
      exact={formatExact(value, "ratio")}
    >
      {months >= BENCHMARK_MONTHS ? (
        <>
          <BenchmarkChip value={value} benchmark={BENCHMARKS.burn_multiple} />
          {run}
        </>
      ) : (
        <>
          {run}
          <Note>{`The benchmark is for six months or more; this is ${months}.`}</Note>
        </>
      )}
    </DerivedTile>
  );
}
