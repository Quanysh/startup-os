"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { MyIssuesPanel } from "@/components/work/my-issues-panel";
import { NeedsReplyPanel } from "@/components/work/needs-reply-panel";
import { SetupLink } from "@/components/work/personal-source";
import { RecentMeetingsPanel } from "@/components/work/recent-meetings-panel";
import { EventRow, WeekAheadPanel } from "@/components/work/week-ahead-panel";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { DAY_ANCHOR } from "@/lib/today/opening";
import { eventsOn, localDayStart } from "@/lib/work/days";
import { cn } from "@/lib/utils";
import { useEvents } from "./use-day";
import { Masonry } from "@/components/masonry";

/**
 * Today's meetings in time order: what is behind the viewer is quieter, and
 * a line marks where the day is now. The rest of the week is one press away.
 * The same read, with the same arguments, as the week below and the opening
 * line's "your first meeting".
 */
function DayTimeline() {
  const data = useEvents();
  const now = useNow();
  return (
    <Panel aria-labelledby="day-timeline" className="min-w-0">
      <h3 id="day-timeline" className="text-sm font-medium text-ink">
        Meetings today
      </h3>
      {data === undefined || data === null || now === null ? (
        <Skeleton data-testid="timeline-loading" className="mt-4 h-32 rounded-inner" />
      ) : data.source.lastOkAt === null ? (
        <p className="mt-3 text-sm text-ink-2">
          Google Calendar has not been read yet. <SetupLink />
        </p>
      ) : (
        (() => {
          const events = eventsOn(data.events, localDayStart(now));
          if (events.length === 0) return <p className="mt-3 text-sm text-ink-2">No meetings today.</p>;
          // Where "now" falls among them: before the first that has not ended.
          const nowAt = events.findIndex((event) => !event.allDay && event.endsAt > now);
          return (
            <ol className="mt-3">
              {events.map((event, i) => (
                <li
                  key={event.eventId}
                  className={cn(!event.allDay && event.endsAt <= now && "opacity-60")}
                  data-past={!event.allDay && event.endsAt <= now ? "" : undefined}
                >
                  {i === nowAt && (
                    <div aria-hidden className="my-1 flex items-center gap-2 text-[11px] font-medium text-brand">
                      <span className="size-1.5 rounded-full bg-brand" />
                      <span className="h-px flex-1 bg-brand/40" />
                    </div>
                  )}
                  <ul>
                    <EventRow event={event} />
                  </ul>
                </li>
              ))}
            </ol>
          );
        })()
      )}
    </Panel>
  );
}

/** A quiet disclosure for what is reading rather than acting. */
function More({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden rounded-sm px-1 text-sm font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="group-open:hidden">Show {label}</span>
        <span className="hidden group-open:inline">Hide {label}</span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/**
 * The viewer's own day: today's meetings with the mail waiting on a reply
 * beside them, their own issues, then (one press away) the rest of the week
 * and recent meeting notes. Mounted only for a viewer who holds `today`: each
 * of these reads is that area's and is scoped to the caller. A teammate who
 * has not connected their Claude is shown, briefly, how.
 */
export function YourDay() {
  const { isOwner, can } = useViewer();
  // A teammate's own connection. The owner's tools are not set up this way.
  const connection = useQuery(api.connect.status, isOwner || !can("today") ? "skip" : {});
  if (!can("today")) return null;
  const waiting = !isOwner && connection === undefined;
  const nothingYet =
    !isOwner &&
    connection !== undefined &&
    !connection.owner &&
    connection.token === null &&
    connection.tools.every((tool) => tool.lastOkAt === null && tool.held === 0);

  return (
    <section id={DAY_ANCHOR} aria-labelledby="your-day-heading" className="scroll-mt-6 space-y-3">
      <h2 id="your-day-heading" className="text-base">
        Your day
      </h2>
      {waiting ? (
        <Skeleton data-testid="your-day-loading" className="h-40 rounded-card" />
      ) : nothingYet ? (
        <p className="rounded-card bg-panel px-5 py-4 text-sm text-ink-2 shadow-soft">
          Your mail, calendar, issues and meeting notes show here once your own Claude sends them; only you see
          them.{" "}
          <Link href="/settings/connections" className="font-medium text-brand underline-offset-2 hover:underline">
            Connect your Claude
          </Link>
        </p>
      ) : (
        <div className="space-y-4">
          {/* Meetings, mail and issues packed in two columns where they fit,
              ending flush: a short day beside a long inbox leaves no hole. */}
          <Masonry minColumnWidth={380} maxColumns={2} gap={16}>
            <DayTimeline />
            <NeedsReplyPanel />
            <MyIssuesPanel />
          </Masonry>
          <div className="space-y-3">
            <More label="the rest of the week">
              <WeekAheadPanel laterOnly />
            </More>
            <More label="recent meetings">
              <RecentMeetingsPanel />
            </More>
          </div>
        </div>
      )}
    </section>
  );
}

/** For a teammate whose Claude is connected: the way back to its page, in the header. */
export function ConnectLink() {
  const { isOwner, can } = useViewer();
  const connection = useQuery(api.connect.status, isOwner || !can("today") ? "skip" : {});
  if (isOwner || !can("today")) return null;
  const nothingYet =
    connection === undefined ||
    (!connection.owner &&
      connection.token === null &&
      connection.tools.every((tool) => tool.lastOkAt === null && tool.held === 0));
  if (nothingYet) return null;
  return (
    <Link href="/settings/connections" className="text-sm font-medium text-ink underline underline-offset-2">
      Connect your Claude
    </Link>
  );
}
