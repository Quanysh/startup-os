"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { SetupLink, useFreshness } from "@/components/work/personal-source";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { localIsoDate } from "@/lib/dates";
import { dayLabel } from "@/lib/format";
import { ageLabel } from "@/lib/freshness";

const linkClass = "text-xs font-medium text-ink underline underline-offset-2 hover:text-brand";

/**
 * Recent Fireflies meetings, compactly: a title and a day each. What a
 * meeting said, and its action items with "Add to board", are kept in one
 * place, Memory. For the owner (whose Fireflies the Memory import reads),
 * each meeting opens the notes made from it, or offers "Add notes in
 * Memory", the import; a teammate's own meetings are listed only, and the
 * company's notes are not asked for.
 */
export function RecentMeetingsPanel() {
  const data = useQuery(api.workTools.meetings, {});
  const { isOwner, can } = useViewer();
  const imports = isOwner && can("personal") && can("memory");
  const notes = useQuery(api.meetingNotes.list, imports ? {} : "skip");
  const now = useNow();
  const freshness = useFreshness();
  // Which notes were made from which Fireflies meeting (sent to the owner alone).
  const notesOf = new Map(
    (notes ?? []).flatMap((row) => ("firefliesId" in row && row.firefliesId ? [[row.firefliesId, row.id]] : [])),
  );

  return (
    <Panel aria-labelledby="recent-meetings">
      <h3 id="recent-meetings" className="text-sm font-medium text-ink">
        Recent meetings
      </h3>
      {data === undefined ? (
        <Skeleton data-testid="recent-meetings-loading" className="mt-4 h-40 rounded-inner" />
      ) : data.source.lastOkAt === null ? (
        <p className="mt-3 text-sm text-ink-2">
          Fireflies has not been read yet. <SetupLink />
        </p>
      ) : (
        <>
          {data.meetings.length === 0 ? (
            <p className="mt-3 text-sm text-ink">No meetings in the last 90 days.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {data.meetings.map((meeting) => {
                const made = notesOf.get(meeting.meetingId);
                return (
                  <li
                    key={meeting.meetingId}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <h4 className="break-words text-sm text-ink">{meeting.title}</h4>
                      <p className="text-xs text-ink-3">
                        {now === null ? "" : dayLabel(localIsoDate(meeting.heldAt), now)}
                      </p>
                    </div>
                    {imports &&
                      notes !== undefined &&
                      (made !== undefined ? (
                        <Link href={`/memory?tab=meetings&meeting=${made}`} className={linkClass}>
                          Open notes
                        </Link>
                      ) : (
                        <Link
                          href={`/memory?tab=meetings&import=${encodeURIComponent(meeting.meetingId)}`}
                          className={linkClass}
                        >
                          Add notes in Memory
                        </Link>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}
          {data.source.state !== "ok" && (
            <p className="mt-4 text-xs text-ink-2">The last read failed, so this may be out of date.</p>
          )}
          <p className="mt-4 text-xs text-ink-3">
            {freshness(now === null ? null : ageLabel(now, data.source.lastOkAt))}
          </p>
        </>
      )}
    </Panel>
  );
}
