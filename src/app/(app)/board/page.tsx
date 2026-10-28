"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useMemo, useRef, useState } from "react";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { TaskBoard } from "@/components/tasks/task-board";
import { LinearBoard } from "@/components/work/linear-board";
import { useViewer } from "@/hooks/use-viewer";
import { parseView, serializeView, type TaskView } from "@/lib/tasks/view";
import { cn } from "@/lib/utils";
import { AnimatedGrid } from "@/components/ui/animated-grid";

// The team's own tasks first; the Linear mirror beside them, read-only.
const TABS = [
  { id: "tasks", label: "Tasks" },
  { id: "linear", label: "Linear issues" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// Reading the address suspends while the page is prerendered, so the part
// that reads it sits under a boundary of its own.
export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <Boards />
    </Suspense>
  );
}

function Boards() {
  const [picked, setTab] = useState<TabId>("tasks");
  // `/board?task=<id>`: a link to one card, which is how a notification opens
  // its task. The card is one of the team's own, so its tab is shown; once
  // the board is done with the link the address goes back to plain /board.
  const params = useSearchParams();
  const linked = params.get("task");
  const router = useRouter();
  // The task board's view (search, filters, sort, layout) is the address, so
  // a view can be shared and the back button undoes a change. Read once per
  // address, so the board is handed the same view until it changes.
  const { isOwner } = useViewer();
  const query = params.toString();
  const view = useMemo(() => parseView(new URLSearchParams(query), { isOwner }), [query, isOwner]);
  const at = (link: string | null, next: TaskView) => {
    const search = new URLSearchParams(serializeView(next, { isOwner }));
    const both = link === null ? search.toString() : `task=${encodeURIComponent(link)}${search.size > 0 ? `&${search}` : ""}`;
    return both === "" ? "/board" : `/board?${both}`;
  };
  const tab: TabId = linked !== null ? "tasks" : picked;
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next: TabId = tab === "linear" ? "tasks" : "linear";
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="space-y-6">
      <header className="relative isolate space-y-4">
        <AnimatedGrid className="-inset-x-4 sm:-inset-x-8 -inset-y-10 -z-10" />
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <h1 className="text-2xl sm:text-3xl">Board</h1>
          {/* The tasks are the OS's own and live; Linear's tab is a mirror. */}
          {tab === "linear" && <PageFreshness page="board_linear" />}
        </div>
        <div
          role="tablist"
          aria-label="Boards"
          onKeyDown={onKeyDown}
          className="inline-flex gap-1 rounded-full bg-surface p-1"
        >
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${id}`}
              aria-selected={tab === id}
              // Only the selected tab's panel is on the page to point at.
              aria-controls={tab === id ? `${baseId}-panel-${id}` : undefined}
              // One stop in the tab order; arrow keys move between the two.
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              className={cn(
                "h-8 rounded-full px-4 text-sm font-medium text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
                tab === id && "bg-panel text-ink shadow-soft-sm",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`}>
        {tab === "linear" ? (
          <LinearBoard />
        ) : (
          <TaskBoard
            linked={linked}
            onLinkDone={() => {
              setTab("tasks");
              router.replace(at(null, view));
            }}
            view={view}
            onView={(next) => router.replace(at(linked, next), { scroll: false })}
          />
        )}
      </div>
    </div>
  );
}
