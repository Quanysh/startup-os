"use client";

import { useId, type ReactNode } from "react";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { supplySentence } from "@/components/metrics/hero-mrr";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { HeroTiles } from "@/components/metrics/tile-frame";
import { dayLabel, formatExact, formatPeriod, formatUsd, formatValue } from "@/lib/format";
import { AVERAGE_MONTHS, LONGEST_RUNWAY_MONTHS, cashPartIsOld, type Runway } from "@/lib/metrics/finance";
import {
  ownRunway,
  type CompanyFigures,
  type GroupAmount,
  type GroupFigures,
  type GroupRunway,
  type Missing,
} from "@/lib/finance/group";
import { Reveal } from "./motion";
import { ENTER_KZ_CASH, Note, NoteLink } from "./notes";

const MONTHS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
// Each company's own currency, from its identity (convex/lib/identity.ts).
const CURRENCY: Record<CompanyId, "USD" | "KZT"> = { us: COMPANIES.us.currency, kz: COMPANIES.kz.currency };
const NOT_KNOWN = "Not known yet";

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** "Aug 2026", "Jul and Aug 2026", "Dec 2025 and Jan 2026". */
function monthsWords(months: readonly string[]): string {
  const year = months[0]?.slice(0, 4) ?? "";
  if (!months.every((month) => month.slice(0, 4) === year)) return listed(months.map((m) => formatPeriod("month", m)));
  return `${listed(months.map((m) => formatPeriod("month", m, "short")))} ${year}`;
}
/** The months a company's part lacks what Startup sent, oldest first. */
const unsentMonths = (figures: CompanyFigures) => figures.unsent.map((gap) => gap.month);

/** The figures of the hero a note can be under. */
type Figure = "cash" | "netBurn" | "runway" | "mrr";

/**
 * What a group figure lacks, said as what is missing and where it comes
 * from: a typed figure links to its line of "Record a figure" (the plain
 * sentence, no link, for a viewer who cannot enter figures), a source's says
 * which source brings it. The rate is the CFO workbook's, wherever it lacks.
 */
function missingWords(figure: Figure, what: Missing, us: CompanyFigures, kz: CompanyFigures): ReactNode {
  if (what === "fx") {
    return supplySentence("fx_usd_kzt", "company", {
      enter: (link) => <>Needs a {link("USD/KZT rate")} to add {COMPANIES.kz.name}&apos;s tenge.</>,
      source: (source) => `Needs a USD/KZT rate to add ${COMPANIES.kz.name}'s tenge: it arrives with ${source}.`,
    });
  }
  // The runway waits for the figures it divides, whose own notes say what they lack.
  if (figure === "runway") return null;
  const name = COMPANIES[what].name;
  if (figure === "cash") {
    return what === "kz" ? (
      <>
        {COMPANIES.kz.name}&apos;s <NoteLink href={ENTER_KZ_CASH}>month-end balance</NoteLink> is not on record yet.
      </>
    ) : (
      supplySentence("cash", "us", {
        enter: (link) => <>{COMPANIES.us.name}&apos;s {link("balance")} is not on record yet.</>,
        source: (source) => `${COMPANIES.us.name}'s balance arrives with ${source}.`,
      })
    );
  }
  if (figure === "mrr") {
    return supplySentence("mrr", what, {
      enter: (link) => (
        <>
          {name}&apos;s {link("MRR figure")} is not on record yet.
        </>
      ),
      source: (source) => `${name}'s MRR arrives with ${source}.`,
    });
  }
  // Net burn: Startup's part is its burn less what it sent Globex; Globex
  // AI's is its own, with what Startup sent taken out. Either can wait on that.
  if (what === "us") {
    if (us.netBurn === null) return `${COMPANIES.us.name}'s net burn needs a month Mercury has read to its end.`;
    return `${COMPANIES.us.name}'s part needs Mercury's figure for what it sent ${COMPANIES.kz.name} in ${monthsWords(unsentMonths(us))}.`;
  }
  // (Waiting only for a rate, it is the rate that is missing: `groupFigures`.)
  if (kz.unsent.length > 0) {
    return `${COMPANIES.kz.name}'s net burn needs Mercury's figure for what ${COMPANIES.us.name} sent it in ${monthsWords(unsentMonths(kz))}.`;
  }
  return (
    <>
      {COMPANIES.kz.name}&apos;s net burn needs its <NoteLink href={ENTER_KZ_CASH}>month-end balance</NoteLink> at two month-ends
      in a row.
    </>
  );
}

const runwayWords = (runway: Runway) =>
  runway.kind === "not_burning"
    ? "Not burning"
    : runway.months > LONGEST_RUNWAY_MONTHS
      ? "10+ years"
      : `${MONTHS.format(runway.months)} mo`;

/**
 * Each company's own figure under the group's, in its own currency: what the
 * group adds up, and what still shows when the group cannot be added.
 */
function Split({ label, parts }: { label: string; parts: { company: CompanyId; text: string | null }[] }) {
  return (
    <dl aria-label={`${label} by company`} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      {parts.map(({ company, text }) => (
        <div key={company} className="contents">
          <dt className="text-ink-2">{COMPANIES[company].name}</dt>
          <dd className={text === null ? "text-ink-3" : "font-num font-medium text-ink"}>{text ?? NOT_KNOWN}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What the companies' figures behind a group figure are, for saying what one lacks. */
type Behind = { figure: Figure; us: CompanyFigures; kz: CompanyFigures };

function Missing({ amount, behind }: { amount: GroupAmount | GroupRunway; behind: Behind }) {
  if (amount.kind !== "unknown") return null;
  return (
    <>
      {amount.missing.map((what) => {
        const words = missingWords(behind.figure, what, behind.us, behind.kz);
        return words === null ? null : <Note key={what}>{words}</Note>;
      })}
    </>
  );
}

/** A group figure in dollars, or "Not known yet" with what it lacks, and each company's own under it. */
function GroupTile({
  label,
  amount,
  unit,
  split,
  behind,
  children,
}: {
  label: string;
  amount: GroupAmount;
  unit?: string;
  split: { company: CompanyId; text: string | null }[];
  behind: Behind;
  children?: ReactNode;
}) {
  return (
    <DerivedTile
      label={label}
      value={amount.kind === "known" ? `${formatUsd(amount.usd)}${unit ? ` ${unit}` : ""}` : null}
      exact={amount.kind === "known" ? formatExact(amount.usd, "currency", "USD") : undefined}
      count={amount.kind === "known" ? { value: amount.usd, format: formatUsd, unit } : undefined}
    >
      <Split label={label} parts={split} />
      <Missing amount={amount} behind={behind} />
      {children}
    </DerivedTile>
  );
}

/**
 * The group's money story, in dollars: group cash ÷ group net burn = group
 * runway, and MRR under it. Each figure adds Startup's to Globex's at the
 * stored rate, and names each company's own figure in its own currency under
 * it. Where a company has no figure, or no rate is on record, the group's is
 * "Not known yet" and says why, and each company's own figures still show.
 * The runway projections are each company's own (Runway and what changes it):
 * a projection is never added across currencies.
 */
export function GroupHero({
  group,
  us,
  kz,
  rate,
  now,
}: {
  group: GroupFigures;
  us: CompanyFigures;
  kz: CompanyFigures;
  rate: { rate: number; periodStart: string } | null;
  now: number;
}) {
  const headingId = useId();
  const figuresOf = (company: CompanyId) => (company === "us" ? us : kz);
  const money = (company: CompanyId, amount: number) => formatValue(amount, "currency", CURRENCY[company]);
  const each = (pick: (figures: CompanyFigures) => number | null, unit = "") =>
    (["us", "kz"] as const).map((company) => {
      const value = pick(figuresOf(company));
      return { company, text: value === null ? null : `${money(company, value)}${unit}` };
    });
  // Each balance with its day, and whether it is past its own limit, as the company's own Cash says it.
  const isOld = (company: CompanyId) => {
    const cash = figuresOf(company).cash;
    return cash !== null && cashPartIsOld({ scope: company, native: cash.amount, usd: 0, periodStart: cash.periodStart }, now);
  };
  const balances = (["us", "kz"] as const).map((company) => {
    const cash = figuresOf(company).cash;
    return {
      company,
      text:
        cash === null
          ? null
          : [money(company, cash.amount), dayLabel(cash.periodStart, now), ...(isOld(company) ? ["out of date"] : [])].join(
              " · ",
            ),
    };
  });
  const anyOld = isOld("us") || isOld("kz");
  // A company's part of fewer than the three months: said, with where to read why.
  const shortAverages = (["us", "kz"] as const).flatMap((company) => {
    const burn = figuresOf(company).groupBurn;
    return burn !== null && burn.months.length < AVERAGE_MONTHS
      ? [`${COMPANIES[company].name}'s is of ${burn.months.length} of the last ${AVERAGE_MONTHS} months`]
      : [];
  });
  // A month with no figure of what Startup sent Globex is in neither part.
  // Startup's own lens does not need it, so the reason is said here.
  const unsent = [...new Set([...us.unsent, ...kz.unsent].filter((gap) => gap.lacks === "sent").map((gap) => gap.month))].sort();
  const runways = (["us", "kz"] as const).map((company) => {
    const own = ownRunway(company === "us" ? us : kz);
    return { company, text: own === null ? null : runwayWords(own) };
  });
  const runway = group.runway;
  // What the runway waits for: the figures it divides, each of whose notes says why.
  const waitsFor = [
    ...(group.cash.kind === "unknown" && group.cash.missing.some((m) => m !== "fx") ? ["group cash"] : []),
    ...(group.netBurn.kind === "unknown" && group.netBurn.missing.some((m) => m !== "fx") ? ["group net burn"] : []),
  ];
  const mrrMonths = (["us", "kz"] as const).flatMap((company) => {
    const mrr = (company === "us" ? us : kz).mrr;
    return mrr === null ? [] : [`${COMPANIES[company].name}'s is of ${formatPeriod("month", mrr.periodStart)}`];
  });

  return (
    <section
      aria-labelledby={headingId}
      className="wash-brand relative overflow-hidden rounded-card bg-panel p-6 shadow-soft sm:p-8"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id={headingId} className="text-sm font-medium text-ink-2">
          Group, in US dollars
        </h2>
        <p className="text-xs text-ink-3">
          {rate === null
            ? "No USD/KZT rate on record yet: each company's own figures stand, the group's wait for one."
            : `${COMPANIES.kz.name}'s tenge at ₸${rate.rate.toLocaleString("en-US")} per $1, the ${formatPeriod("month", rate.periodStart)} rate.`}
        </p>
      </div>
      <HeroTiles>
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-6">
          <Reveal order={0} className="min-w-0">
            <GroupTile label="Cash" amount={group.cash} split={balances} behind={{ figure: "cash", us, kz }} />
          </Reveal>
          <Operator>÷</Operator>
          <Reveal order={1} className="min-w-0">
            {/* Each company's part, which add up to the group's: what Startup
                sent Globex is in neither, since it is Globex's financing. */}
            <GroupTile
              label="Net burn"
              amount={group.netBurn}
              unit="/ mo"
              split={each((f) => f.groupBurn?.amount ?? null, " / mo")}
              behind={{ figure: "netBurn", us, kz }}
            >
              <Note>{COMPANIES.us.name}&apos;s is its own spending: its net burn from Mercury less what it sent {COMPANIES.kz.name}.</Note>
              <Note>
                {COMPANIES.kz.name}&apos;s is from its month-end balances, with what {COMPANIES.us.name} sent it taken out as financing, not
                counted as income.
              </Note>
              {unsent.length > 0 && (
                <Note>{`${monthsWords(unsent)} ${unsent.length === 1 ? "has" : "have"} no whole figure from Mercury of what ${COMPANIES.us.name} sent ${COMPANIES.kz.name}, so ${unsent.length === 1 ? "it is" : "they are"} left out of both companies' parts.`}</Note>
              )}
              {shortAverages.length > 0 && (
                <Note>{`${shortAverages.join("; ")}: the rest are not complete. Each company's own view says why.`}</Note>
              )}
            </GroupTile>
          </Reveal>
          <Operator>=</Operator>
          <Reveal order={2} className="min-w-0">
            <DerivedTile
              label="Runway"
              value={runway.kind === "unknown" ? null : runwayWords(runway)}
              exact={runway.kind === "months" ? formatExact(runway.months, "months") : undefined}
              count={
                runway.kind === "months" && runway.months <= LONGEST_RUNWAY_MONTHS
                  ? { value: runway.months, format: (n) => MONTHS.format(n), unit: "mo" }
                  : undefined
              }
            >
              <Split label="Runway" parts={runways} />
              {waitsFor.length > 0 && <Note>{`Needs ${listed(waitsFor)} first.`}</Note>}
              <Missing amount={runway} behind={{ figure: "runway", us, kz }} />
              <Note>Group cash ÷ group net burn.</Note>
              <Note>
                Each company&apos;s own: {COMPANIES.us.name}&apos;s counts what it sends {COMPANIES.kz.name}; {COMPANIES.kz.name}&apos;s is without new
                money from {COMPANIES.us.name}.
              </Note>
              {anyOld && runway.kind !== "unknown" && <Note caution>Uses a balance that is out of date.</Note>}
            </DerivedTile>
          </Reveal>
        </div>
        <Reveal order={3} className="mt-8 border-t border-line pt-6">
          <div className="max-w-md">
            <GroupTile
              label="MRR"
              amount={group.mrr}
              split={each((f) => f.mrr?.amount ?? null)}
              behind={{ figure: "mrr", us, kz }}
            >
              {mrrMonths.length > 0 && <Note>{`Each company's latest: ${mrrMonths.join(", ")}.`}</Note>}
            </GroupTile>
          </div>
        </Reveal>
      </HeroTiles>
    </section>
  );
}

/** The operator between two figures of the runway equation: decoration, said in the notes. */
function Operator({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="hidden self-start pt-9 text-4xl font-light text-ink-3 lg:block">
      {children}
    </span>
  );
}
