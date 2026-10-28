"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { periodStart } from "@convex/lib/periods";
import { useCompany } from "@/components/company-provider";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { ARR_WORDS, arrPerPerson } from "@/lib/assistant/arr";
import { COMPANIES, DEFAULT_COMPANY, type CompanyId } from "@/lib/company";
import { formatPeriod, formatUsd } from "@/lib/format";
import { ARR_PER_EMPLOYEE_LINES } from "@/lib/metrics/benchmarks";

/**
 * ARR per person in the OS, on Finance (it was on the Assistant's "This
 * week"). The owner's alone, as it was: the head count is the people a task
 * can be given to, read through `assistant.measure` (an `ownerQuery`), so the
 * Finance page mounts this only for the owner and no teammate asks for it.
 *
 * The ratio wears no colour and gets no verdict: the published figures are
 * from much larger companies, were read on one secondary page, and are
 * marked as not verified. With no MRR on record it says so, never a zero.
 */
export function ArrPerPersonTile({ company: given }: { company?: CompanyId } = {}) {
  // Finance names the company (it does not follow the sidebar's switch); elsewhere the switch's.
  const inView = useCompany();
  const company = given ?? inView ?? DEFAULT_COMPANY;
  const now = useNow();
  // The same week the Assistant asks for, so the two share one subscription.
  const since = now === null ? null : Date.parse(`${periodStart("week", now)}T00:00:00Z`);
  const measure = useQuery(api.assistant.measure, since === null ? "skip" : { since });
  const card = useQuery(api.metrics.scorecard);

  const arr =
    measure === undefined || card === undefined
      ? null
      : arrPerPerson({ company, tiles: card.tiles, people: measure.people.us });

  return (
    <Panel aria-labelledby="arr-per-person" data-testid="arr-tile">
      <h2 id="arr-per-person" className="text-base">
        ARR per person in the OS
      </h2>
      {arr === null ? (
        <Skeleton className="mt-3 h-10 rounded-inner" />
      ) : arr.state !== "known" ? (
        <p className="mt-2 text-sm text-ink-2" data-testid="arr-unknown">
          {ARR_WORDS[arr.state]}
        </p>
      ) : (
        <>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink" data-testid="arr-value">
            {formatUsd(arr.value)}
          </p>
          <p className="mt-1 max-w-2xl text-xs text-ink-2">
            {COMPANIES.us.name}&apos;s MRR for {formatPeriod("month", arr.periodStart)} × 12 ({formatUsd(arr.arr)}),
            divided by {arr.people} {arr.people === 1 ? "person" : "people"} in the OS on {COMPANIES.us.name}:
            you and the teammates you added. It is not a payroll head count.
          </p>
        </>
      )}
      {arr !== null && arr.state !== "other_company" && (
        <>
          <ul className="mt-4 space-y-1.5 text-sm" data-testid="arr-lines">
            {ARR_PER_EMPLOYEE_LINES.map((line) => (
              <li key={line.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-num w-20 shrink-0 text-ink">{formatUsd(line.value)}</span>
                <span className="text-ink-2">
                  {line.label}. {line.attributed}.
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-2xl text-xs text-ink-3">
            {ARR_WORDS.marks} Each figure is as{" "}
            <a
              href={ARR_PER_EMPLOYEE_LINES[0]!.source.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {ARR_PER_EMPLOYEE_LINES[0]!.source.name}
            </a>{" "}
            ({ARR_PER_EMPLOYEE_LINES[0]!.source.year}) gives it, attributed as shown; none was read
            at its source. They describe companies far larger than this one, so no verdict is drawn.
          </p>
        </>
      )}
    </Panel>
  );
}
