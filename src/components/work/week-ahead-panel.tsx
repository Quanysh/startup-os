"use client";

import { useQuery } from "convex/react";
import { VideoIcon } from "lucide-react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { SetupLink, useFreshness } from "@/components/work/personal-source";
import { useNow } from "@/hooks/use-now";
import { ageLabel } from "@/lib/freshness";
import {
  dayHeading,
  eventsOn,
  localDayStart,
  timeLabel,
  weekDays,
  weekSpan,
  type CalendarEvent,
} from "@/lib/work/days";
import { peopleLabel } from "@/lib/work/people";

export function EventRow({ event }: { event: CalendarEvent }) {
  const people = peopleLabel(event.attendees, event.attendeeCount);
  return (
    <li className="flex gap-3 py-1.5 text-sm">
      <span className="w-32 shrink-0 font-num text-ink-2">
        {event.allDay
          ? "All day"
          : // An en dash (U+2013), as a range takes.
            `${timeLabel(event.startsAt)} – ${timeLabel(event.endsAt)}`}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium text-ink">{event.title}</span>
        {people !== "" && <span className="block break-words text-xs text-ink-2">{people}</span>}
        {event.hasMeetingLink && (
          <span className="mt-0.5 flex items-center gap-1 text-xs text-ink-3">
            <VideoIcon aria-hidden className="size-3.5" />
            Video call
          </span>
        )}
      </span>
    </li>
  );
}

/** Today and the seven days after it, in the device's own time zone; `laterOnly`: the seven after it. */
export function WeekAheadPanel({ laterOnly = false }: { laterOnly?: boolean }) {
  const now = useNow();
  // The start of today, so the span (and the subscription) changes once a day.
  const today = now === null ? null : localDayStart(now);
  const span = useMemo(() => (today === null ? null : weekSpan(today)), [today]);
  const data = useQuery(api.workTools.events, span ?? "skip");
  const freshness = useFreshness();

  return (
    <Panel aria-labelledby="week-ahead">
      <h3 id="week-ahead" className="text-sm font-medium text-ink">
        {laterOnly ? "Later this week" : "This week"}
      </h3>
      {data === undefined || now === null ? (
        <Skeleton data-testid="week-ahead-loading" className="mt-4 h-48 rounded-inner" />
      ) : data.source.lastOkAt === null ? (
        <p className="mt-3 text-sm text-ink-2">
          Google Calendar has not been read yet. <SetupLink />
        </p>
      ) : (
        <>
          <div className="mt-3 space-y-4">
            {weekDays(now).slice(laterOnly ? 1 : 0).map((day) => {
              const events = eventsOn(data.events, day);
              return (
                <section key={day} aria-label={dayHeading(day, now)}>
                  <h4 className="text-xs font-medium text-ink-2">{dayHeading(day, now)}</h4>
                  {events.length === 0 ? (
                    <p className="py-1.5 text-sm text-ink-3">No meetings.</p>
                  ) : (
                    <ul>
                      {events.map((event) => (
                        <EventRow key={event.eventId} event={event} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          {data.source.state !== "ok" && (
            <p className="mt-4 text-xs text-ink-2">The last read failed, so this may be out of date.</p>
          )}
          <p className="mt-4 text-xs text-ink-3">
            {freshness(ageLabel(now, data.source.lastOkAt))} Times are in this device&apos;s time
            zone.
          </p>
        </>
      )}
    </Panel>
  );
}
