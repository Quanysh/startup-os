"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { periodStart } from "@convex/lib/periods";
import { Count, Counts } from "@/components/dashboard/section";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { formatPeriod } from "@/lib/format";
import { manyCompanies } from "@/lib/company";

/** The start of the week in progress (Monday, UTC), as a moment: what "this week" counts from. */
export const weekStartOf = (now: number) => Date.parse(`${periodStart("week", now)}T00:00:00Z`);

/**
 * "This week": what the agents did since Monday, counted by the server from
 * a moment this page names (a query reads no clock). Agent activity alone:
 * what the owner approved and rejected is each proposer's week on Agents ›
 * Bots (`bots.weeklyStats`), and ARR per person is on Finance (`ArrPerPersonTile`).
 */
export function ThisWeek() {
  const now = useNow();
  const measure = useQuery(api.assistant.measure, now === null ? "skip" : { since: weekStartOf(now) });

  return (
    <Panel aria-labelledby="this-week">
      <h2 id="this-week" className="text-base">
        This week
      </h2>
      {measure === undefined || now === null ? (
        <Skeleton data-testid="week-loading" className="mt-4 h-16 rounded-inner" />
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-3">
            Since {formatPeriod("day", periodStart("week", now))}
            {manyCompanies() ? ", both companies." : "."}
          </p>
          <Counts className="mt-4 grid-cols-2 sm:grid-cols-3">
            <Count label="Briefs written" value={measure.briefs} />
            <Count label="Proposals made" value={measure.proposed} />
            <Count label="Tasks made by agents" value={measure.tasks} />
          </Counts>
          <p className="mt-3 text-xs text-ink-3">
            What you approved and rejected, each proposer&apos;s week:{" "}
            <Link href="/agents?view=bots" className="text-brand underline-offset-2 hover:underline">
              Agents › Bots
            </Link>
            .
          </p>
        </>
      )}

    </Panel>
  );
}
