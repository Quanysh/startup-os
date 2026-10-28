"use client";

import { Note } from "@/components/finance/notes";
import { CommittedTile, NextStepTile } from "@/components/fundraising/fundraising-tiles";
import { FlatTiles } from "@/components/metrics/tile-frame";
import { agree, countOf } from "@/components/pipeline/words";
import { useNow } from "@/hooks/use-now";
import { investorSummary } from "@/lib/pipeline/derive";
import { funnelRows } from "@/lib/pipeline/funnel";
import { ACTIVE_INVESTOR_STAGES, INVESTOR_COLUMNS } from "@/lib/pipeline/stages";
import { Funnel } from "./funnel";
import { useInvestors } from "./reads";
import { DashboardSection, QuietLine, SectionSkeleton } from "./section";

// From the list to a yes. "Passed" is not a step of the funnel.
const STAGES = ["target", ...ACTIVE_INVESTOR_STAGES, "committed"];

/**
 * Investors by stage, what is committed, and who in conversation has nothing
 * planned. Startup's alone, and counts only: no investor is named here.
 */
export function FundraisingSection() {
  const board = useInvestors();
  const now = useNow();
  if (board === null) return null;

  if (board === undefined || now === null) {
    return (
      <DashboardSection title="Fundraising" href="/fundraising">
        <SectionSkeleton className="h-40" />
      </DashboardSection>
    );
  }

  const rows = funnelRows(board, INVESTOR_COLUMNS, STAGES);
  // The fundraising page's own summary: the same function its tiles use.
  const summary = investorSummary(board, now);
  const nobody = rows.every((row) => row.count === 0);
  return (
    <DashboardSection title="Fundraising" href="/fundraising">
      {nobody ? (
        <QuietLine>No investors are on the board yet.</QuietLine>
      ) : (
        <>
          <Funnel caption="Investors by stage" countHeading="Investors" rows={rows} />
          <FlatTiles>
            <div className="mt-5 grid gap-x-6 gap-y-5 border-t border-line pt-5 @md:grid-cols-2">
              <CommittedTile committed={summary.committed} />
              <NextStepTile summary={summary} />
            </div>
          </FlatTiles>
        </>
      )}
      {summary.unsorted > 0 && (
        <div className="mt-2 text-xs leading-relaxed text-ink-2">
          <Note caution>
            {`${countOf(summary.unsorted, "investor", "investors")} ${agree(summary.unsorted, "is", "are")} in a stage the OS does not know and ${agree(summary.unsorted, "is", "are")} left out.`}
          </Note>
        </div>
      )}
    </DashboardSection>
  );
}
