import { BenchmarkChip } from "@/components/metrics/benchmark-chip";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { formatExact, formatValue } from "@/lib/format";
import { BENCHMARKS } from "@/lib/metrics/benchmarks";
import { useViewer } from "@/hooks/use-viewer";
import { LONGEST_RUNWAY_MONTHS, type FinanceSummary } from "@/lib/metrics/finance";
import { Note, cashPartIsOld, parentWords, type HeroExtras } from "./notes";

/** Months to one decimal, as the hero counts them; "mo" follows, quieter. */
const MONTHS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * How many months the cash lasts at the average net burn. Withheld while
 * either is unknown or partial: an overstated runway is the dangerous
 * direction. A benchmark verdict needs a burn figure that can be trusted.
 */
export function RunwayTile({
  summary,
  now,
  hero,
}: {
  summary: FinanceSummary;
  now: number;
  /** In the Finance hero: the trend and when cash runs out. */
  hero?: HeroExtras;
}) {
  const { runway, average, cash, lateCloses, markets } = summary;
  const { companies } = useViewer();
  // Globex's own burn takes Startup's funding out, so its runway is how long
  // its cash lasts on its own.
  const alone = markets.length === 1 && markets[0] === "kz" && (
    <Note>{`Without new money from ${parentWords(companies)}.`}</Note>
  );

  if (runway === null) {
    return (
      <DerivedTile label="Runway" value={null}>
        <Note>
          {average === null
            ? "Needs net burn first."
            : markets.length > 1
              ? "Needs every market's cash balance first."
              : // One company's view has one balance, and no other market to wait for.
                "Needs a cash balance first."}
        </Note>
      </DerivedTile>
    );
  }
  if (runway.kind === "not_burning") {
    return (
      <DerivedTile label="Runway" value="Not burning">
        <Note>Cash is not falling, so there is nothing to count down.</Note>
        {average !== null && average.months.length < average.expected.length && (
          <Note>{`Based on ${average.months.length} of the last 3 months.`}</Note>
        )}
        {alone}
      </DerivedTile>
    );
  }
  if (runway.months > LONGEST_RUNWAY_MONTHS) {
    // No verdict either: a burn this small against this much cash is not a
    // runway worth one.
    return (
      <DerivedTile label="Runway" value="10+ years">
        <Note>Cash ÷ average net burn.</Note>
        {alone}
      </DerivedTile>
    );
  }

  const burnMonths = average?.months.length ?? 0;
  const late = lateCloses.length > 0;
  const old = (cash?.parts ?? []).some((part) => cashPartIsOld(part, now));
  return (
    <DerivedTile
      label="Runway"
      value={formatValue(runway.months, "months")}
      exact={formatExact(runway.months, "months")}
      count={{ value: runway.months, format: (n) => MONTHS.format(n), unit: "mo" }}
      alongside={hero?.runOut}
      trend={hero?.trend}
    >
      {burnMonths >= 2 && !late && (
        <BenchmarkChip value={runway.months} benchmark={BENCHMARKS.runway_months} />
      )}
      {burnMonths === 1 && <Note>One month of burn so far, so no benchmark verdict yet.</Note>}
      {late && (
        <Note caution>
          A month-end balance was entered late, so no benchmark verdict; see net burn.
        </Note>
      )}
      <Note>Cash ÷ average net burn.</Note>
      {alone}
      {old && <Note caution>Uses a balance that is out of date.</Note>}
    </DerivedTile>
  );
}
