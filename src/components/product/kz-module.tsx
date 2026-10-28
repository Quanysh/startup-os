"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { KZ_MODULES, moduleKey, type KzModuleId } from "@convex/lib/kzProductDetail";
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
import { KindTag } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { chartSeries, changeOf, kzClinicHref, kzHref, moduleRows, type Span, type Week } from "@/lib/metrics/kz-detail";
import { doctorOver, type Doctor } from "@/lib/metrics/kz-doctors";
import { weekRows } from "@/lib/metrics/product";
import type { Tile } from "@/lib/metrics/scorecard";

const count = (n: number) => n.toLocaleString("en-US");
const LINK =
  "rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";
const dollars = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Move({
  week,
  better = "up",
  format = count,
  kind = "relative",
}: {
  week: Week | null;
  better?: "up" | "down";
  format?: (v: number) => string;
  kind?: "relative" | "points";
}) {
  if (week === null) return <span className="text-ink-3">Not read yet</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-num">
        {week.previous !== null && <span className="text-ink-3">{format(week.previous)} → </span>}
        <span className="font-medium text-ink">{format(week.value)}</span>
      </span>
      <Delta change={changeOf(week, better, kind)} />
    </span>
  );
}

function Stat({ label, children, note }: { label: string; children: ReactNode; note: string }) {
  return (
    <div className="min-w-0 rounded-inner bg-surface p-4">
      <p className="text-xs text-ink-2">{label}</p>
      <div className="mt-1 text-xl text-ink">{children}</div>
      <p className="mt-1 text-xs text-ink-2">{note}</p>
    </div>
  );
}

const share = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`);

/**
 * One module of Globex's app, as the weekly report's module card has it:
 * its week against the week before, its doctors by week, who uses it most,
 * its clinics, who stopped and its failures. Names come from
 * `customers.doctorRoster` and `customers.list`, for viewers with Customers.
 */
export function ModuleCard({
  tiles,
  module,
  span = 1,
  end = null,
}: {
  tiles: readonly Tile[];
  module: KzModuleId;
  span?: Span;
  end?: string | null;
}) {
  const { can } = useViewer();
  const allowed = can("customers");
  const roster = useQuery(api.customers.doctorRoster, allowed ? {} : "skip");
  const register = useQuery(api.customers.list, allowed ? {} : "skip");
  const label = KZ_MODULES.find((m) => m.id === module)?.label ?? module;
  const row = moduleRows(tiles, span, end).find((r) => r.id === module);
  const clinicName = new Map((register?.customers ?? []).map((c) => [c.id as string, c.name]));
  const clinicOf = (d: Doctor) => clinicName.get(d.customerId) ?? "—";
  const clinicHref = (d: Doctor) => kzClinicHref(d.customerId, span, end);

  const users = (roster ?? [])
    .map((d) => doctorOver(d, span, end))
    .map((d) => ({ d, now: d.modules[module] ?? 0, before: d.modulesPrevious[module] ?? 0 }));
  const using = users.filter((u) => u.now > 0).sort((a, b) => b.now - a.now || b.before - a.before);
  const totalNow = using.reduce((sum, u) => sum + u.now, 0);
  const stopped = users.filter((u) => u.before > 0 && u.now === 0).sort((a, b) => b.before - a.before);
  const byClinic = new Map<string, { id: string; name: string; doctors: number; now: number; before: number }>();
  for (const u of users) {
    if (u.now === 0 && u.before === 0) continue;
    const entry = byClinic.get(u.d.customerId) ?? { id: u.d.customerId, name: clinicOf(u.d), doctors: 0, now: 0, before: 0 };
    entry.doctors += u.now > 0 ? 1 : 0;
    entry.now += u.now;
    entry.before += u.before;
    byClinic.set(u.d.customerId, entry);
  }
  const clinics = [...byClinic.values()].sort((a, b) => b.now - a.now || b.before - a.before);

  return (
    <section aria-label={label} className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <Link href={kzHref({ view: "modules", module: null }, span, end)} className={`${LINK} text-sm`}>
          ← All modules
        </Link>
        <h2 className="text-lg font-medium text-ink">{label}</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Actions" note={span === 1 ? "the week before → last week" : `the ${span} weeks before → the last ${span}`}>
          <Move week={row?.actions ?? null} />
        </Stat>
        <Stat label="Doctors" note="who started one">
          <Move week={row?.doctors ?? null} />
        </Stat>
        <Stat label="Clinics" note="where a doctor started one">
          <Move week={row?.clinics ?? null} />
        </Stat>
        <Stat
          label="Failures"
          note={`slowest answers (p95): ${row?.p95 ? `${row.p95.previous ?? "—"} → ${row.p95.value} s` : "—"}${
            // AI cost is a finance figure: said only to Finance.
            can("finance")
              ? ` · AI: ${row?.aiCost ? `${row.aiCost.previous === null ? "—" : dollars(row.aiCost.previous)} → ${dollars(row.aiCost.value)}` : "—"}`
              : ""
          }`}
        >
          <Move week={row?.failureRate ?? null} better="down" kind="points" format={(v) => `${Math.round(v)}%`} />
        </Stat>
      </div>
      <Panel className="min-w-0">
        <MonthBars
          title="Doctors by week"
          grain="week"
          mode="grouped"
          series={[{ id: "doctors", label: "Doctors", color: "var(--chart-1)" }]}
          rows={weekRows({ doctors: chartSeries(tiles, moduleKey("doctors", module)) })}
          format={count}
        />
      </Panel>

      {!allowed ? (
        <p className="text-sm text-ink-2">Who uses it, and at which clinics, is shown with the Customers page.</p>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel className="min-w-0 space-y-2">
              <h3 className="text-sm font-medium text-ink">Who uses it most</h3>
              {using.length === 0 ? (
                <p className="text-sm text-ink-2">No doctor used it last week.</p>
              ) : (
                <DataTable label={`Doctors using ${label}`} bleed={false}>
                  <DataHead>
                    <DataHeader>Doctor</DataHeader>
                    <DataHeader>Clinic</DataHeader>
                    <DataHeader>Actions</DataHeader>
                    <DataHeader numeric>Share</DataHeader>
                  </DataHead>
                  <DataBody>
                    {using.map((u) => (
                      <DataRow key={`${u.d.customerId}:${u.d.doctorId}`}>
                        <DataRowHeader className="font-medium">{u.d.name}</DataRowHeader>
                        <DataCell>
                          <Link href={clinicHref(u.d)} className={LINK}>
                            {clinicOf(u.d)}
                          </Link>{" "}
                          {u.d.plan && (
                            <KindTag tone={u.d.plan === "paid" ? "violet" : "sand"}>{u.d.plan === "paid" ? "Paid" : "Trial"}</KindTag>
                          )}
                        </DataCell>
                        <DataCell>
                          <Move week={{ periodStart: u.d.weekStart, value: u.now, previous: u.before }} />
                        </DataCell>
                        <DataCell numeric>{share(u.now, totalNow)}</DataCell>
                      </DataRow>
                    ))}
                  </DataBody>
                </DataTable>
              )}
            </Panel>
            <Panel className="min-w-0 space-y-2">
              <h3 className="text-sm font-medium text-ink">Clinics</h3>
              {clinics.length === 0 ? (
                <p className="text-sm text-ink-2">—</p>
              ) : (
                <DataTable label={`Clinics using ${label}`} bleed={false}>
                  <DataHead>
                    <DataHeader>Clinic</DataHeader>
                    <DataHeader numeric>Doctors</DataHeader>
                    <DataHeader>Actions</DataHeader>
                    <DataHeader numeric>Share</DataHeader>
                  </DataHead>
                  <DataBody>
                    {clinics.map((c) => (
                      <DataRow key={c.id}>
                        <DataRowHeader className="font-normal">
                          <Link href={kzClinicHref(c.id, span, end)} className={LINK}>
                            {c.name}
                          </Link>
                        </DataRowHeader>
                        <DataCell numeric>{count(c.doctors)}</DataCell>
                        <DataCell>
                          <Move week={{ periodStart: "", value: c.now, previous: c.before }} />
                        </DataCell>
                        <DataCell numeric>{share(c.now, totalNow)}</DataCell>
                      </DataRow>
                    ))}
                  </DataBody>
                </DataTable>
              )}
            </Panel>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel className="space-y-2">
              <h3 className="text-sm font-medium text-ink">Stopped using it</h3>
              {stopped.length === 0 ? (
                <p className="text-sm text-ink-2">Nobody: everyone who used it the week before used it last week.</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
                  {stopped.map((u) => (
                    <li key={`${u.d.customerId}:${u.d.doctorId}`}>
                      <span className="font-medium">{u.d.name}</span> — {clinicOf(u.d)} · {count(u.before)} → 0
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel className="space-y-2">
              <h3 className="text-sm font-medium text-ink">Failures</h3>
              <p className="text-sm text-ink">
                <Move week={row?.failures ?? null} better="down" />
              </p>
              <p className="text-xs text-ink-2">
                By cause, for the whole app:{" "}
                <Link href={kzHref({ view: "issues", module: null })} className={LINK}>
                  Errors
                </Link>
                .
              </p>
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}
