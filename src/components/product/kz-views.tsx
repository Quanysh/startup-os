import Link from "next/link";
import { PRODUCT } from "@convex/lib/identity";
import { KZ_FAILURE_CAUSES, failureKey, type KzModuleId } from "@convex/lib/kzProductDetail";
import { Delta } from "@/components/metrics/change-chip";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { formatPeriod } from "@/lib/format";
import {
  KZ_VIEWS,
  FLAT_SECONDS_PERCENT,
  changeOf,
  kzHref,
  moduleRows,
  chartSeries,
  spanOf,
  type KzView,
  type Span,
  type Week,
} from "@/lib/metrics/kz-detail";
import { doubled, kzReport } from "@/lib/metrics/kz-report";
import { weekRows } from "@/lib/metrics/product";
import type { Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";
import { BrokeFigures, FailureHeatmap } from "./kz-broke-more";
import { ModuleCard } from "./kz-module";
import { SteadyLabel } from "./steady-label";
import { useNamedClinics, weeksWords } from "./kz-overview";
import { TileGrid } from "./tile-grid";

const count = (value: number) => value.toLocaleString("en-US");
const inProduct = (keys: readonly { key: string }[]) => keys.map(({ key }) => ({ key, scope: "kz_product" }));
const LINK =
  "rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** Links, not buttons: each view has its own address. */
export function KzViewNav({ current, span = 1, end = null }: { current: KzView["view"]; span?: Span; end?: string | null }) {
  return (
    <nav aria-label="Kazakhstan product" className="flex max-w-full flex-wrap gap-1">
      {KZ_VIEWS.map((view) => (
        <Link
          key={view.id}
          href={kzHref({ view: view.id, module: null }, span, end)}
          aria-current={view.id === current ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center rounded-full px-3 text-sm text-ink-2 outline-none transition hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
            view.id === current && "bg-panel font-medium text-ink shadow-soft-sm",
          )}
        >
          <SteadyLabel>{view.label}</SteadyLabel>
        </Link>
      ))}
    </nav>
  );
}

type Format = (value: number) => string;
const percent: Format = (v) => `${v.toFixed(1)}%`;
// Always to the cent: "$6.80", never "$6.8".
const dollars: Format = (v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Last week against this one: "487 → 544" with its chip. "Not read yet" where
 * the week has no figure, never a zero.
 */
function MoveCell({
  week,
  better,
  format = count,
  kind = "relative",
  flat,
}: {
  week: Week | null;
  better: "up" | "down";
  format?: Format;
  kind?: "relative" | "points";
  /** Under this percent a move reads "same" (default 5). */
  flat?: number;
}) {
  if (week === null) {
    return <DataCell className="text-ink-3">Not read yet</DataCell>;
  }
  return (
    <DataCell className="whitespace-nowrap" exportValue={format(week.value)}>
      <span className="inline-flex items-center gap-2">
        <span className="font-num">
          {week.previous !== null && <span className="text-ink-3">{format(week.previous)} → </span>}
          <span className="font-medium text-ink">{format(week.value)}</span>
        </span>
        <Delta change={changeOf(week, better, kind, flat)} />
      </span>
    </DataCell>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-ink-2">{children}</p>;
}

/** The newest week any of these figures has, in words, for a table's caption. */
function weekOf(weeks: readonly (Week | null)[]): string {
  const newest = weeks
    .flatMap((w) => (w === null ? [] : [w]))
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .at(-1);
  if (newest === undefined) return "No week read yet";
  const span = newest.weeks ?? 1;
  return span === 1 ? formatPeriod("week", newest.periodStart) : weeksWords(newest.periodStart, span).split(" → ")[1]!;
}

// ── Modules ────────────────────────────────────────────────────────────────

export function ModulesView({
  tiles,
  module,
  span = 1,
  end = null,
}: {
  tiles: readonly Tile[];
  module: KzModuleId | null;
  span?: Span;
  end?: string | null;
}) {
  // AI cost is a finance figure: its column is left out without Finance.
  const finance = useViewer().can("finance");
  if (module !== null) return <ModuleCard tiles={tiles} module={module} span={span} end={end} />;
  const rows = moduleRows(tiles, span, end);
  return (
    <section aria-label="Modules" className="space-y-3">
      <Panel>
        <DataTable
          caption={`Modules · ${weekOf(rows.map((r) => r.actions))}, against ${span === 1 ? "the week before" : `the ${span} weeks before`}`}
          showCaption
          className="min-w-[72rem]"
        >
          <DataHead>
            <DataHeader pinned>Module</DataHeader>
            <DataHeader>Actions</DataHeader>
            <DataHeader>Doctors</DataHeader>
            <DataHeader>Clinics</DataHeader>
            <DataHeader>Failures, %</DataHeader>
            <DataHeader>Slowest answers (p95), s</DataHeader>
            {finance && <DataHeader>AI cost</DataHeader>}
          </DataHead>
          <DataBody>
            {rows.map((row) => (
              <DataRow key={row.id}>
                <DataRowHeader pinned className="font-normal">
                  <Link href={kzHref({ view: "modules", module: row.id }, span, end)} className={LINK}>
                    {row.label}
                  </Link>
                </DataRowHeader>
                <MoveCell week={row.actions} better="up" />
                <MoveCell week={row.doctors} better="up" />
                <MoveCell week={row.clinics} better="up" />
                <MoveCell week={row.failureRate} better="down" format={percent} kind="points" />
                <MoveCell week={row.p95} better="down" flat={FLAT_SECONDS_PERCENT} />
                {finance && <MoveCell week={row.aiCost} better="down" format={dollars} />}
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      </Panel>
      <Note>
        Each cell is the week before → last week. Green is good news and red is not: more
        actions is green, more failures, slower answers or a higher AI cost is red; ≈ means within
        5% (1 point for the failure rate, 20% for answer times, which swing from week to week), the
        same as the week before. A doctor who used two modules is counted in each, so
        the doctors column does not add up to the app&apos;s total. Open a module for its weeks
        and the clinics that use it.
      </Note>
    </section>
  );
}

// ── Issues ─────────────────────────────────────────────────────────────────

export function IssuesView({
  tiles,
  now,
  span = 1,
  end = null,
}: {
  tiles: readonly Tile[];
  now: number;
  span?: Span;
  end?: string | null;
}) {
  const total = spanOf(tiles, "failures_total", span, end);
  // The biggest cause last week first, as the weekly report lists them.
  const causes = KZ_FAILURE_CAUSES.map((cause) => ({
    ...cause,
    week: spanOf(tiles, failureKey(cause.id), span, end),
  })).sort((a, b) => (b.week?.value ?? -1) - (a.week?.value ?? -1));
  const modules = moduleRows(tiles, span, end)
    .filter((row) => row.failures !== null)
    .sort((a, b) => (b.failures?.value ?? 0) - (a.failures?.value ?? 0));
  const share = (week: Week | null) =>
    week === null || total === null || total.value === 0 || week.periodStart !== total.periodStart
      ? "—"
      : `${Math.round((week.value / total.value) * 100)}%`;
  const report = kzReport(tiles, useNamedClinics(), span, end);
  return (
    <section aria-label="Errors" className="space-y-3">
      <Panel aria-label="P0–P1: fix first" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium text-ink">P0–P1: fix first</h2>
          {report.weekStart !== null && (
            <span className="text-xs text-ink-2">
              {span === 1
                ? `${formatPeriod("week", report.weekStart)}, against the week before`
                : weeksWords(report.weekStart, span).split(" → ").reverse().join(" against ")}
            </span>
          )}
        </div>
        {report.broken.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing broke this week: no record text in errors, no failure doubled, no clinic went silent.</p>
        ) : (
          <ul className="space-y-2">
            {report.broken.map((item) => (
              <li key={item.title} className="flex flex-wrap items-start gap-2 text-sm text-ink">
                <StatusChip tone="danger" variant={item.pri === "P0" ? "solid" : "outline"}>
                  {item.pri}
                </StatusChip>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{item.title}:</span> {item.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-2">
          P0 breaks doctors&apos; work or leaks data (record text in an error is always P0). P1 is
          something broken, or clinics and doctors leaving.
        </p>
      </Panel>
      <TileGrid figures={inProduct([{ key: "failures_total" }, { key: "error_record_text" }])} tiles={tiles} now={now} />
      <BrokeFigures tiles={tiles} span={span} end={end} />
      <FailureHeatmap />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel className="min-w-0">
          <DataTable caption={`Errors by cause · ${weekOf(causes.map((c) => c.week))}, against ${span === 1 ? "the week before" : `the ${span} weeks before`} (red: doubled)`} showCaption>
            <DataHead>
              <DataHeader>Cause</DataHeader>
              <DataHeader>Failures</DataHeader>
              <DataHeader numeric>Share</DataHeader>
            </DataHead>
            <DataBody>
              {causes.map((cause) => (
                <DataRow key={cause.id} tone={cause.week !== null && doubled(cause.week) ? "danger" : undefined}>
                  <DataRowHeader className="font-normal">{cause.label}</DataRowHeader>
                  <MoveCell week={cause.week} better="down" />
                  <DataCell numeric className="text-ink-2">{share(cause.week)}</DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        </Panel>
        <Panel className="min-w-0">
          <DataTable caption={`Failures by module · ${weekOf(modules.map((m) => m.failures))}, against ${span === 1 ? "the week before" : `the ${span} weeks before`}`} showCaption>
            <DataHead>
              <DataHeader>Module</DataHeader>
              <DataHeader>Failures</DataHeader>
              <DataHeader>Failure rate</DataHeader>
            </DataHead>
            <DataBody>
              {modules.map((row) => (
                <DataRow key={row.id}>
                  <DataRowHeader className="font-normal">
                    <Link href={kzHref({ view: "modules", module: row.id }, span, end)} className={LINK}>
                      {row.label}
                    </Link>
                  </DataRowHeader>
                  <MoveCell week={row.failures} better="down" />
                  <MoveCell week={row.failureRate} better="down" format={percent} kind="points" />
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        </Panel>
      </div>
      <Panel className="min-w-0">
        <MonthBars
          title="Failures by week"
          grain="week"
          mode="grouped"
          series={[{ id: "failures", label: "Failures", color: "var(--chart-1)" }]}
          rows={weekRows({ failures: chartSeries(tiles, "failures_total") })}
          format={count}
        />
      </Panel>
      <Note>
        A failure is counted by its cause, never by what the error said: an error message can
        hold a model&apos;s answer, and {PRODUCT.name} holds no medical record.
      </Note>
    </section>
  );
}
