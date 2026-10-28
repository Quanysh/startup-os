"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useCompany } from "@/components/company-provider";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { BRIEF_WORDS } from "@/lib/assistant/agents";
import { briefFooter } from "@/lib/assistant/words";
import { COMPANIES, DEFAULT_COMPANY } from "@/lib/company";
import { daysBetween, localIsoDate } from "@/lib/dates";
import { BriefLines } from "./brief";

/** Today and the seven days before. */
export const ARCHIVE_DAYS_BACK = 7;

/** "Today", "Yesterday", then the weekday and date: "Monday, October 12". */
export function archiveDayLabel(day: string, today: string): string {
  const back = daysBetween(day, today);
  if (back === 0) return "Today";
  if (back === 1) return "Yesterday";
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(
    new Date(year, month - 1, date),
  );
}

/**
 * The company in view's briefs, today and the seven days before, newest
 * first: what the owner's agents found, day by day. Today's is also the
 * first block of the owner's Today. `assistant.briefArchive` reads no clock;
 * which days are recent enough is decided here with the page's own.
 *
 * **A model wrote every line**: rendered as text (`BriefLines`), its link
 * only from the closed list of the app's pages.
 */
export function BriefArchive() {
  const company = useCompany() ?? DEFAULT_COMPANY;
  const briefs = useQuery(api.assistant.briefArchive, { company });
  const now = useNow();
  const today = now === null ? null : localIsoDate(now);
  // A day either side of the server's is allowed, so "tomorrow" by this clock is kept too.
  const shown =
    briefs === undefined || today === null
      ? undefined
      : briefs.filter((brief) => daysBetween(brief.day, today) <= ARCHIVE_DAYS_BACK);

  return (
    <Panel aria-labelledby="brief-archive">
      <h2 id="brief-archive" className="text-base">
        Brief archive
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        What your agents found for {COMPANIES[company].name}, day by day: today and the seven days before.
      </p>
      <div className="mt-4">
        {shown === undefined || now === null || today === null ? (
          <Skeleton data-testid="archive-loading" className="h-28 w-full rounded-inner" />
        ) : shown.length === 0 ? (
          <p className="text-sm text-ink-2" data-testid="archive-none">
            {BRIEF_WORDS.none}
          </p>
        ) : (
          <ol className="divide-y divide-line">
            {shown.map((brief) => (
              <li key={brief.day} className="py-4 first:pt-0 last:pb-0">
                <h3 className="text-sm font-medium text-ink">{archiveDayLabel(brief.day, today)}</h3>
                <div className="mt-2">
                  <BriefLines bullets={brief.bullets} />
                </div>
                <p className="mt-2 text-xs text-ink-3">{briefFooter(brief.writtenAt, now)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}
