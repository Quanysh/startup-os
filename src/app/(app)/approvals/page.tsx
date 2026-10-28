"use client";

import { Suspense } from "react";
import { AutonomyOffers } from "@/components/approvals/autonomy";
import { DecidedList } from "@/components/approvals/decided";
import { useView } from "@/components/approvals/filters";
import { ApprovalsInbox, inboxIntro, useWaitingCount } from "@/components/approvals/inbox";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { TABS, type Tab } from "@/lib/approvals/inbox";
import { cn } from "@/lib/utils";

const TAB_LABELS: Record<Tab, string> = { waiting: "Waiting", decided: "Decided" };

/** The two tabs, in the address (`?tab=decided`), keeping the filters. */
function Tabs() {
  const [view, setView] = useView();
  const waiting = useWaitingCount();
  return (
    <>
      <div role="tablist" aria-label="Approvals" className="inline-flex gap-1 rounded-full bg-panel p-1 shadow-soft-sm">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view.tab === tab}
            onClick={() => setView({ ...view, tab, decision: null })}
            className={cn(
              "h-9 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              view.tab === tab ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:text-ink",
            )}
          >
            {TAB_LABELS[tab]}
            {tab === "waiting" && waiting !== undefined ? ` (${waiting})` : ""}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TAB_LABELS[view.tab]}>
        {view.tab === "decided" ? <DecidedList /> : <ApprovalsInbox />}
      </div>
    </>
  );
}

/**
 * The approvals inbox (/approvals, under Operate after Today): the one place
 * proposals and tool calls are decided. "Waiting": every proposal and draft
 * an agent or bot made, and every tool call a Startup OS run paused on, both
 * companies. "Decided": what became of the last 30 days' (approved
 * automatically included, each with its flag). The owner's alone (the
 * `personal` area in src/lib/nav.ts; `assistant.inbox` and `assistant.decided`
 * are `ownerQuery`s, and deciding goes through `assistant.approve` /
 * `dismiss` and `agentRuntime.decide`).
 */
export default function ApprovalsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" purpose={inboxIntro()} />
      <AutonomyOffers />
      {/* The tab and the filters are read from the address. */}
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <Tabs />
      </Suspense>
    </div>
  );
}
