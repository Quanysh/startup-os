"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DOCTOR_WEEK_LABELS, TRIAL_OUTCOME_LABELS, type DoctorWeek, type TrialOutcome } from "@convex/lib/kzProductDetail";
import { Delta } from "@/components/metrics/change-chip";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { dayLabel } from "@/lib/format";
import { changeOf } from "@/lib/metrics/kz-detail";
import { doctorOver, eventWords, isWarningEvent, moduleLabel, type Doctor } from "@/lib/metrics/kz-doctors";

const count = (n: number) => n.toLocaleString("en-US");
const WEEK_TONE: Record<DoctorWeek, StatusTone> = {
  daily: "success",
  usual: "success",
  new: "success",
  more: "success",
  less: "warning",
  stopped: "danger",
  dormant: "neutral",
};
const OUTCOME_TONE: Record<TrialOutcome, StatusTone> = { paid: "success", kept: "success", left: "danger", never: "neutral" };

/** The clinic's doctors whose trial ended, and what came next, as the clinic card's "Trials" block. */
export function ClinicTrials({ doctors, now }: { doctors: readonly Doctor[]; now: number }) {
  const ended = doctors
    .filter((d) => d.trialEndedOn !== null && d.trialOutcome !== null)
    .sort((a, b) => b.trialEndedOn!.localeCompare(a.trialEndedOn!));
  return (
    <section aria-label="Trials" className="mt-6">
      <h3 className="text-sm font-medium text-ink">Trials</h3>
      {ended.length === 0 ? (
        <p className="mt-1 text-sm text-ink-2">No doctor of this clinic has come off a trial.</p>
      ) : (
        <DataTable label="Trials at this clinic" bleed={false} download={false}>
          <DataHead>
            <DataHeader>Doctor</DataHeader>
            <DataHeader>Ended</DataHeader>
            <DataHeader>What came next</DataHeader>
          </DataHead>
          <DataBody>
            {ended.map((d) => (
              <DataRow key={d.doctorId}>
                <DataRowHeader className="font-normal">{d.name}</DataRowHeader>
                <DataCell className="text-ink-2">{dayLabel(d.trialEndedOn!, now)}</DataCell>
                <DataCell>
                  <StatusChip tone={OUTCOME_TONE[d.trialOutcome!]}>{TRIAL_OUTCOME_LABELS[d.trialOutcome!]}</StatusChip>
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      )}
    </section>
  );
}

/**
 * A Kazakhstan clinic's doctors in its card, as the weekly report's clinic
 * card lists them: their group, last week against the week before, usual,
 * last action, last event and module. Names come from `customers.doctors`,
 * which sends them only for the caller's own clinics.
 */
export function ClinicDoctors({
  customerId,
  now,
  span = 1,
  end = null,
  withTrials = true,
}: {
  customerId: Id<"customers">;
  now: number;
  span?: number;
  end?: string | null;
  /** The trials block above the doctors: off where the page shows it apart. */
  withTrials?: boolean;
}) {
  const doctors = useQuery(api.customers.doctors, { customerId });
  if (doctors === undefined) return null;
  const rows = doctors.map((d) => doctorOver(d, span, end)).sort((a, b) => b.actions + (b.previous ?? 0) - (a.actions + (a.previous ?? 0)));
  return (
    <>
      {withTrials && <ClinicTrials doctors={rows} now={now} />}
      <section aria-label="Doctors" className="mt-6">
        <h3 className="text-sm font-medium text-ink">Doctors of the clinic</h3>
        {rows.length === 0 ? (
          <p className="mt-1 text-sm text-ink-2">No doctor of this clinic in the last 5 weeks.</p>
        ) : (
          <DataTable label="Doctors of the clinic" bleed={false} className="min-w-[44rem]">
            <DataHead>
              <DataHeader>Doctor</DataHeader>
              <DataHeader>Group</DataHeader>
              <DataHeader>Actions</DataHeader>
              <DataHeader numeric>
              <span title="Their average actions a week over the 4 weeks before last week">Usual week</span>
            </DataHeader>
              <DataHeader numeric>Last action</DataHeader>
              <DataHeader>Last event</DataHeader>
              <DataHeader>Module</DataHeader>
            </DataHead>
            <DataBody>
              {rows.map((d) => (
                <DataRow key={d.doctorId}>
                  <DataRowHeader className="font-medium">{d.name}</DataRowHeader>
                  <DataCell>
                    <StatusChip tone={WEEK_TONE[d.week]}>{DOCTOR_WEEK_LABELS[d.week]}</StatusChip>
                  </DataCell>
                  <DataCell className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span className="font-num">
                        {d.previous !== null && <span className="text-ink-3">{count(d.previous)} → </span>}
                        <span className="font-medium text-ink">{count(d.actions)}</span>
                      </span>
                      <Delta change={changeOf({ periodStart: d.weekStart, value: d.actions, previous: d.previous }, "up")} />
                    </span>
                  </DataCell>
                  <DataCell numeric>{d.usual === null ? "—" : d.usual.toFixed(1)}</DataCell>
                  <DataCell numeric className="text-ink-2">
                    {d.lastActiveOn === null ? "—" : dayLabel(d.lastActiveOn, now)}
                  </DataCell>
                  <DataCell>
                    {isWarningEvent(d.lastEvent) ? (
                      <StatusChip variant="outline" tone="warning">
                        {eventWords(d.lastEvent)}
                      </StatusChip>
                    ) : (
                      <span className="text-xs text-ink-3">{eventWords(d.lastEvent)}</span>
                    )}
                  </DataCell>
                  <DataCell className="text-ink-2">{moduleLabel(d.mainModule)}</DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
      </section>
    </>
  );
}
