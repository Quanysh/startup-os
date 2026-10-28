import { InfoIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { getMetric } from "@convex/lib/metricRegistry";
import { useCompany } from "@/components/company-provider";
import { GatedLink } from "@/components/gated-link";
import { marketsOf } from "@/lib/company";
import { formatExact, formatPeriod, formatUsd } from "@/lib/format";
import { BENCHMARKS } from "@/lib/metrics/benchmarks";
import type { CombinedPoint } from "@/lib/metrics/derive";
import { tilesInView, type Market } from "@/lib/metrics/finance";
import { companyMrr, supplyOf, type GrowthWithheld, type Tile } from "@/lib/metrics/scorecard";
import { BenchmarkChip } from "./benchmark-chip";
import { ChangeBadge } from "./change-badge";
import { Sparkline } from "./sparkline";

/** What to tell the owner while growth is withheld, by reason. */
export const GROWTH_WAITING: Record<Exclude<GrowthWithheld, "partial">, string> = {
  previous_partial: "Growth appears once the previous month has a complete figure too.",
  no_previous: "Growth appears next month, once there are two months to compare.",
  new_market: "Growth appears next month: this is the first month with every market in it.",
  // No promise for next month: a company at zero both months would never see it kept.
  // "The month before", not "last month": it is the month before the latest
  // figure, which is not always the calendar's last month.
  zero_baseline: "The month before had no MRR, so there is no percentage to show.",
};

/**
 * A sentence about a figure the total is missing. Where the figure is typed in,
 * one phrase of the sentence links to the entry form; where a source brings
 * it, the sentence names that source and offers no form to fill. The form is
 * the owner's: anyone else reads the same sentence with no link in it.
 */
export function supplySentence(
  key: string,
  scope: string,
  forms: {
    enter: (link: (label: string) => ReactNode) => ReactNode;
    source: (source: string) => string;
  },
): ReactNode {
  const supply = supplyOf(getMetric(key)!, scope);
  if (supply.how === "source") return forms.source(supply.source);
  return forms.enter((label) => (
    <GatedLink href={supply.href} className="text-brand underline-offset-2 hover:underline">
      {label}
    </GatedLink>
  ));
}

/**
 * Why the total is partial, in the order the owner would fix it. `alone` is a
 * view of Kazakhstan only: with no rate there is no total for it to be "left
 * out" of.
 */
export function partialReasons(latest: CombinedPoint, alone: boolean): ReactNode[] {
  const month = formatPeriod("month", latest.periodStart);
  const reasons: ReactNode[] = [];
  const noMrr = (scope: string, market: string) =>
    supplySentence("mrr", scope, {
      enter: (link) => (
        <>
          {market} has no {link("MRR figure")} for {month} yet.
        </>
      ),
      source: (source) =>
        `${market} has no MRR figure for ${month} yet. It arrives with ${source}.`,
    });
  if (latest.missing.includes("us")) reasons.push(noMrr("us", "The US"));
  if (latest.missing.includes("kz")) reasons.push(noMrr("kz", "Kazakhstan"));
  if (latest.missing.includes("fx")) {
    reasons.push(
      supplySentence(
        "fx_usd_kzt",
        "company",
        alone
          ? {
              enter: (link) => (
                <>There is no dollar figure until a {link("USD/KZT rate")} is entered.</>
              ),
              source: (source) =>
                `There is no dollar figure until a USD/KZT rate arrives with ${source}.`,
            }
          : {
              enter: (link) => (
                <>Kazakhstan is left out until a {link("USD/KZT rate")} is entered.</>
              ),
              source: (source) =>
                `Kazakhstan is left out until a USD/KZT rate arrives with ${source}.`,
            },
      ),
    );
  }
  return reasons;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex max-w-md items-start gap-1.5 text-xs text-ink-2">
      <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-watch" />
      <span>{children}</span>
    </p>
  );
}

const ADD_MRR_CLASS =
  "mt-5 inline-flex h-10 items-center gap-1.5 rounded-full bg-brand-fill px-5 text-sm font-medium text-on-brand outline-none transition hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Before any figure exists: where MRR comes from, for the markets in view.
 * In one company's view only its own figure is asked for, by the way that
 * figure arrives: a form to fill where it is typed in, the source's name
 * where a source brings it.
 */
function NoValue({ only }: { only: Market | null }) {
  const supply = supplyOf(getMetric("mrr")!, only ?? "us");
  return (
    <div className="mt-3">
      <p className="text-5xl font-semibold tracking-tight text-ink-3">No value yet</p>
      {only === null ? (
        <p className="mt-3 max-w-md text-sm text-ink-2">
          MRR is the primary metric this scorecard is built around. Enter this
          month&apos;s US figure to start the trend. Kazakhstan&apos;s arrives with the
          CFO workbook.
        </p>
      ) : (
        <p className="mt-3 max-w-md text-sm text-ink-2">
          {supply.how === "enter"
            ? "MRR is the primary metric this scorecard is built around. Enter this month's figure to start the trend."
            : `MRR is the primary metric this scorecard is built around. It arrives with ${supply.source}.`}
        </p>
      )}
      {supply.how === "enter" && (
        // Offered to whoever can open the form; nobody else is shown a button.
        <GatedLink href={supply.href} className={ADD_MRR_CLASS} otherwise={null}>
          <PlusIcon aria-hidden className="size-4" />
          Add MRR
        </GatedLink>
      )}
    </div>
  );
}

/**
 * The scorecard's one headline number: company MRR in dollars, its
 * month-over-month growth, and where that growth sits against the seed-stage
 * benchmark.
 *
 * A total that is missing a market is shown as partial and says which, and
 * growth is withheld: half a month's revenue compared with a whole one is a
 * wrong number, not an approximate one.
 *
 * `markets` is the markets in view; left out, it follows the company chosen
 * in the sidebar. In one company's view the number is that company's MRR,
 * whatever tiles it is handed, and no sentence is about the other.
 */
export function HeroMrr({
  tiles,
  markets,
  minTrend = 2,
}: {
  tiles: readonly Tile[];
  markets?: readonly Market[];
  /** The fewest comparable months the trend line is drawn for. The dashboard asks for three. */
  minTrend?: number;
}) {
  const chosen = marketsOf(useCompany());
  const inView = markets ?? chosen;
  const mrr = companyMrr(tilesInView(tiles, inView));
  // The one market of a one-company view; null where both are in view.
  const only = inView.length === 1 ? inView[0]! : null;

  return (
    <section
      aria-labelledby="hero-mrr"
      className="wash-brand relative overflow-hidden rounded-card bg-panel p-6 shadow-soft sm:p-8"
    >
      <h2 id="hero-mrr" className="text-sm font-medium text-ink-2">
        Monthly recurring revenue · company
      </h2>

      {mrr === null ? (
        <NoValue only={only} />
      ) : (
        <div className="mt-2 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-end">
          <div className="min-w-0">
            <p
              className="text-5xl font-semibold tracking-tight text-ink sm:text-6xl"
              title={formatExact(mrr.latest.value, "currency", "USD")}
            >
              {formatUsd(mrr.latest.value)}
            </p>
            <p className="mt-1 text-xs text-ink-3">
              {formatPeriod("month", mrr.latest.periodStart)}
              {!mrr.latest.complete && (
                <span className="ml-1.5 rounded-full bg-surface px-1.5 py-0.5 font-medium text-ink">
                  partial
                </span>
              )}
            </p>

            {!mrr.latest.complete && (
              <Notice>
                {partialReasons(mrr.latest, only === "kz").map((reason, i) => (
                  <span key={i} className="block">
                    {reason}
                  </span>
                ))}
                <span className="block">Growth is shown once the month is complete.</span>
              </Notice>
            )}

            {mrr.rate !== null && mrr.ratePeriodStart !== null && (
              <p className="mt-2 text-xs text-ink-3">
                {only === "kz" ? "Converted at" : "Kazakhstan converted at"}{" "}
                <span className="font-num text-ink-2">₸{mrr.rate.toLocaleString("en-US")}</span>{" "}
                per $1, the {formatPeriod("month", mrr.ratePeriodStart)} rate.
              </p>
            )}
            {mrr.rateIsOld && (
              <Notice>
                {supplySentence("fx_usd_kzt", "company", {
                  enter: (link) => (
                    <>
                      That rate is more than two months old. Enter a {link("current rate")} to
                      keep the total right.
                    </>
                  ),
                  source: (source) =>
                    `That rate is more than two months old. It is the company's last conversion; a newer one arrives with ${source}.`,
                })}
              </Notice>
            )}

            <div className="mt-4 flex flex-wrap items-start gap-x-4 gap-y-3">
              {mrr.growthPercent !== null && mrr.previousPeriodStart !== null && (
                <>
                  <ChangeBadge
                    className="mt-1.5"
                    ratio={mrr.growthPercent / 100}
                    better="up"
                    versus={formatPeriod("month", mrr.previousPeriodStart, "short")}
                  />
                  <BenchmarkChip
                    value={mrr.growthPercent}
                    benchmark={BENCHMARKS.mrr_growth_mom}
                  />
                </>
              )}
              {/* The partial case has its own notice above. */}
              {mrr.growthWithheld !== null && mrr.growthWithheld !== "partial" && (
                <p className="text-xs text-ink-3">{GROWTH_WAITING[mrr.growthWithheld]}</p>
              )}
            </div>
          </div>

          {/* One point is not a trend; a lone dot in an empty box says nothing. */}
          {mrr.trend.length >= minTrend && (
            <Sparkline
              className="h-24"
              ariaLabel={`Company MRR over ${mrr.trend.length} comparable months`}
              points={mrr.trend.map((p) => ({
                label: formatPeriod("month", p.periodStart),
                value: p.value,
                display: formatUsd(p.value),
              }))}
            />
          )}
        </div>
      )}
    </section>
  );
}
