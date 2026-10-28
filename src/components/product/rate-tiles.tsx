import type { ReactNode } from "react";
import { BenchmarkChip } from "@/components/metrics/benchmark-chip";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { formatValue } from "@/lib/format";
import { BENCHMARKS, type Benchmark } from "@/lib/metrics/benchmarks";
import {
  MIN_SIGNUPS_FOR_VERDICT,
  MIN_VISITORS_FOR_VERDICT,
  weekSpan,
  type Rate,
} from "@/lib/metrics/product";

const count = (value: number) => value.toLocaleString("en-US");

/** What differs between the two tiles: the words, the benchmark and its threshold. */
type Wording = {
  label: string;
  benchmark: Benchmark;
  /** The smallest denominator that earns a benchmark verdict. */
  enough: number;
  /** What the denominator counts, for "Fewer than 20 signups…". */
  unit: string;
  noCompleteWeek: string;
  emptyValue: string;
  empty: (span: string) => string;
  impossible: (top: string, bottom: string, span: string) => string;
  made: (top: string, bottom: string, span: string) => string;
};

/** One rate as a tile. Every state of `Rate` has its own words; none shows a guess. */
function RateTile({ rate, words }: { rate: Rate; words: Wording }) {
  const tile = (value: string | null, children: ReactNode) => (
    <DerivedTile label={words.label} value={value}>
      {children}
    </DerivedTile>
  );

  if (rate.kind === "none") {
    return tile(
      null,
      <p>
        {rate.reason === "no_data" ? "Arrives with PostHog's first sync." : words.noCompleteWeek}
      </p>,
    );
  }
  const span = weekSpan(rate.from, rate.to);
  if (rate.kind === "empty") return tile(words.emptyValue, <p>{words.empty(span)}</p>);

  const top = count(rate.numerator);
  const bottom = count(rate.denominator);
  if (rate.kind === "impossible") return tile(null, <p>{words.impossible(top, bottom, span)}</p>);

  // A verdict needs enough people that one of them does not move it by points.
  const verdict = rate.denominator >= words.enough;
  return tile(
    formatValue(rate.percent, "percent"),
    <>
      {verdict && <BenchmarkChip value={rate.percent} benchmark={words.benchmark} />}
      <p>{words.made(top, bottom, span)}</p>
      {!verdict && (
        <p>{`Fewer than ${words.enough} ${words.unit}, so no benchmark verdict yet.`}</p>
      )}
      {rate.weeks < rate.expected && (
        <p>{`${rate.weeks} of the last ${rate.expected} weeks. The rest are not complete.`}</p>
      )}
    </>,
  );
}

const ACTIVATION: Wording = {
  label: "Activation rate",
  benchmark: BENCHMARKS.activation_rate,
  enough: MIN_SIGNUPS_FOR_VERDICT,
  unit: "signups",
  noCompleteWeek: "Appears once a week of signups has had seven days to activate.",
  emptyValue: "No signups",
  empty: (span) => `Nobody signed up in the weeks of ${span}.`,
  impossible: (_top, _bottom, span) =>
    `More activated signups than signups are stored for ${span}, so there is no rate to show.`,
  made: (top, bottom, span) =>
    `${top} of ${bottom} signups ran a search within 7 days of signing up. Signups of ${span}.`,
};

const CONVERSION: Wording = {
  label: "Visitor to signup",
  benchmark: BENCHMARKS.visitor_to_signup,
  enough: MIN_VISITORS_FOR_VERDICT,
  // The denominator adds up each week's visitors, so someone who came back
  // is in it once per week: "weekly visitors", never a count of people.
  unit: "weekly visitors",
  noCompleteWeek: "Appears once a full week has been read.",
  emptyValue: "No visitors",
  empty: (span) => `No visits were recorded in ${span}.`,
  impossible: (top, bottom, span) =>
    `${top} signups against ${bottom} weekly visitors in ${span}: visits are being missed, so there is no rate to show.`,
  made: (top, bottom, span) =>
    `${top} signups against ${bottom} weekly visitors (a returning visitor is counted each week). Weeks of ${span}.`,
};

/** Startup Insights only: the band is US and EU data for product-led software. */
export function ActivationTile({ rate }: { rate: Rate }) {
  return <RateTile rate={rate} words={ACTIVATION} />;
}

/** Startup Insights only, for the same reason. */
export function VisitorSignupTile({ rate }: { rate: Rate }) {
  return <RateTile rate={rate} words={CONVERSION} />;
}
