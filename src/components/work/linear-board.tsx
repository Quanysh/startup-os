"use client";

import { useQuery } from "convex/react";
import { CalendarIcon, CalendarX2Icon } from "lucide-react";
import { useCompany } from "@/components/company-provider";
import { GatedLink } from "@/components/gated-link";
import { useId, useMemo, useState } from "react";
import { api } from "@convex/_generated/api";
import { linearTeamServes } from "@convex/lib/company";
import { isLinearUrl } from "@convex/lib/mirrorRules";
import { Board } from "@/components/board/board";
import { fieldClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { localIsoDate } from "@/lib/dates";
import { formatPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  LINEAR_COLUMNS,
  PRIORITY_LABEL,
  boardOf,
  teamsOf,
  type LinearCard,
} from "@/lib/work/linear";

const chip =
  "inline-flex max-w-full items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-2";

function IssueCard({ issue, today }: { issue: LinearCard; today: string | null }) {
  const done = issue.stateType === "completed";
  const overdue =
    issue.dueDate !== undefined && today !== null && issue.dueDate < today && !done;
  const priority = PRIORITY_LABEL[issue.priority];
  const name = (
    <>
      <span className="font-num text-xs text-ink-3">{issue.identifier}</span>
      {" "}
      {issue.title}
    </>
  );
  const nameClass = cn(
    "block w-full break-words rounded text-left text-sm text-ink",
    done && "text-ink-2 line-through decoration-ink-3",
  );
  return (
    <>
      {/* The address was checked when it was stored; it is checked again
          here, because here is where it becomes a link. */}
      {isLinearUrl(issue.url) ? (
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(nameClass, "outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50")}
        >
          {name}
        </a>
      ) : (
        <span className={nameClass}>{name}</span>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {issue.teamKey !== "" && (
          <span className={chip} title={issue.teamName}>
            {issue.teamKey}
          </span>
        )}
        <span className={chip}>
          <span className="truncate">{issue.assigneeName || "Unassigned"}</span>
        </span>
        {priority && <span className={chip}>{priority}</span>}
        {issue.dueDate !== undefined && (
          <span className={cn(chip, overdue && "font-medium text-ink")}>
            {overdue ? (
              <CalendarX2Icon aria-hidden className="size-3 text-weak" />
            ) : (
              <CalendarIcon aria-hidden className="size-3" />
            )}
            {overdue && "Overdue · "}
            {formatPeriod("day", issue.dueDate)}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * Linear's issues on the shared board, read-only: no card can be picked up,
 * and each opens in Linear, which is where it is moved.
 */
export function LinearBoard() {
  const data = useQuery(api.workTools.issues);
  const now = useNow();
  const teamId = useId();
  const [team, setTeam] = useState("");

  // With a company in view, its own teams' issues and no others: the switch
  // already says which company, so the board does not ask again.
  const company = useCompany();
  const issues = useMemo(
    () =>
      company === null
        ? data?.issues
        : data?.issues.filter((issue) => linearTeamServes([company], issue.teamName)),
    [company, data],
  );
  const teams = useMemo(() => teamsOf(issues ?? []), [issues]);
  // A team that has left the board falls back to all of them.
  const chosen = teams.some((t) => t.key === team) ? team : null;
  const board = useMemo(() => boardOf(issues ?? [], chosen), [issues, chosen]);
  const today = now === null ? null : localIsoDate(now);

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-ink-2">
        Linear&apos;s issues, read once a day. Cards open in Linear; to move one, move it
        there.
      </p>
      {data === undefined ? (
        <div className="grid gap-4 lg:grid-cols-4" aria-busy data-testid="linear-loading">
          {LINEAR_COLUMNS.map((c) => (
            <Skeleton key={c.id} className="h-64 rounded-card" />
          ))}
        </div>
      ) : data.source.lastOkAt === null ? (
        <p className="text-sm text-ink-2">
          Linear has not been read yet.{" "}
          {/* The work-tool settings are the owner's. */}
          <GatedLink
            href="/settings/connections"
            className="font-medium text-ink underline underline-offset-2"
            otherwise="The owner sets it up."
          >
            Set it up
          </GatedLink>
        </p>
      ) : (
        <>
          {/* One team, as in a company's view, leaves nothing to choose. */}
          <div className={cn("flex items-center gap-2", teams.length < 2 && "hidden")}>
            <label htmlFor={teamId} className="text-sm text-ink-2">
              Team
            </label>
            <select
              id={teamId}
              value={chosen ?? ""}
              onChange={(e) => setTeam(e.target.value)}
              className={cn(fieldClass, "h-9 w-auto min-w-40")}
            >
              <option value="">All teams</option>
              {teams.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name || t.key}
                </option>
              ))}
            </select>
          </div>
          <Board<LinearCard>
            columns={LINEAR_COLUMNS}
            items={board}
            getLabel={(issue) => `${issue.identifier} ${issue.title}`}
            renderCard={(issue) => <IssueCard issue={issue} today={today} />}
            // Read-only: Linear is where an issue is moved.
            canDrag={() => false}
            onMove={() => {}}
          />
          {/* When it was read is the Board's header's, on this tab, once. */}
          {data.source.state !== "ok" && (
            <p className="text-xs text-ink-2">
              The last read failed, so this board may be out of date.
            </p>
          )}
        </>
      )}
    </div>
  );
}
