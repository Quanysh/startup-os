"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { dayAhead, type DayAhead } from "@/lib/today/opening";
import { localDayStart, timeLabel, weekSpan } from "@/lib/work/days";

/**
 * The viewer's own calendar this week, for one who holds `today`: the same
 * read, with the same arguments, as the week on Your day, so the two share
 * one subscription. null where it is not the viewer's: never asked for.
 */
export function useEvents() {
  const allowed = useViewer().can("today");
  const now = useNow();
  const start = now === null ? null : localDayStart(now);
  const span = useMemo(() => (start === null ? null : weekSpan(start)), [start]);
  const data = useQuery(api.workTools.events, allowed && span !== null ? span : "skip");
  return allowed ? data : null;
}

/** Where the viewer's day stands, for the opening line. null where the calendar is not theirs or was never read. */
export function useDay(): DayAhead | null | undefined {
  const data = useEvents();
  const now = useNow();
  if (data === null) return null;
  if (data === undefined || now === null) return undefined;
  if (data.source.lastOkAt === null) return null;
  return dayAhead(data.events, now, timeLabel);
}
