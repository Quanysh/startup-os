"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { quarterOf } from "@convex/lib/quarter";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { GoalsPanel } from "@/components/goals-panel";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { TargetsEditor } from "@/components/targets-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { lastChange } from "@/lib/source-freshness";

/**
 * Goals and targets (/goals, under Operate): the quarter's goals and the
 * target for each scorecard number, for the company in view. Goals are read
 * with the scorecard or the board and changed with `review`; targets are
 * read with the scorecard or `settings` and changed with `settings`. The page
 * opens with any of the three (`PAGE_ALSO`), and mounts only the parts the
 * viewer is sent; each refuses for itself inside Convex as well. Today keeps
 * a read-only summary of the goals that leads here.
 */
export default function GoalsPage() {
  const now = useNow();
  const company = useCompany();
  const { can } = useViewer();
  const readsGoals = can("scorecard") || can("board");
  const readsTargets = can("scorecard") || can("settings");
  const quarter = now === null ? null : quarterOf(now);
  // The panel's own subscription (the same arguments): typed in here, so the
  // header says when a goal in view last changed. Targets keep no time.
  const goals = useQuery(
    api.goals.list,
    quarter === null || !readsGoals ? "skip" : company === null ? { quarter } : { quarter, company },
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Goals and targets"
        purpose="What the company means to do this quarter, and the number each scorecard figure is held to."
        aside={
          <TypedFreshness
            label="This quarter's goals"
            at={goals === undefined ? undefined : lastChange(goals)}
          />
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {readsGoals &&
          (quarter === null ? <Skeleton className="h-40 rounded-card" /> : <GoalsPanel quarter={quarter} />)}
        {readsTargets && (
        <Panel aria-labelledby="targets">
          <h2 id="targets" className="text-base">
            Targets
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            What you have committed to for each scorecard number. A tile reads on or off target
            against it. Benchmarks are separate: they show what the market does.
          </p>
          <div className="mt-2">
            <TargetsEditor />
          </div>
        </Panel>
        )}
      </div>
    </div>
  );
}
