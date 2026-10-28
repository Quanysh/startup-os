import { useId } from "react";
import { Note } from "@/components/finance/notes";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { QuietTile } from "@/components/pipeline/quiet-tile";
import { agree, countOf } from "@/components/pipeline/words";
import { formatExact, formatValue } from "@/lib/format";
import {
  INVESTOR_STALE_DAYS,
  investorSummary,
  type InvestorSummary,
  type PipelineBoard,
} from "@/lib/pipeline/derive";

/**
 * The four numbers above the investor board: who is in conversation, what is
 * committed, who has gone quiet and who has nothing planned. Fundraising
 * funnel counts have no published benchmark, so none is shown.
 */
export function FundraisingTiles({ board, now }: { board: PipelineBoard; now: number }) {
  const headingId = useId();
  const summary = investorSummary(board, now);
  return (
    <section aria-labelledby={headingId}>
      {/* Not shown, but each tile's h3 needs a heading above it. */}
      <h2 id={headingId} className="sr-only">
        Summary
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ActiveTile summary={summary} />
        <CommittedTile committed={summary.committed} />
        <QuietTile
          quiet={summary.quiet}
          limitDays={INVESTOR_STALE_DAYS}
          one="investor in conversation"
          many="investors in conversation"
          nobody="Nobody is in conversation."
        />
        <NextStepTile summary={summary} />
      </div>
    </section>
  );
}

function ActiveTile({ summary }: { summary: InvestorSummary }) {
  const { active, targets, unsorted } = summary;
  return (
    <DerivedTile label="In conversation" value={active === 0 ? "None" : formatValue(active, "count")}>
      <Note>Contacted, meeting or diligence.</Note>
      {targets > 0 && <Note>{`${targets} more still to contact.`}</Note>}
      {unsorted > 0 && (
        <Note caution>
          {`${countOf(unsorted, "investor", "investors")} ${agree(unsorted, "is", "are")} in a stage the OS does not know and ${agree(unsorted, "is", "are")} left out.`}
        </Note>
      )}
    </DerivedTile>
  );
}

export function CommittedTile({ committed }: { committed: InvestorSummary["committed"] }) {
  const label = "Committed";
  const { count, value, withoutAmount } = committed;
  if (count === 0) {
    return (
      <DerivedTile label={label} value="Nothing yet">
        <Note>No investor is in Committed.</Note>
      </DerivedTile>
    );
  }
  if (value === null) {
    return (
      <DerivedTile label={label} value={null}>
        <Note>
          {count === 1
            ? "The one commitment has no amount yet."
            : `None of the ${count} commitments has an amount yet.`}
        </Note>
      </DerivedTile>
    );
  }
  return (
    <DerivedTile
      label={label}
      value={formatValue(value, "currency", "USD")}
      exact={formatExact(value, "currency", "USD")}
      badge={withoutAmount > 0 ? "partial" : undefined}
    >
      <Note>
        {withoutAmount > 0
          ? `Across ${count - withoutAmount} of ${count} commitments.`
          : `Across ${countOf(count, "commitment", "commitments")}.`}
      </Note>
      {withoutAmount > 0 && (
        <Note caution>
          {`${countOf(withoutAmount, "commitment", "commitments")} ${agree(withoutAmount, "has", "have")} no amount and ${agree(withoutAmount, "is", "are")} left out.`}
        </Note>
      )}
    </DerivedTile>
  );
}

export function NextStepTile({ summary }: { summary: InvestorSummary }) {
  const label = "No next step";
  const idle = summary.noNextStep.length;
  if (summary.active === 0) {
    return (
      <DerivedTile label={label} value="None">
        <Note>Nobody is in conversation.</Note>
      </DerivedTile>
    );
  }
  if (idle === 0) {
    return (
      <DerivedTile label={label} value="None">
        <Note>Every investor in conversation has a next step.</Note>
      </DerivedTile>
    );
  }
  return (
    <DerivedTile label={label} value={formatValue(idle, "count")}>
      <Note>In conversation with nothing planned.</Note>
    </DerivedTile>
  );
}
