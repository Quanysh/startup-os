"use client";

import { useQuery } from "convex/react";
import { ArrowRightIcon, CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { PanelHeading } from "@/components/dashboard/section";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { taskColumnTitle } from "@/lib/task-columns";

const SHOWN = 5;

/** Open issues from the board: the problems waiting to be solved. */
export function IssuesPanel() {
  const issues = useQuery(api.tasks.openIssues);

  return (
    <Panel aria-labelledby="issues">
      <PanelHeading id="issues" className="flex items-baseline justify-between text-base">
        Open problems
        <Link
          href="/board"
          className="inline-flex items-center gap-1 rounded-full text-xs font-normal text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Board
          <ArrowRightIcon aria-hidden className="size-3" />
        </Link>
      </PanelHeading>

      {issues === undefined ? (
        <Skeleton className="mt-4 h-20 rounded-inner" />
      ) : issues.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-2">
          <CircleCheckIcon aria-hidden className="size-4 text-good" />
          No open problems. Add one on the board when something is stuck.
        </p>
      ) : (
        <>
          <ul className="mt-2 divide-y divide-line">
            {issues.slice(0, SHOWN).map((issue) => (
              <li key={issue.id} className="flex items-center gap-3 py-2.5">
                <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-watch" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{issue.title}</span>
                <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-2">
                  {taskColumnTitle(issue.column)}
                </span>
              </li>
            ))}
          </ul>
          {issues.length > SHOWN && (
            <p className="mt-2 text-xs text-ink-2">And {issues.length - SHOWN} more on the board.</p>
          )}
        </>
      )}
    </Panel>
  );
}
