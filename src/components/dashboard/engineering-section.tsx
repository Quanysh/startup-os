"use client";

import { ClockAlertIcon } from "lucide-react";
import Link from "next/link";
import { useNow } from "@/hooks/use-now";
import { OPEN_STAGES, placeOf, stuckCount } from "@/lib/engineering/flow";
import { STUCK_HREF, stuckWords } from "@/lib/metrics/engineering";
import { Count, Counts, DashboardSection, QuietLine, SectionSkeleton } from "./section";
import { usePullsInView } from "./reads";

/** Said where GitHub's list has no good read on record: never an empty count. */
export const PULLS_NOT_READ = "GitHub's pull requests have not been read yet.";

const isOpen = (stage: string) => (OPEN_STAGES as readonly string[]).includes(stage);

/**
 * Engineering in two counts, for a viewer with the engineering area: the
 * company in view's open pull requests and how many are stuck, by the
 * Engineering page's five rules (`stuckCount`), leading to the stuck ones.
 * Nothing of the viewer's own: their pull requests and reviews are on Today.
 */
export function EngineeringSection() {
  const pulls = usePullsInView();
  const now = useNow();
  if (pulls === null || pulls?.companies.length === 0) return null;
  const body = () => {
    if (pulls === undefined || now === null) return <SectionSkeleton className="h-14" />;
    if (pulls.readAt === null) return <QuietLine>{PULLS_NOT_READ}</QuietLine>;
    const open = pulls.rows.filter((pull) => {
      if (!pulls.companies.includes(pull.company)) return false;
      const placed = placeOf(pull, now);
      return placed !== null && isOpen(placed.stage);
    }).length;
    const stuck = pulls.companies.reduce((sum, company) => sum + (stuckCount(pulls, company, now) ?? 0), 0);
    return (
      <>
        <Counts>
          <Count label="Open" value={open} href="/engineering" />
          <Count
            label="Stuck"
            value={stuck}
            icon={stuck > 0 ? ClockAlertIcon : undefined}
            tone="text-weak"
            href={STUCK_HREF}
          />
        </Counts>
        {stuck > 0 && (
          <p className="mt-3 text-xs text-ink-2">
            <Link href={STUCK_HREF} className="font-medium text-ink underline underline-offset-2 hover:text-brand">
              {stuckWords(stuck)}
            </Link>
          </p>
        )}
      </>
    );
  };
  return (
    <DashboardSection title="Engineering" href="/engineering">
      {body()}
    </DashboardSection>
  );
}
