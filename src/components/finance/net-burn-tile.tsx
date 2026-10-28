import type { ReactNode } from "react";
import { periodStart, previousPeriodStart } from "@convex/lib/periods";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { dayLabel, formatExact, formatPeriod, formatUsd, formatValue, monthRange } from "@/lib/format";
import {
  monthGaps,
  type FinanceSummary,
  type Market,
  type MonthGap,
} from "@/lib/metrics/finance";
import {
  ENTER_KZ_CASH,
  ENTER_KZ_FINANCING,
  ENTER_US_FINANCING,
  Note,
  NoteLink,
  OWNER_ENTERS_KZ_CASH,
  parentWords,
  subsidiaryWords,
  type HeroExtras,
} from "./notes";

/** What a month can lack, as it reads after "is missing". */
const LACKS: Record<Exclude<MonthGap["lacks"][number], "all" | "kz_before">, string> = {
  us: "Mercury's figures",
  kz: "Kazakhstan's month-end balance",
  fx: "a USD/KZT rate",
  // Only ever in Globex's view for a viewer on Startup too: a viewer on
  // Globex alone is never sent the figure, and is told so once instead.
  sent: `Mercury's figure for what ${COMPANIES.us.name} sent ${COMPANIES.kz.name}`,
};

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * One incomplete month, in words: what it lacks. A Kazakhstan balance that is
 * on record is never called missing: where the month's own close is there,
 * the sentence names the close before it, which the burn is measured from.
 */
function gapSentence({ month, lacks }: MonthGap): string {
  const name = formatPeriod("month", month);
  if (lacks.includes("all")) return `${name} has no figures yet.`;
  const named = lacks.flatMap((what) =>
    what === "all" || what === "kz_before" ? [] : [LACKS[what]],
  );
  const sentences = named.length > 0 ? [`${name} is missing ${listed(named)}.`] : [];
  if (lacks.includes("kz_before")) {
    const before = formatPeriod("month", previousPeriodStart("month", month));
    sentences.push(
      `${name} has no Kazakhstan burn figure: the balance at the end of ${before} is missing.`,
    );
  }
  return sentences.join(" ");
}

// Which months the average is of is said in the notes: a longer label wraps
// in the four-column layout and pushes the value below its neighbours'.
const COMPANY_LABEL = "Net burn";
/**
 * Kazakhstan's burn alone is the fall in month-end balances, financing taken
 * out (Startup's funding included): money out less money in, never what Globex
 * AI spent. Its one actual spend is the figure typed on the Budget tab
 * (`budgetActuals`); the two are never shown under one name.
 */
export const KZ_LABEL = "Net burn (from cash)";
export const KZ_NOT_SPEND =
  `Money out less money in, from month-end balances: not ${COMPANIES.kz.name}'s actual spend, which is typed in on the`;

/**
 * What the company spends beyond what it takes in, a month, averaged over the
 * last three complete ones. Withheld until every market in view reports:
 * with both in view, a US-only figure would understate spending.
 */
export function NetBurnTile({
  summary,
  now,
  hero,
}: {
  summary: FinanceSummary;
  now: number;
  /** In the Finance hero: the trend, tenge first for Globex, and where the figure comes from. */
  hero?: HeroExtras;
}) {
  const { coverage, average, financingProblems, lateCloses, unfinishedUsMonths, usFlowsReadAt, funding } =
    summary;
  const { companies } = useViewer();
  const inView = (market: Market) => summary.markets.includes(market);
  const kzAlone = inView("kz") && !inView("us");
  const LABEL = kzAlone ? KZ_LABEL : COMPANY_LABEL;
  const parent = parentWords(companies);
  // What the figure is worked out from, said in the hero's small print.
  // Globex's takes out Startup's funding, which is Mercury's figure.
  const source =
    hero === undefined
      ? undefined
      : kzAlone
        ? "Typed-in month-end balances and Mercury"
        : inView("kz")
          ? "Mercury and typed-in month-end balances"
          : "Mercury";
  const notSpend = kzAlone && (
    <Note>
      {KZ_NOT_SPEND} <NoteLink href="/finance/plan">Budget tab</NoteLink>.
    </Note>
  );
  // Globex's own lens: the defining rule of its figure, with how much
  // went from Startup over the average's months, in the figure's own currency.
  const tengeRate = hero?.own === true && kzAlone ? (summary.cash?.rate ?? null) : null;
  const sentWords = (perMonth: number) =>
    tengeRate === null ? formatUsd(perMonth) : formatValue(perMonth * tengeRate, "currency", "KZT");
  const received = funding?.side === "subsidiary" && (
    <Note>
      {funding.perMonth !== null && funding.perMonth > 0
        ? `What ${parent} sent, ${sentWords(funding.perMonth)} a month, is taken out as financing, not counted as income.`
        : `What ${parent} sends is taken out as financing, not counted as income.`}
    </Note>
  );
  // Startup's own lens keeps the bank's figure: it says how much of it went to
  // its subsidiary, by name only for a viewer on Globex as well.
  const sent = funding?.side === "parent" && funding.perMonth !== 0 && (
    <Note>
      {funding.perMonth === null
        ? `Includes what ${COMPANIES.us.name} sent ${subsidiaryWords(companies)}.`
        : `Includes ${formatUsd(funding.perMonth)} a month sent to ${subsidiaryWords(companies)}.`}
    </Note>
  );

  // The day of Mercury's last successful run. With none on record there is no
  // day to name and nothing to tell the short months apart by, so it is said once.
  const readOn = usFlowsReadAt === null ? null : dayLabel(periodStart("day", usFlowsReadAt), now);

  // Said in every state: with a financing problem in the only US month there
  // is, the tile reads "arrives with Mercury" and this is the explanation.
  const doubts = (
    <>
      {readOn === null
        ? unfinishedUsMonths.length > 0 && (
            <Note caution>
              Mercury&apos;s months are not counted: no successful read is on record.
            </Note>
          )
        : unfinishedUsMonths.map((month) => (
            <Note key={month} caution>
              {`${formatPeriod("month", month)} is not counted: Mercury was last read on ${readOn}, before the month ended.`}
            </Note>
          ))}
      {financingProblems.map((month) => (
        <Note key={month} caution>
          {`${formatPeriod("month", month)} has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.`}
        </Note>
      ))}
      {lateCloses.map(({ month, date }) => {
        const name = formatPeriod("month", month);
        return (
          <Note key={month} caution>
            {`Kazakhstan's ${name} close is dated ${dayLabel(date, now)}, after the month ended. Money that moved in between is counted in ${name}.`}
          </Note>
        );
      })}
    </>
  );
  // Why each month the average leaves out is incomplete. Worded only where
  // the tile says some months are not complete.
  const gaps = monthGaps(summary).map((gap) => (
    <Note key={gap.month}>{gapSentence(gap)}</Note>
  ));
  const withheld = (reason: ReactNode, months: ReactNode = null) => (
    <DerivedTile label={LABEL} value={null}>
      <Note>{reason}</Note>
      {months}
      {doubts}
    </DerivedTile>
  );

  // A market is waited for only where it is in view: in one company's view
  // the other's burn is not part of the figure, so it is never the reason.
  if (inView("us") && !coverage.us) {
    // Once Mercury has synced, "its first sync" is no longer what is awaited.
    return withheld(
      usFlowsReadAt === null
        ? "Arrives with Mercury's first sync."
        : "Needs a month Mercury has read to its end.",
    );
  }
  if (inView("kz") && !coverage.kz) {
    return withheld(
      inView("us") ? (
        <>
          US only so far, which would understate it. Enter Kazakhstan&apos;s bank balance at two
          month-ends in a row.{" "}
          <NoteLink href={ENTER_KZ_CASH} otherwise={OWNER_ENTERS_KZ_CASH}>
            Enter Kazakhstan&apos;s balance
          </NoteLink>
        </>
      ) : (
        <>
          Needs Kazakhstan&apos;s bank balance at two month-ends in a row.{" "}
          <NoteLink href={ENTER_KZ_CASH} otherwise={OWNER_ENTERS_KZ_CASH}>
            Enter Kazakhstan&apos;s balance
          </NoteLink>
        </>
      ),
    );
  }
  // A viewer on Globex alone is never sent what Startup sent it, and without
  // it the figure is not worked out: never the balances' fall as if nothing
  // had been sent, which would count the funding as income.
  if (kzAlone && funding?.side === "subsidiary" && funding.hidden) {
    return withheld(
      `Worked out with what ${COMPANIES.kz.name} receives from ${parent}, which is not yours to see.`,
    );
  }
  if (average === null) {
    return withheld("None of the last three months is complete yet.", gaps);
  }

  // Said wherever the figure rests on fewer than the three months, burning or
  // not: "Not burning" from one month of three is the direction that flatters.
  const whole = average.months.length === average.expected.length;
  const fewer = !whole && (
    <>
      <Note>
        {`Average of ${average.months.length} of the last 3 months. The rest are not complete.`}
      </Note>
      {gaps}
    </>
  );

  if (average.value <= 0) {
    // Zero, or a surplus too small to print: "exceeded by $0" would say nothing.
    const surplus = formatUsd(-average.value);
    return (
      <DerivedTile label={LABEL} value="Not burning" source={source}>
        <Note>
          {surplus === formatUsd(0)
            ? "Money in matched money out."
            : `Money in exceeded money out by ${surplus} a month.`}
        </Note>
        {fewer}
        {/* Outside money only. Startup's funding is never recorded there: Globex
            AI's figure takes it out already, and the group would count it twice. */}
        <Note>
          {kzAlone ? "If outside investor money arrived" : "If investor money arrived"}, record it as{" "}
          {/* The form of the market in view: Kazakhstan's own when the US is not. */}
          <NoteLink href={inView("us") ? ENTER_US_FINANCING : ENTER_KZ_FINANCING}>
            financing received
          </NoteLink>
          , so it is not counted
          as income.
        </Note>
        {received}
        {sent}
        {notSpend}
        {doubts}
      </DerivedTile>
    );
  }

  // Globex's own currency first in the hero: the dollar average back in
  // tenge at the rate today's cash was converted at, as the Budget tab does.
  const rate = tengeRate;
  const tenge = (n: number) => formatValue(n, "currency", "KZT");
  return (
    <DerivedTile
      label={LABEL}
      value={rate === null ? `${formatUsd(average.value)} / mo` : `${tenge(average.value * rate)} / mo`}
      exact={
        rate === null
          ? formatExact(average.value, "currency", "USD")
          : formatExact(average.value * rate, "currency", "KZT")
      }
      count={
        rate === null
          ? { value: average.value, format: formatUsd, unit: "/ mo" }
          : { value: average.value * rate, format: tenge, unit: "/ mo" }
      }
      alongside={rate === null ? undefined : `≈ ${formatUsd(average.value)} / mo`}
      trend={hero?.trend}
      source={source}
    >
      {fewer || (
        <Note>{`Average of ${monthRange(average.expected[0]!, average.expected.at(-1)!)}.`}</Note>
      )}
      {received}
      {sent}
      {notSpend}
      {doubts}
    </DerivedTile>
  );
}
