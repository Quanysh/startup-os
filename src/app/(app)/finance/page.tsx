"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ExternalLinkIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { CompanyId } from "@convex/lib/company";
import { FINANCIAL_MODEL_URL } from "@convex/lib/features";
import { periodStart } from "@convex/lib/periods";
import { AttentionList } from "@/components/attention-list";
import { AllCostsSection } from "@/components/finance/all-costs-section";
import { FinanceTabs } from "@/components/finance/finance-tabs";
import { GroupHero } from "@/components/finance/group-hero";
import { FinanceHero } from "@/components/finance/hero";
import { BOTH_COMPANIES_NOTE, LensControl, lensesOf, setLens, useLens } from "@/components/finance/lens";
import { GroupMoneyOutSection, MoneyOutSection } from "@/components/finance/money-out-section";
import { Reveal } from "@/components/finance/motion";
import { PlanSection } from "@/components/finance/plan-section";
import { RecordFigure } from "@/components/finance/record-figure";
import { GroupedRevenueHealth, RevenueHealth } from "@/components/finance/revenue-health";
import { GroupRunwayGlance, RunwayGlance } from "@/components/finance/runway-glance";
import { UnitEconomicsSection } from "@/components/finance/unit-economics-section";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { sourcesOf, tilesOf } from "@/lib/company";
import { groupOfCard } from "@/lib/finance/group";
import { BOTH_MARKETS, financeSummary, moneyTilesOf, tilesInView } from "@/lib/metrics/finance";
import { attentionItems, sourcesOfSection } from "@/lib/metrics/scorecard";
import { AnimatedGrid } from "@/components/ui/animated-grid";

type Card = FunctionReturnType<typeof api.metrics.scorecard>;
type Series = FunctionReturnType<typeof api.metrics.series>;

/** Days of US balances asked for: enough to hold last month's close. */
const US_HISTORY_DAYS = 62;

// The sources whose failed run belongs on this page: the ones that feed it.
const FINANCE_SOURCES = new Set(sourcesOfSection("finance").map((id) => `source:${id}`));

/**
 * Finance: one money page for both companies. It does not follow the
 * sidebar's company switch: a viewer on both picks a lens here (the group in
 * dollars, the default, or one company in its own currency), and a viewer on
 * one company has that company alone, with no group and no word of the
 * other. In each lens: the money story first (cash ÷ net burn = runway, and
 * MRR), then every recurring cost this month (all costs), then where the
 * money went month by month, the financial model's plan against what
 * happened (Startup's), runway and what changes it, revenue health, and the
 * quiet form for typed-in figures. Each section asks only for what its
 * viewer may see.
 */
export default function FinancePage() {
  const viewer = useViewer();
  const lenses = lensesOf(viewer.companies);
  const lens = useLens(lenses);
  const onUs = viewer.companies.includes("us");
  const onKz = viewer.companies.includes("kz");
  // The scorecard as the server sends it: only the viewer's companies'
  // figures, whatever the sidebar's switch says.
  const card = useQuery(api.metrics.scorecard);
  // A tile carries thirteen days of a daily metric. Month closes need every
  // balance of the last year, so Kazakhstan's history is read on its own; the
  // US needs last month's close for the trend. Each is asked for only by a
  // viewer on that company, and waited for only where the lens shows it.
  const kzHistory = useQuery(api.metrics.series, onKz ? { key: "cash", scope: "kz", limit: 400 } : "skip");
  const usHistory = useQuery(api.metrics.series, onUs ? { key: "cash", scope: "us", limit: US_HISTORY_DAYS } : "skip");
  const now = useNow();
  const needs = (company: CompanyId) => lens === "group" || lens === company;
  const kzCash = needs("kz") ? kzHistory : [];
  const usCash = needs("us") ? usHistory : [];

  return (
    <div className="space-y-6">
      <header className="relative isolate flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <AnimatedGrid className="-inset-x-4 sm:-inset-x-8 -inset-y-10 -z-10" />
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl">Finance</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-2">
            {lens === "group"
              ? "What the companies have, what they spend and how long that lasts, together and each on its own."
              : "What the company has, what it spends and how long that lasts."}
          </p>
          {lenses.length > 1 && <p className="mt-1 max-w-xl text-xs text-ink-3">{BOTH_COMPANIES_NOTE}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
          <PageFreshness page="finance" />
          {/* The CFO's financial model is Startup's (the owner, 2026-10-16); a
              deployment without one (an empty FINANCIAL_MODEL_URL) shows no link. */}
          {needs("us") && FINANCIAL_MODEL_URL !== "" && (
            <a
              href={FINANCIAL_MODEL_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 w-fit shrink-0 items-center gap-1.5 rounded-full bg-panel px-4 text-sm font-medium text-ink shadow-soft-sm outline-none transition hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Open the CFO model
              <ExternalLinkIcon aria-hidden className="size-3.5 text-ink-3" />
            </a>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FinanceTabs current="/finance" />
        {lens !== null && <LensControl lenses={lenses} lens={lens} />}
      </div>

      {lens === null ? null : card === undefined || kzCash === undefined || usCash === undefined || now === null ? (
        <div className="space-y-6" aria-busy>
          <Skeleton className="h-96 rounded-card" />
          <Skeleton className="h-80 rounded-card" />
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-72 rounded-card" />
            <Skeleton className="h-72 rounded-card" />
          </div>
        </div>
      ) : lens === "group" ? (
        <GroupLoaded card={card} kzCash={kzCash} now={now} />
      ) : (
        <CompanyLoaded card={card} kzCash={kzCash} usCash={usCash} now={now} company={lens} both={lenses.length > 1} />
      )}
    </div>
  );
}

/** Failed runs of the sources that feed these figures. A number that is missing or old says so on its own figure. */
/** Today as "YYYY-MM-DD" (UTC, as the periods are): where the runway's line starts. */
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

function failuresOf(card: Pick<Card, "tiles" | "sources">, now: number) {
  return attentionItems(card.tiles, card.sources, now).filter(
    (item) => item.severity === "error" && FINANCE_SOURCES.has(item.id),
  );
}

/** One company's lens: its figures alone, in its own currency, and nothing of the other. */
function CompanyLoaded({
  card: all,
  kzCash,
  usCash,
  now,
  company,
  both,
}: {
  card: Card;
  kzCash: Series;
  usCash: Series;
  now: number;
  company: CompanyId;
  /** Whether the viewer is on both companies (and so may be told where Startup's plan is). */
  both: boolean;
}) {
  const { isOwner, can, companies } = useViewer();
  const owner = isOwner && can("personal");
  const card = { ...all, tiles: tilesOf(company, all.tiles), sources: sourcesOf(company, all.sources) };
  // Which month is still in progress is the client's to say: a query cannot
  // know what "now" is.
  const currentMonth = periodStart("month", now);
  // When Mercury last finished a run decides which of its months are whole.
  // Not a tile's `syncedAt`: a write leaves that alone when the value is unchanged.
  // Read from every source sent: in Globex's lens it decides whether a month
  // of what Startup sent it is whole, though Mercury is no source of its page.
  const readAt = all.sources.mercury?.lastOkAt ?? null;
  const markets = [company];
  // The company's own tiles, and in Globex's what Startup sent it, which its burn takes out.
  const summary = financeSummary(moneyTilesOf(company, all.tiles, companies), kzCash, currentMonth, readAt, markets);
  const failures = failuresOf(card, now);
  const tiles = tilesInView(card.tiles, markets);
  const usMrr = card.tiles.find((tile) => tile.key === "mrr" && tile.scope === "us")?.series ?? [];

  return (
    <>
      {/* A failed Mercury run must be visible on the page whose numbers it feeds. */}
      {failures.length > 0 && <AttentionList items={failures} />}

      <FinanceHero summary={summary} now={now} tiles={tiles} daily={{ us: usCash, kz: kzCash }} company={company} />

      {/* Every recurring cost this month. The whole card's tiles: a cost in the
          other currency needs the exchange rate, which is no one company's figure. */}
      <Reveal order={4}>
        <AllCostsSection lens={company} currentMonth={currentMonth.slice(0, 7)} tiles={all.tiles} />
      </Reveal>
      {/* One paying customer: what it brings in and costs. The rate is no one company's figure either. */}
      <Reveal order={5}>
        <UnitEconomicsSection lens={company} currentMonth={currentMonth.slice(0, 7)} tiles={all.tiles} />
      </Reveal>
      <Reveal order={6}>
        <MoneyOutSection company={company} currentMonth={currentMonth.slice(0, 7)} card={card} />
      </Reveal>
      {/* Startup's plan sits beside its runway. Globex's lens has only a line
          saying whose the plan is, after the runway, and only for a viewer who
          is on Startup too: a viewer on Globex alone is told nothing of it. */}
      <Reveal order={7} className={company === "us" ? "grid items-start gap-6 lg:grid-cols-2" : "space-y-4"}>
        {company === "us" && <PlanSection company={company} summary={summary} now={now} mrr={usMrr} />}
        <RunwayGlance company={company} summary={summary} today={dayOf(now)} />
        {company !== "us" && both && (
          <PlanSection company={company} summary={summary} now={now} mrr={usMrr} onShowStartup={() => setLens("us")} />
        )}
      </Reveal>

      <Reveal order={8}>
        <RevenueHealth tiles={tiles} summary={summary} now={now} owner={owner} company={company} />
      </Reveal>

      {/* Typed-in figures (Kazakhstan's cash, financing, the rest): the settings area's. */}
      <RecordFigure />
    </>
  );
}

/**
 * The group's lens, for a viewer on both companies: the money story in
 * dollars with each company's own figures under it, the group's money out
 * by register, the group's runway in dollars above each company's own side
 * by side (a company's projection is never added across currencies), where Startup's plan is, and each company's
 * revenue health under its name.
 */
function GroupLoaded({ card, kzCash, now }: { card: Card; kzCash: Series; now: number }) {
  const { isOwner, can } = useViewer();
  const owner = isOwner && can("personal");
  const currentMonth = periodStart("month", now);
  const readAt = card.sources.mercury?.lastOkAt ?? null;
  const own = (company: CompanyId) => financeSummary(card.tiles, kzCash, currentMonth, readAt, [company]);
  const { usSummary, rate, us, kz, group } = groupOfCard(card.tiles, kzCash, currentMonth, readAt);
  const kzSummary = own("kz");
  const failures = failuresOf(card, now);
  const tilesOfCompany = (company: CompanyId) => tilesInView(card.tiles, [company]);
  const usMrr = card.tiles.find((tile) => tile.key === "mrr" && tile.scope === "us")?.series ?? [];

  return (
    <>
      {failures.length > 0 && <AttentionList items={failures} />}

      <GroupHero group={group} us={us} kz={kz} rate={rate} now={now} />

      <Reveal order={4}>
        <AllCostsSection lens="group" currentMonth={currentMonth.slice(0, 7)} tiles={card.tiles} />
      </Reveal>
      {/* A column per company, never a sum: different products, different customers. */}
      <Reveal order={5}>
        <UnitEconomicsSection lens="group" currentMonth={currentMonth.slice(0, 7)} tiles={card.tiles} />
      </Reveal>
      <Reveal order={6}>
        <GroupMoneyOutSection currentMonth={currentMonth.slice(0, 7)} card={card} />
      </Reveal>

      <Reveal order={7} className="space-y-4">
        {/* The group's runway first, in dollars at the group's net burn; each
            company's own below it, whose lines do not add up (each says why). */}
        <GroupRunwayGlance group={group} today={dayOf(now)} />
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <RunwayGlance company="us" summary={usSummary} today={dayOf(now)} named />
          <RunwayGlance company="kz" summary={kzSummary} today={dayOf(now)} named />
        </div>
        <PlanSection company="kz" summary={usSummary} now={now} mrr={usMrr} onShowStartup={() => setLens("us")} />
      </Reveal>

      <Reveal order={8}>
        <GroupedRevenueHealth
          groups={BOTH_MARKETS.map((company) => ({
            company,
            tiles: tilesOfCompany(company),
            summary: company === "us" ? usSummary : kzSummary,
          }))}
          now={now}
          owner={owner}
        />
      </Reveal>

      <RecordFigure />
    </>
  );
}
