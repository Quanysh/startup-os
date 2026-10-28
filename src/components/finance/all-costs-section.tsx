"use client";

import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronRightIcon, ListIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useRef, useState, type ReactNode } from "react";
import type { Live } from "@convex/lib/budget";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { featureOn } from "@convex/lib/featureGates";
import { CADENCE_LABELS, type CostCategory } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import { KIND_PLURALS } from "@convex/lib/payroll";
import { CategoryTag, Money } from "@/components/costs/shared";
import { GatedLink } from "@/components/gated-link";
import { Panel } from "@/components/panel";
import {
  Blank,
  DataBody,
  DataCell,
  DataFoot,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewer } from "@/hooks/use-viewer";
import {
  ROW_LABELS,
  nextSort,
  readSort,
  sortRows,
  writeSort,
  type AllCosts,
  type Figures,
  type Gap,
  type Lens,
  type Row,
  type Segment,
  type Slot,
  type Sort,
  type SortKey,
} from "@/lib/finance/all-costs";
import { latestRate } from "@/lib/finance/group";
import { formatMinor, formatPeriod } from "@/lib/format";
import type { Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";
import { useAllCosts } from "./use-all-costs";

// All costs: every recurring cost of the companies in the lens this month, in
// one place. Payroll's total cost and the cost register's run-rate, by
// category; the group's in dollars. The chart's colours are the chart series
// and the Costs page's kind hues in a fixed order (Payroll, Services, Office,
// Cloud, Software), validated together on both panels (CLAUDE.md, "Charts and tiles"); the
// small categories fold into one neutral "Other costs", which is not a
// categorical slot. Every figure is also in the table beside it.

export const NOT_KNOWN = "Not known yet";

const SLOTS: Record<Slot, { label: string; color: string }> = {
  payroll: { label: "Payroll", color: "var(--chart-1)" },
  services: { label: "Services", color: "var(--color-kind-plum)" },
  office: { label: "Office", color: "var(--color-kind-sand)" },
  cloud: { label: "Cloud", color: "var(--color-kind-teal)" },
  software: { label: "Software", color: "var(--color-kind-violet)" },
  rest: { label: "Other costs", color: "var(--color-ink-3)" },
};

const BYLINE: Record<Lens, string> = {
  group: "Both companies this month, in US dollars: Payroll and the cost register, by category.",
  us: "This month: Payroll and the cost register, by category.",
  kz: "This month, in tenge with dollars alongside: Payroll and the cost register, by category.",
};

/** A share as it is read: "88%", "<1%" for a sliver. */
function percent(share: number): string {
  const whole = Math.round(share * 100);
  return whole === 0 && share > 0 ? "<1%" : `${whole}%`;
}

const linkClass =
  "rounded-sm font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Mounted by the Finance page after the hero, for the lens in view. A viewer
 * who holds neither Payroll nor Costs reads one line and sends no query.
 */
export function AllCostsSection({ lens, currentMonth, tiles }: { lens: Lens; currentMonth: string; tiles: readonly Tile[] }) {
  const viewer = useViewer();
  const holdsPayroll = viewer.can("payroll");
  const holdsCosts = viewer.can("costs");
  return (
    <Frame lens={lens} byline={holdsPayroll || holdsCosts}>
      {holdsPayroll || holdsCosts ? (
        <Body lens={lens} currentMonth={currentMonth} tiles={tiles} />
      ) : (
        <p className="mt-3 text-sm text-ink-2">Pay is on the Payroll page, and every other cost on the Costs page.</p>
      )}
    </Frame>
  );
}

function Frame({ lens, byline, children }: { lens: Lens; byline: boolean; children: ReactNode }) {
  const heading = useId();
  return (
    <Panel id="all-costs" aria-labelledby={heading} className="min-w-0 scroll-mt-6" data-lens={lens}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id={heading} className="text-base">
            All costs
          </h2>
          {byline && <p className="mt-0.5 max-w-xl text-xs text-ink-3">{BYLINE[lens]}</p>}
        </div>
        <p className="flex gap-4 text-sm">
          <GatedLink href="/costs" className={linkClass} otherwise={null}>
            Open Costs
          </GatedLink>
          <GatedLink href="/payroll" className={linkClass} otherwise={null}>
            Open Payroll
          </GatedLink>
        </p>
      </div>
      {children}
    </Panel>
  );
}

function Body({ lens, currentMonth, tiles }: { lens: Lens; currentMonth: string; tiles: readonly Tile[] }) {
  const data = useAllCosts(lens, currentMonth, tiles);
  if (data === undefined) return <Skeleton className="mt-4 h-72 rounded-inner" aria-busy />;
  const rate = latestRate(tiles);
  return (
    <div className="mt-5 space-y-6">
      <Headline data={data} />
      {data.chart.kind === "drawn" && <Composition data={data} segments={data.chart.segments} />}
      <Suspense fallback={<Skeleton className="h-48 rounded-inner" />}>
        <CategoryTable data={data} />
      </Suspense>
      <Notes data={data} rate={lens === "us" ? null : rate} />
    </div>
  );
}

// ── Money in a lens ─────────────────────────────────────────────────────────

/** The figure in a column, or why there is none. `none` is how a known nothing reads. */
function Amount({
  figure,
  currency,
  usd = null,
  none = null,
}: {
  figure: Live | undefined;
  currency: Currency;
  usd?: number | null;
  none?: string | null;
}) {
  if (figure === undefined || figure.kind === "hidden" || figure.kind === "withheld") return <Blank />;
  if (figure.kind === "loading") return <Blank>…</Blank>;
  if (figure.kind === "unknown") return <Blank>{NOT_KNOWN}</Blank>;
  if (figure.amount === 0 && none !== null) return <Blank>{none}</Blank>;
  return (
    <>
      {formatMinor(figure.amount, currency)}
      {usd !== null && <span className="block text-xs font-normal text-ink-2">≈ {formatMinor(usd, "USD")}</span>}
    </>
  );
}

// Each company's own currency, from its identity (convex/lib/identity.ts).
const CURRENCY: Record<CompanyId, Currency> = { us: COMPANIES.us.currency, kz: COMPANIES.kz.currency };

/** What the totals leave out, as the labels say it. */
function excludesWords(data: AllCosts): string | null {
  if (data.excludes.length === 0 || data.excludes.length === 2) return null;
  return data.excludes[0] === "payroll" ? "excludes Payroll" : "exclude registered costs";
}

// ── The three figures ───────────────────────────────────────────────────────

function Headline({ data }: { data: AllCosts }) {
  const pay = !data.excludes.includes("payroll");
  const register = !data.excludes.includes("costs");
  const parts = (both: string, payOnly: string, costsOnly: string) => (pay && register ? both : pay ? payOnly : costsOnly);
  const excludes = excludesWords(data);
  return (
    <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
      <Headfigure
        label="Monthly costs"
        figures={data.monthly}
        currency={data.currency}
        excludes={excludes}
        meaning={parts(
          "Payroll's total cost (gross and company-paid) plus the cost register's run-rate, a yearly bill as a twelfth.",
          "Payroll's total cost: gross and company-paid.",
          "The cost register's run-rate: recurring lines spread evenly, a yearly bill as a twelfth.",
        )}
      >
        {data.lens === "group" && <Split data={data} />}
      </Headfigure>
      <Headfigure
        label="Yearly at this rate"
        figures={data.yearly}
        currency={data.currency}
        excludes={excludes}
        meaning="Monthly costs × 12: a simple multiple, not a forecast."
      />
      <Headfigure
        label="Cash due this month"
        figures={data.cashDue}
        currency={data.currency}
        excludes={excludes}
        meaning={parts(
          "Payroll plus what the cost register has fall due: yearly and quarterly bills whole, and one-offs.",
          "Payroll: it is paid every month.",
          "What the cost register has fall due: yearly and quarterly bills whole, and one-offs.",
        )}
      />
    </dl>
  );
}

function Headfigure({
  label,
  figures,
  currency,
  excludes,
  meaning,
  children,
}: {
  label: string;
  figures: Figures;
  currency: Currency;
  excludes: string | null;
  meaning: string;
  children?: ReactNode;
}) {
  const { main } = figures;
  return (
    <div className="min-w-0">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="mt-1">
        <span className={cn("block text-2xl font-medium tracking-tight", main.kind === "known" ? "text-ink" : "text-ink-3")}>
          {main.kind === "known" ? formatMinor(main.amount, currency) : main.kind === "loading" ? "…" : NOT_KNOWN}
        </span>
        {currency === "KZT" && figures.kzUsd !== null && (
          <span className="block text-sm text-ink-2">≈ {formatMinor(figures.kzUsd, "USD")}</span>
        )}
        {excludes !== null && <span className="mt-0.5 block text-xs font-medium text-ink-2">{excludes}</span>}
        <span className="mt-1 block text-xs leading-relaxed text-ink-3">{meaning}</span>
        {children}
      </dd>
    </div>
  );
}

/** Each company's part of the group's monthly costs, in its own currency, and its share. */
function Split({ data }: { data: AllCosts }) {
  const share = (company: CompanyId) => data.split?.find((part) => part.company === company)?.share;
  return (
    <ul aria-label="Each company's part" className="mt-2 space-y-0.5 text-xs">
      {data.companies.map((company) => {
        const own = data.monthly.own[company];
        const part = share(company);
        return (
          <li key={company} className="flex flex-wrap gap-x-1.5">
            <span className="text-ink-2">{COMPANIES[company].name}</span>
            <span className="font-num text-ink">
              {own?.kind === "known" ? formatMinor(own.amount, CURRENCY[company]) : NOT_KNOWN}
              {company === "kz" && own?.kind === "known" && data.monthly.kzUsd !== null && ` ≈ ${formatMinor(data.monthly.kzUsd, "USD")}`}
              {part !== undefined && `, ${percent(part)}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ── The composition ─────────────────────────────────────────────────────────

function Composition({ data, segments }: { data: AllCosts; segments: Segment[] }) {
  const [active, setActive] = useState<number | null>(null);
  const marks = useRef<(HTMLDivElement | null)[]>([]);
  const money = (minor: number) => formatMinor(minor, data.currency);
  const partOf = (key: Row["key"]) => data.rows.find((row) => row.key === key)!;
  const words = (s: Segment) => `${SLOTS[s.slot].label}: ${money(s.value)}, ${percent(s.share)} of monthly costs`;

  return (
    <figure className="min-w-0">
      <div className="relative">
        <div role="group" aria-label="Monthly costs by category" className="flex h-3 gap-0.5 motion-safe:animate-wipe">
          {segments.map((s, i) => (
            <div
              key={s.slot}
              ref={(element) => {
                marks.current[i] = element;
              }}
              role="img"
              aria-label={words(s)}
              tabIndex={i === 0 ? 0 : -1}
              data-slot-key={s.slot}
              className={cn(
                "h-full min-w-[3px] cursor-default outline-none forced-color-adjust-none focus-visible:ring-3 focus-visible:ring-ring/50",
                i === 0 && "rounded-l-[4px]",
                i === segments.length - 1 && "rounded-r-[4px]",
                active !== null && active !== i && "opacity-60",
              )}
              style={{ flexGrow: s.value, flexBasis: 0, backgroundColor: SLOTS[s.slot].color }}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              onKeyDown={(event) => {
                const last = segments.length - 1;
                const target =
                  event.key === "ArrowLeft" ? Math.max(i - 1, 0)
                  : event.key === "ArrowRight" ? Math.min(i + 1, last)
                  : event.key === "Home" ? 0
                  : event.key === "End" ? last
                  : null;
                if (event.key === "Escape") setActive(null);
                if (target === null) return;
                event.preventDefault();
                marks.current[target]?.focus();
              }}
            />
          ))}
        </div>
        {active !== null && (
          <SegmentTooltip
            segment={segments[active]!}
            at={segments.slice(0, active).reduce((sum, s) => sum + s.share, 0) + segments[active]!.share / 2}
            money={money}
            parts={segments[active]!.slot === "rest" ? segments[active]!.parts.map(partOf) : []}
          />
        )}
      </div>
      <figcaption className="mt-3">
        <ul aria-label="Legend" className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-2">
          {segments.map((s) => (
            <li key={s.slot} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] forced-color-adjust-none" style={{ backgroundColor: SLOTS[s.slot].color }} />
              {SLOTS[s.slot].label}
              <span className="font-num text-ink">{percent(s.share)}</span>
            </li>
          ))}
        </ul>
        <p className="sr-only">Use the left and right arrow keys to move between categories.</p>
      </figcaption>
    </figure>
  );
}

function SegmentTooltip({
  segment,
  at,
  money,
  parts,
}: {
  segment: Segment;
  /** Where the segment's middle is, as a share of the bar. */
  at: number;
  money: (minor: number) => string;
  parts: Row[];
}) {
  const across = Math.min(Math.max(at * 100, 0), 100);
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute bottom-full z-20 mb-2 w-max max-w-64 rounded-inner bg-panel px-3 py-2 text-[11px] leading-4 shadow-soft ring-1 ring-line"
      style={{ left: `${across}%`, transform: `translateX(-${across}%)` }}
    >
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <span aria-hidden className="size-2 rounded-[2px] forced-color-adjust-none" style={{ backgroundColor: SLOTS[segment.slot].color }} />
        {SLOTS[segment.slot].label}
      </p>
      <p className="mt-0.5 font-num text-ink">
        {money(segment.value)} <span className="text-ink-2">{percent(segment.share)}</span>
      </p>
      {parts.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {parts.map((row) => (
            <li key={row.key} className="flex justify-between gap-3">
              <span className="text-ink-2">{ROW_LABELS[row.key]}</span>
              <span className="font-num text-ink">{row.main.kind === "known" ? money(row.main.amount) : NOT_KNOWN}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── The table ───────────────────────────────────────────────────────────────

type Column = { key: SortKey; label: string; company: CompanyId | null; strong: boolean };

/** Each column says its currency: "Startup, USD", "Globex, KZT", "Group, USD". */
const companyColumn = (company: CompanyId, strong: boolean): Column => ({
  key: company,
  label: `${COMPANIES[company].name}, ${CURRENCY[company]}`,
  company,
  strong,
});

function columnsOf(data: AllCosts): Column[] {
  if (data.lens === "group") {
    return [
      companyColumn("us", false),
      companyColumn("kz", false),
      { key: "group", label: "Group, USD", company: null, strong: true },
    ];
  }
  return [companyColumn(data.lens, true)];
}

function SortHeader({
  sort,
  column,
  numeric,
  pinned,
  strong,
  onSort,
  children,
}: {
  sort: Sort;
  column: SortKey;
  numeric?: boolean;
  pinned?: boolean;
  strong?: boolean;
  onSort: (next: Sort) => void;
  children: string;
}) {
  const state = sort.key !== column ? "none" : sort.dir === "asc" ? "ascending" : "descending";
  const Icon = state === "ascending" ? ArrowUpIcon : state === "descending" ? ArrowDownIcon : ArrowUpDownIcon;
  return (
    <DataHeader numeric={numeric} pinned={pinned} strong={strong} aria-sort={state}>
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, column))}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
          state !== "none" && "text-ink",
        )}
      >
        {children}
        <Icon aria-hidden className={cn("size-3.5 shrink-0", state === "none" && "opacity-50")} />
      </button>
    </DataHeader>
  );
}

/** Reads the address (the sort), so it sits under a Suspense boundary. */
function CategoryTable({ data }: { data: AllCosts }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = new URLSearchParams(params?.toString() ?? "");
  const sort = readSort(current, data.lens);
  const onSort = (next: Sort) => {
    const query = writeSort(current, next, data.lens);
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  // Every category's lines are in view unless folded: a cost is read by its
  // name (Claude, rent, Yandex Cloud), not found under a sum. Payroll opens on
  // a click alone. Each row's own click flips it from what "Every line" says.
  const [everyLine, setEveryLine] = useState(true);
  const [flipped, setFlipped] = useState<ReadonlySet<Row["key"]>>(new Set());
  const isOpen = (key: Row["key"]) => (key !== "payroll" && everyLine) !== flipped.has(key);
  const toggle = (key: Row["key"]) =>
    setFlipped((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const hasLines = data.rows.some((row) => row.lines.length > 0);
  const columns = columnsOf(data);
  const rows = sortRows(data.rows, sort);
  const excludes = excludesWords(data);
  const tableId = useId();

  return (
    <div className="space-y-2">
      {hasLines && (
        <div className="flex justify-end">
          <button
            type="button"
            aria-pressed={everyLine}
            onClick={() => {
              setEveryLine((was) => !was);
              setFlipped(new Set());
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              everyLine ? "bg-brand/12 text-brand ring-brand/25" : "text-ink-2 ring-line hover:text-ink",
            )}
          >
            <ListIcon aria-hidden className="size-3.5" />
            Every line
          </button>
        </div>
      )}
      <DataTable caption="Monthly costs by category" download="All costs" className="min-w-[36rem]">
        <DataHead>
          <SortHeader sort={sort} column="category" pinned onSort={onSort}>
            Category
          </SortHeader>
          {columns.map((column) => (
            <SortHeader key={column.key} sort={sort} column={column.key} numeric strong={column.strong} onSort={onSort}>
              {column.label}
            </SortHeader>
          ))}
          <SortHeader sort={sort} column="share" numeric onSort={onSort}>
            Share
          </SortHeader>
        </DataHead>
        {rows.map((row) => (
          <CategoryRows
            key={row.key}
            row={row}
            columns={columns}
            open={isOpen(row.key)}
            onToggle={() => toggle(row.key)}
            controls={`${tableId}-${row.key}`}
          />
        ))}
        <DataFoot>
          <DataRow plain>
            <DataRowHeader pinned>
              Total a month
              {excludes !== null && <span className="block text-xs font-normal text-ink-2">{excludes}</span>}
            </DataRowHeader>
            {columns.map((column) => (
              <DataCell key={column.key} numeric strong={column.strong}>
                <Amount
                  figure={column.company === null ? data.monthly.main : data.monthly.own[column.company]}
                  currency={column.company === null ? "USD" : CURRENCY[column.company]}
                  usd={column.company === "kz" ? data.monthly.kzUsd : null}
                />
              </DataCell>
            ))}
            <DataCell />
          </DataRow>
        </DataFoot>
      </DataTable>
    </div>
  );
}

function CategoryRows({
  row,
  columns,
  open,
  onToggle,
  controls,
}: {
  row: Row;
  columns: Column[];
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  const hidden = row.main.kind === "hidden";
  const opens = !hidden && (row.kinds !== null || row.lines.length > 0);
  const label =
    row.key === "payroll" ? (
      <>
        Payroll
        {!hidden && <span className="block text-xs font-normal text-ink-2">Gross and company-paid</span>}
      </>
    ) : row.key === "costs" ? (
      "Registered costs"
    ) : (
      <CategoryTag category={row.key as CostCategory} />
    );

  return (
    <DataBody stripe="groups">
      <DataRow>
        <DataRowHeader pinned>
          {opens ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={controls}
              onClick={onToggle}
              className="inline-flex items-start gap-1 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronRightIcon aria-hidden className={cn("mt-0.5 size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
              <span>{label}</span>
            </button>
          ) : (
            label
          )}
        </DataRowHeader>
        {hidden ? (
          <DataCell colSpan={columns.length + 1} className="text-ink-2">
            {row.key === "payroll" ? "On the Payroll page" : "On the Costs page"}
          </DataCell>
        ) : (
          <>
            {columns.map((column) => (
              <DataCell key={column.key} numeric strong={column.strong}>
                <Amount
                  figure={column.company === null ? row.main : row.own[column.company]}
                  currency={column.company === null ? "USD" : CURRENCY[column.company]}
                  usd={column.company === "kz" ? row.kzUsd : null}
                  none="—"
                />
              </DataCell>
            ))}
            <DataCell numeric>
              <ShareBar share={row.share} />
            </DataCell>
          </>
        )}
      </DataRow>
      {open && opens && (
        <>
          {row.kinds?.map((kind, i) => (
            <DataRow key={kind.kind} plain id={i === 0 ? controls : undefined}>
              <DataRowHeader pinned className="pl-8 font-normal text-ink-2">
                {KIND_PLURALS[kind.kind]}
              </DataRowHeader>
              {columns.map((column) => (
                <DataCell key={column.key} numeric className="text-ink-2">
                  <Amount
                    figure={column.company === null ? kind.main : kind.own[column.company]}
                    currency={column.company === null ? "USD" : CURRENCY[column.company]}
                    usd={column.company === "kz" ? kind.kzUsd : null}
                    none="—"
                  />
                </DataCell>
              ))}
              <DataCell />
            </DataRow>
          ))}
          {row.key === "payroll" && (
            <DataRow plain>
              <DataCell colSpan={columns.length + 2} className="pl-8 text-xs text-ink-2">
                Each person&apos;s pay is on the Payroll page.{" "}
                <Link href="/payroll" className={linkClass}>
                  Open Payroll<span className="sr-only"> for people</span>
                </Link>
              </DataCell>
            </DataRow>
          )}
          {row.lines.map((line, i) => (
            <DataRow key={`${line.company}:${line.id}`} plain id={i === 0 ? controls : undefined}>
              <DataRowHeader pinned className="pl-8 font-normal">
                {line.name}
                <span className="block text-xs text-ink-2">
                  {CADENCE_LABELS[line.cadence]}
                  {line.variable && ", an estimate"}
                </span>
              </DataRowHeader>
              {columns.map((column) => (
                <DataCell key={column.key} numeric className="text-ink-2">
                  {column.company === line.company ? (
                    <Money minor={line.monthly} currency={line.currency} estimate={line.variable} />
                  ) : column.company === null ? (
                    line.main === null ? (
                      <Blank>{NOT_KNOWN}</Blank>
                    ) : (
                      <Money minor={line.main} currency="USD" estimate={line.variable} />
                    )
                  ) : null}
                </DataCell>
              ))}
              <DataCell numeric className="text-ink-2">
                <ShareBar share={line.share} bar={false} />
              </DataCell>
            </DataRow>
          ))}
        </>
      )}
    </DataBody>
  );
}

/** A row's share of the monthly total: a thin bar in one quiet hue, its value written. */
function ShareBar({ share, bar = true }: { share: number | null; bar?: boolean }) {
  if (share === null) return null;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden className={cn("hidden h-1.5 w-16 overflow-hidden rounded-full sm:block", bar && "bg-surface")}>
        {bar && (
          <span className="block h-full rounded-full bg-ink-3 forced-color-adjust-none" style={{ width: `max(2px, ${share * 100}%)` }} />
        )}
      </span>
      <span className="w-9 text-right">{percent(share)}</span>
    </span>
  );
}

// ── What the figures rest on ────────────────────────────────────────────────

const GAP_WORDS: Record<Gap["what"], Partial<Record<Gap["reason"], string>>> = {
  payroll: {
    rates: "a rate is not set on the Payroll page",
    circle: "two pay lines subtract each other",
    no_rate: "someone is paid in the other currency and no USD/KZT rate is on record",
  },
  costs: { no_rate: "a cost is in the other currency and no USD/KZT rate is on record" },
  fx: {},
};

function gapSentence(gap: Gap): string {
  if (gap.what === "fx") return `The group's figures wait for a USD/KZT rate to add ${COMPANIES.kz.name}'s tenge: it arrives with the CFO workbook.`;
  const whose = `${COMPANIES[gap.company!].name}'s ${gap.what === "payroll" ? "Payroll" : "cost register"}`;
  return `${whose} is not known yet: ${GAP_WORDS[gap.what][gap.reason] ?? "a figure is missing"}.`;
}

function Notes({ data, rate }: { data: AllCosts; rate: { rate: number; periodStart: string } | null }) {
  const lines: string[] = [];
  if (data.excludes.includes("payroll")) lines.push("Pay is on the Payroll page: the totals here leave it out.");
  if (data.excludes.includes("costs")) lines.push("The cost register is on the Costs page: the totals here leave it out.");
  for (const gap of data.gaps) lines.push(gapSentence(gap));
  if (rate !== null && data.companies.includes("kz")) {
    lines.push(`Dollars for ${COMPANIES.kz.name}'s tenge at ₸${rate.rate.toLocaleString("en-US")} per $1, the ${formatPeriod("month", rate.periodStart)} rate.`);
  }
  if (data.chart.kind === "not_drawn" && data.chart.reason === "not_known") {
    lines.push("The chart waits for every figure in the table to be known.");
  }
  // The group's alone: a company's lens says nothing of the other.
  if (data.lens === "group" && featureOn("subsidiaryFunding")) {
    const { kz, us } = COMPANIES;
    lines.push(`${kz.name} (${kz.legalName}) is ${us.legalName}'s subsidiary: the team is paid through it, and most subscriptions by ${us.name}.`);
  }
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1 text-xs leading-relaxed text-ink-2">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
