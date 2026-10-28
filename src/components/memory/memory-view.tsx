"use client";

import { useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { DEFAULT_COMPANY } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { MEMORY_TABS, readView, writeView, type MemoryTab, type View } from "@/lib/memory/view";
import { lastChange } from "@/lib/source-freshness";
import { cn } from "@/lib/utils";
import { DecisionsPanel } from "./decisions-panel";
import { MeetingsPanel } from "./meetings-panel";
import { NotesPanel } from "./notes-panel";

const TAB_LABELS: Record<MemoryTab, string> = { decisions: "Decisions", meetings: "Meetings", notes: "Notes" };

/**
 * /memory: what the company decided and what its meetings said. Two tabs; the
 * tab and the filters live in the address. `?decision=<id>` opens that
 * decision (a notification and a Today row lead there); `?meeting=<id>`
 * opens a meeting's notes and `?import=<id>` starts notes from one of the
 * owner's Fireflies meetings (Today's Recent meetings lead there). Every row is the
 * server's to send: only the viewer's companies', and only with Memory.
 */
export function MemoryView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const now = useNow();
  const company = useCompany();
  const { companies } = useViewer();
  const view = readView(new URLSearchParams(params.toString()));
  const linked = params.get("decision");
  const [opened, setOpened] = useState<string | null>(linked);
  // `?meeting=<id>` opens one meeting's notes, and `?import=<Fireflies id>`
  // starts new notes from one of the owner's Fireflies meetings: Today's
  // Recent meetings lead to both.
  const [meeting, setMeeting] = useState<Id<"meetingNotes"> | null>(
    (params.get("meeting") as Id<"meetingNotes"> | null) ?? null,
  );
  const importId = params.get("import");
  const inView = company ?? undefined;
  const decisions = useQuery(api.decisions.list, { company: inView });
  const meetings = useQuery(api.meetingNotes.list, { company: inView });
  const notes = useQuery(api.notes.list, { company: inView });
  const companiesInView = company === null ? companies : [company];

  const setView = (next: View) => {
    const query = writeView(next);
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Memory"
        purpose="What the company decided and why, who owns each decision and when to look at it again, the notes of the meetings where it happened, and notes that are not a meeting's."
        aside={
          // Typed in here: when a decision or a meeting's notes the viewer reads last changed.
          <TypedFreshness
            label="Decisions, meeting notes and notes"
            at={
              decisions === undefined || meetings === undefined || notes === undefined
                ? undefined
                : lastChange([...decisions, ...meetings, ...notes].map((row) => ({ changedAt: row.updatedAt })))
            }
          />
        }
      />
      <div role="tablist" aria-label="Memory" className="inline-flex gap-1 rounded-full bg-panel p-1 shadow-soft-sm">
        {MEMORY_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view.tab === tab}
            onClick={() => setView({ ...view, tab })}
            className={cn(
              "h-9 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              view.tab === tab ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:text-ink",
            )}
          >
            {TAB_LABELS[tab]}
            {tab === "meetings" && meetings !== undefined ? ` (${meetings.length})` : ""}
            {tab === "decisions" && decisions !== undefined ? ` (${decisions.length})` : ""}
            {tab === "notes" && notes !== undefined ? ` (${notes.length})` : ""}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TAB_LABELS[view.tab]}>
        {decisions === undefined || meetings === undefined || notes === undefined || now === null ? (
          <Skeleton data-testid="memory-loading" className="h-48 w-full rounded-card" />
        ) : view.tab === "notes" ? (
          <NotesPanel rows={notes} company={company ?? companies[0] ?? DEFAULT_COMPANY} q={view.q} />
        ) : view.tab === "decisions" ? (
          <DecisionsPanel
            rows={decisions}
            view={view}
            setView={setView}
            today={localIsoDate(now)}
            now={now}
            company={company ?? companies[0] ?? DEFAULT_COMPANY}
            companies={companiesInView}
            meetings={meetings}
            opened={opened}
            setOpened={setOpened}
          />
        ) : (
          <MeetingsPanel
            rows={meetings}
            now={now}
            today={localIsoDate(now)}
            company={company ?? companies[0] ?? DEFAULT_COMPANY}
            companies={companiesInView}
            opened={meeting}
            setOpened={setMeeting}
            importId={importId}
          />
        )}
      </div>
    </div>
  );
}
