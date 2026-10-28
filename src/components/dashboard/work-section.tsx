"use client";

import { useQuery } from "convex/react";
import { ArrowRightIcon, ClockAlertIcon } from "lucide-react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { quarterOf } from "@convex/lib/quarter";
import { useCompany } from "@/components/company-provider";
import { GoalsPanel } from "@/components/goals-panel";
import { Masonry } from "@/components/masonry";
import { IssuesPanel } from "@/components/issues-panel";
import { Panel } from "@/components/panel";
import { visibleTasks } from "@/components/tasks/assignee";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { taskSummary } from "@/lib/dashboard/tasks";
import { localIsoDate } from "@/lib/dates";
import { Count, Counts, DashboardSection, SectionSkeleton, PanelHeading } from "./section";

/**
 * What the team is working on: this quarter's goals, the open issues and the
 * board in three counts (the viewer's own tasks are on Today, not here). Each part reads its own source, and each is there
 * only for a viewer the server would answer. A person's own day (mail,
 * calendar, their issues) is on Today, not here.
 */
export function WorkSection() {
  const { can } = useViewer();
  const now = useNow();
  // Goals and issues are sent to a viewer with the scorecard or the board.
  const routine = can("scorecard") || can("board");
  const board = can("board");
  if (!routine && !board) return null;

  return (
    <DashboardSection title="Work" href="/board" framed={false}>
      {/* Up to three across; each under the shortest, all ending flush. */}
      <Masonry minColumnWidth={320} maxColumns={3} gap={16}>
        {/* Read-only here for everyone: goals are changed on Goals and targets (/goals). */}
        {routine && now !== null && <GoalsPanel quarter={quarterOf(now)} summary />}
        {routine && <IssuesPanel />}
        {board && <TasksPanel />}
      </Masonry>
    </DashboardSection>
  );
}

/** The task board, counted for the company: nobody's own. The tasks themselves are on /board. */
function TasksPanel() {
  const board = useQuery(api.tasks.board);
  const now = useNow();
  const viewer = useViewer();
  const inView = useCompany();
  // As the board does: the company in view's tasks and the shared ones; a
  // stored choice the viewer is not on narrows nothing.
  const company = inView !== null && viewer.companies.includes(inView) ? inView : null;

  const summary =
    board === undefined || now === null
      ? null
      : taskSummary(visibleTasks(board, { company, filter: "everyone", email: viewer.email }), {
          email: viewer.email,
          today: localIsoDate(now),
        });

  return (
    <Panel aria-labelledby="dashboard-tasks">
      <PanelHeading id="dashboard-tasks" className="text-base">
        <Link
          href="/board"
          className="group inline-flex items-center gap-1.5 rounded-sm outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Tasks
          <ArrowRightIcon
            aria-hidden
            className="size-3.5 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
          />
        </Link>
      </PanelHeading>
      <div className="mt-4">
        {summary === null ? (
          <SectionSkeleton className="h-14" />
        ) : (
          <Counts className="grid-cols-3">
            <Count label="Open" value={summary.open} />
            <Count label="Doing" value={summary.doing} />
            <Count
              label="Overdue"
              value={summary.overdue}
              // The mark is for something late; none late needs no mark.
              icon={summary.overdue > 0 ? ClockAlertIcon : undefined}
              tone="text-weak"
            />
          </Counts>
        )}
      </div>
    </Panel>
  );
}
