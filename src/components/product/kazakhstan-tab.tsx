import { useSearchParams } from "next/navigation";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel } from "@/components/panel";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useViewer } from "@/hooks/use-viewer";
import { chartSeries, readKzView, readPeriod, seriesOf, withHistory, type Period } from "@/lib/metrics/kz-detail";
import { clinicRows, weekRows } from "@/lib/metrics/product";
import { ClinicsView } from "./kz-clinics";
import { KzReport, KzWatch, PeriodFigures } from "./kz-overview";
import { PeriodBar, PeriodTitle } from "./kz-period";
import { SpeedView } from "./kz-speed";
import { TrackingView, TrackingWarning } from "./kz-tracking";
import { DoctorsView } from "./kz-doctors";
import { IssuesView, KzViewNav, ModulesView } from "./kz-views";
import { TileGrid, type TabProps } from "./tile-grid";

// The scorecard's own two weekly figures beside the report's: everyone signed
// in and active, and checks that finished.
const ALSO = ["weekly_active_users", "checks_completed"].map((key) => ({ key, scope: "kz_product" }));

// Using the product is the product's own scope; active clients are the
// market's, a figure of the finance section: sent only to a viewer with
// Finance, and left out for anyone else. The workbook counts the two apart,
// so they pile into one bar.
const USING = { key: "clinics_using", scope: "kz_product" };
const ACTIVE = { key: "clinics_active", scope: "kz" };
const ACTIONS = [{ id: "actions", label: "Actions", color: "var(--chart-1)" }];
const PEOPLE = [
  { id: "doctors", label: "Doctors with an action", color: "var(--chart-1)" },
  { id: "clinics", label: "Clinics that ran a check", color: "var(--chart-2)" },
];
// A monthly chart with a month or two in it says nothing a tile does not.
const MONTHS_WORTH_CHARTING = 3;
const SERIES = [
  { id: "active", label: "Active clients", color: "var(--chart-1)" },
  { id: "using", label: "Using, no active contract", color: "var(--chart-2)" },
];
// Without Finance there is no active count to stack on: the product's own clinics alone.
const USING_ALONE = [{ id: "using", label: "Using the product", color: "var(--chart-2)" }];

/**
 * No benchmark anywhere on this tab: every published band is US or EU data.
 * Five views, chosen in the address (`?view=`), as the team's weekly report
 * has them: the overview, modules, clinics, doctors and errors, with speed and
 * tracking health beside them.
 */
export function KazakhstanTab(props: TabProps) {
  const params = useSearchParams();
  const { view, module } = readKzView(params);
  const period = readPeriod(params);
  const span = period.weeks;
  const end = period.end;
  const { now, sources } = props;
  // The scorecard sends 13 weeks of a figure; the year of Globex's weekly
  // figures comes with it, so a period can reach back that far.
  const { companies } = useViewer();
  const history = useQuery(api.kzProduct.history, companies.includes("kz") ? {} : "skip");
  const tiles = withHistory(props.tiles, history);
  const mondays = seriesOf(tiles, "checks_started").map((p) => p.periodStart);
  return (
    <>
      {/* The period on the left, the picker and the data's freshness on the right, as the weekly report heads its page. */}
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <PeriodTitle period={period} mondays={mondays} />
        <PeriodBar view={{ view, module }} period={period} mondays={mondays} sources={sources} />
      </div>
      <KzViewNav current={view} span={span} end={end} />
      {view === "overview" && <Overview {...props} tiles={tiles} period={period} />}
      {view === "modules" && <ModulesView tiles={tiles} module={module} span={span} end={end} />}
      {view === "speed" && <SpeedView tiles={tiles} span={span} end={end} />}
      {view === "clinics" && <ClinicsView now={now} module={module} span={span} end={end} />}
      {view === "doctors" && <DoctorsView tiles={tiles} now={now} span={span} end={end} />}
      {view === "tracking" && <TrackingView tiles={tiles} />}
      {view === "issues" && <IssuesView tiles={tiles} now={now} span={span} end={end} />}
      <p className="text-xs text-ink-2">
        Trend only: the published benchmarks are US and EU data, so none is shown for Kazakhstan.
      </p>
    </>
  );
}

function Overview({ tiles, now, period }: TabProps & { period: Period }) {
  const { weeks: span, end } = period;
  const weekly = (key: string) => chartSeries(tiles, key);
  const count = (value: number) => value.toLocaleString("en-US");
  // Active clients are Finance's: without it, the product's own clinics alone.
  const finance = useViewer().can("finance");
  const months = clinicRows(finance ? seriesOf(tiles, ACTIVE.key, ACTIVE.scope) : [], weekly(USING.key));
  return (
    <>
      <TrackingWarning span={span} end={end} />
      <KzReport tiles={tiles} span={span} end={end} />
      <PeriodFigures tiles={tiles} span={span} end={end} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="min-w-0">
          <MonthBars
            title="Actions by week"
            grain="week"
            mode="grouped"
            series={ACTIONS}
            rows={weekRows({ actions: weekly("actions") })}
            format={count}
          />
        </Panel>
        <Panel className="min-w-0">
          <MonthBars
            title="Doctors and clinics by week"
            grain="week"
            mode="grouped"
            series={PEOPLE}
            rows={weekRows({ doctors: weekly("doctors_working"), clinics: weekly("clinics_checking") })}
            format={count}
          />
        </Panel>
      </div>
      <p className="text-xs text-ink-2">
        Real doctors only: no test accounts, staging or localhost. Weeks are Monday to Sunday;
        an action is a check, a search, an inquiry, a form, a capture or an upload.
      </p>
      <section aria-label="More figures" className="space-y-3">
        <h2 className="text-base font-medium text-ink">More figures</h2>
        <TileGrid figures={[...ALSO, USING, ...(finance ? [ACTIVE] : [])]} tiles={tiles} now={now} four />
        <p className="text-xs text-ink-2">
          Active clients and clinics using without an active contract come from the CFO workbook,
          once a month: it sorts every clinic ever under contract into active, using (a pilot, free
          use, or a contract not signed or lapsed) and churned, so the two never overlap. What
          counts as &quot;using&quot; is the workbook&apos;s own call.
        </p>
        {months.length >= MONTHS_WORTH_CHARTING && (
          <Panel className="min-w-0">
            <MonthBars title="Clinics by month" mode="stacked" series={finance ? SERIES : USING_ALONE} rows={months} format={count} />
          </Panel>
        )}
      </section>
      {/* Folded at the foot, as the weekly report keeps it. */}
      <KzWatch tiles={tiles} span={span} end={end} />
    </>
  );
}
