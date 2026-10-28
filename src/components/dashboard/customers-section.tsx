"use client";

import { CircleCheckIcon, EyeIcon, TriangleAlertIcon } from "lucide-react";
import { PayingFigures } from "@/components/customers/paying-figures";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { registerDayOf } from "@/lib/customers/health";
import { assess, healthCounts } from "@/lib/customers/view";
import { useClinics } from "./reads";
import { Count, Counts, DashboardSection, QuietLine, SectionSkeleton } from "./section";

/**
 * The clinics of the company in view: how many pay, how many sit at each
 * health level, and what they owe. Counts only: no clinic is named here, and
 * the list behind each count is on /customers.
 */
export function CustomersSection() {
  const clinics = useClinics();
  const data = useScorecard();
  const now = useNow();
  const allowed = useViewer().can("customers");
  if (!allowed || clinics === null) return null;

  if (clinics === undefined || data === undefined || now === null) {
    return (
      <DashboardSection title="Customers" href="/customers">
        <SectionSkeleton />
      </DashboardSection>
    );
  }

  // Health as /customers works it out: as of the register's last push.
  const counts = healthCounts(assess(clinics.customers, registerDayOf(clinics.lastPushAt, now)));
  const onRecord = clinics.customers.some((clinic) => !clinic.archived);

  return (
    <DashboardSection title="Customers" href="/customers">
      {onRecord ? (
        <>
          <Counts>
            <Count label="Healthy" value={counts.good} icon={CircleCheckIcon} tone="text-good" />
            <Count
              label="Watch"
              value={counts.watch}
              icon={EyeIcon}
              tone="text-watch"
              href="/customers?health=watch"
            />
            <Count
              label="At risk"
              value={counts.at_risk}
              icon={TriangleAlertIcon}
              tone="text-weak"
              href="/customers?health=at_risk"
            />
          </Counts>
          {/* Not healthy, not anything: nothing is on record to judge them by. */}
          {counts.unknown > 0 && (
            <p className="mt-3 text-xs text-ink-2">
              {counts.unknown === 1
                ? "1 more has nothing on record to judge by."
                : `${counts.unknown} more have nothing on record to judge by.`}
            </p>
          )}
        </>
      ) : (
        <QuietLine>No clinics are on record yet.</QuietLine>
      )}

      {/* Paying clinics and receivables: the same component the Customers page shows. */}
      <PayingFigures flat className="mt-5 border-t border-line pt-5" />
    </DashboardSection>
  );
}
