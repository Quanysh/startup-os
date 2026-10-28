"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { isLinearUrl } from "@convex/lib/mirrorRules";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { SetupLink, useFreshness } from "@/components/work/personal-source";
import { useNow } from "@/hooks/use-now";
import { ageLabel } from "@/lib/freshness";
import { LINEAR_COLUMNS, boardOf, type LinearCard } from "@/lib/work/linear";

/** The columns still to do, most pressing first. Finished issues are left to the board. */
const OPEN = ["started", "unstarted", "backlog"] as const;
const SHOWN = 12;

function Row({ issue }: { issue: LinearCard }) {
  const body = (
    <>
      <span className="shrink-0 font-num text-xs text-ink-3">{issue.identifier}</span>
      <span className="min-w-0 flex-1 break-words text-sm text-ink">{issue.title}</span>
      {issue.dueDate !== undefined && (
        <span className="shrink-0 text-xs text-ink-3">Due {issue.dueDate}</span>
      )}
    </>
  );
  const rowClass = "-mx-2 flex items-baseline gap-3 rounded-inner px-2 py-1.5";
  // The one link a record may carry, and only when it is Linear's own.
  if (!isLinearUrl(issue.url)) return <span className={rowClass}>{body}</span>;
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer noopener"
      className={`${rowClass} outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50`}
    >
      {body}
    </a>
  );
}

/** The viewer's own Linear issues that are not finished, in progress first. */
export function MyIssuesPanel() {
  const data = useQuery(api.workTools.myIssues);
  const now = useNow();
  const freshness = useFreshness();

  const board = data === undefined ? null : boardOf(data.issues, null);
  const open = board === null ? 0 : OPEN.reduce((sum, id) => sum + board[id].length, 0);

  return (
    <Panel aria-labelledby="my-issues">
      <h3 id="my-issues" className="text-sm font-medium text-ink">
        Your Linear issues
      </h3>
      {data === undefined || board === null ? (
        <Skeleton data-testid="my-issues-loading" className="mt-4 h-32 rounded-inner" />
      ) : data.source.lastOkAt === null ? (
        <p className="mt-3 text-sm text-ink-2">
          Linear has not been read yet. <SetupLink />
        </p>
      ) : (
        <>
          {open === 0 ? (
            <p className="mt-3 text-sm text-ink">No open Linear issue is assigned to you.</p>
          ) : (
            <div className="mt-3 space-y-4">
              {OPEN.map((id) => {
                const issues = board[id];
                if (issues.length === 0) return null;
                const title = LINEAR_COLUMNS.find((column) => column.id === id)!.title;
                return (
                  <section key={id} aria-labelledby={`my-issues-${id}`}>
                    <h4 id={`my-issues-${id}`} className="text-xs font-medium text-ink-2">
                      {title} ({issues.length})
                    </h4>
                    <ul className="mt-1">
                      {issues.slice(0, SHOWN).map((issue) => (
                        <li key={issue.issueId}>
                          <Row issue={issue} />
                        </li>
                      ))}
                    </ul>
                    {issues.length > SHOWN && (
                      <p className="mt-1 text-xs text-ink-3">
                        and {issues.length - SHOWN} more in Linear.
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          {data.source.state !== "ok" && (
            <p className="mt-4 text-xs text-ink-2">
              The last read failed, so this list may be out of date.
            </p>
          )}
          <p className="mt-4 text-xs text-ink-3">
            {freshness(now === null ? null : ageLabel(now, data.source.lastOkAt))} Titles only;
            open an issue in Linear to change it.
          </p>
        </>
      )}
    </Panel>
  );
}
