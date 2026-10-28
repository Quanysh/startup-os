"use client";

import { CalendarClockIcon, CircleAlertIcon, CircleDashedIcon } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import { complianceSummary } from "@/lib/compliance/due";
import { localIsoDate } from "@/lib/dates";
import { useObligations } from "./reads";
import { Count, Counts, DashboardSection, QuietLine, SectionSkeleton } from "./section";

/**
 * Dates, counted: what is overdue, what is due soon, and which dates nobody
 * has confirmed yet. It says nothing about whether the company meets any
 * standard, wears no "good" colour, and shows no obligation's title, which is
 * free text and could name a clinic.
 */
export function ComplianceSection() {
  const obligations = useObligations();
  const now = useNow();
  if (obligations === null) return null;

  if (obligations === undefined || now === null) {
    return (
      <DashboardSection title="Compliance" href="/compliance">
        <SectionSkeleton className="h-14" />
      </DashboardSection>
    );
  }

  // /compliance's own summary. A date is a deadline only once it is confirmed.
  const summary = complianceSummary(obligations, localIsoDate(now));
  return (
    <DashboardSection title="Compliance" href="/compliance">
      {summary.total === 0 ? (
        <QuietLine>Nothing is tracked yet.</QuietLine>
      ) : (
        <Counts className="max-w-xl">
          <Count
            label="Overdue"
            value={summary.overdue.length}
            icon={CircleAlertIcon}
            tone="text-weak"
          />
          <Count
            label="Due in 30 days"
            value={summary.dueSoon.length}
            icon={CalendarClockIcon}
            tone="text-watch"
          />
          <Count
            label="Unconfirmed"
            value={summary.unconfirmed.length}
            icon={CircleDashedIcon}
            tone="text-ink-3"
          />
        </Counts>
      )}
    </DashboardSection>
  );
}
