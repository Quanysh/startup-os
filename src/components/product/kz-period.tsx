"use client";

import { useMutation } from "convex/react";
import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { fieldClass } from "@/components/panel";
import { StatusChip } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { SPANS, SPAN_LABELS, kzHref, type KzView, type Period } from "@/lib/metrics/kz-detail";
import type { SourceStates } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";

type State = { kind: "running" } | { kind: "started" } | { kind: "error"; message: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const plusDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const range = (first: string, weeks: number) => `${short(first)}–${short(plusDays(first, 7 * weeks - 1))}`;
/** The Monday of a date's week (UTC dates, as the weeks are kept). */
export const mondayOf = (day: string) => plusDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** The period's first Monday and last Monday on record; null before any week is read. */
export function periodWeeks(period: Period, mondays: readonly string[]): { first: string; last: string } | null {
  const lastIndex = period.end === null ? mondays.length - 1 : mondays.indexOf(period.end);
  if (lastIndex < 0) return null;
  const firstIndex = Math.max(0, lastIndex - period.weeks + 1);
  return { first: mondays[firstIndex]!, last: mondays[lastIndex]! };
}

/**
 * The tab's title, as the weekly report heads its page: the weeks shown
 * against the same span before, and how long that is. It follows the picker.
 */
export function PeriodTitle({ period, mondays }: { period: Period; mondays: readonly string[] }) {
  const weeks = periodWeeks(period, mondays);
  return (
    <div className="min-w-0">
      <h2 className="flex flex-wrap items-center gap-2 text-2xl font-medium text-ink">
        {weeks === null ? (
          COMPANIES.kz.name
        ) : (
          <>
            {COMPANIES.kz.name} — {range(weeks.first, period.weeks)} vs {range(plusDays(weeks.first, -7 * period.weeks), period.weeks)}
          </>
        )}
        <StatusChip tone="info" icon={undefined}>
          {period.weeks === 1 ? "1 week" : `${period.weeks} weeks`}
        </StatusChip>
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        Real doctors only: no test accounts, staging or localhost. Weeks run Monday to Sunday.
      </p>
    </div>
  );
}

/**
 * The period and the data's freshness, on the right of the title, as the
 * weekly report has them: when PostHog was last read, the period (whole
 * Monday–Sunday weeks: the last 1, 2, 4, 8 or 13, or any run of weeks on
 * record, against the same span before) and a button that reads PostHog
 * again. The button is the sources page's "Run now", so it is there only for
 * someone who holds the Settings page; it reads finished weeks, never the one
 * in progress.
 */
export function PeriodBar({
  view,
  period,
  mondays,
  sources,
  hrefFor,
}: {
  view: KzView;
  /** Where a new period leads, when not a view of the tab (a clinic's own page). */
  hrefFor?: (span: number, end: string | null) => string;
  period: Period;
  /** The finished weeks on record, oldest first. */
  mondays: readonly string[];
  sources: SourceStates;
}) {
  const router = useRouter();
  const { can } = useViewer();
  const runNow = useMutation(api.sources.runNow);
  const [state, setState] = useState<State | null>(null);
  // A period no preset names (an end picked, or 8 weeks) is a custom one.
  const [custom, setCustom] = useState(
    period.end !== null || !(SPANS as readonly number[]).includes(period.weeks),
  );
  const weeks = periodWeeks(period, mondays);
  const read = sources.posthog_globex?.lastOkAt ?? null;
  const go = (weeksCount: number, end: string | null) =>
    router.replace(hrefFor ? hrefFor(weeksCount, end) : kzHref(view, weeksCount, end), { scroll: false });

  /**
   * Two dates as a period: each to the Monday of its week, held to the weeks
   * on record, the earlier first. The figures are kept by week, so a period
   * is always whole weeks; the line under the picker says which.
   */
  const pick = (from: string, to: string) => {
    if (mondays.length === 0) return;
    const index = (day: string) => {
      const monday = mondayOf(day);
      if (monday <= mondays[0]!) return 0;
      if (monday >= mondays.at(-1)!) return mondays.length - 1;
      return Math.max(0, mondays.findIndex((m) => m >= monday));
    };
    const [first, last] = [index(from), index(to)].sort((x, y) => x - y) as [number, number];
    go(last - first + 1, mondays[last]!);
  };

  const refresh = async () => {
    setState({ kind: "running" });
    try {
      await runNow({ source: "posthog_globex" });
      setState({ kind: "started" });
    } catch (failure) {
      setState({ kind: "error", message: messageOf(failure) });
    }
  };
  const when = (at: number) =>
    new Date(at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex max-w-full flex-col items-end gap-1.5 text-right">
      <p className="text-xs text-ink-2">{read === null ? "PostHog not read yet" : `PostHog data as of ${when(read)}`}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <select
            aria-label="Period"
            value={custom ? "custom" : String(period.weeks)}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setCustom(true);
                if (weeks !== null) go(period.weeks, weeks.last);
                return;
              }
              setCustom(false);
              go(Number(e.target.value), null);
            }}
            className={cn(fieldClass, "h-9 w-auto rounded-full pr-8")}
          >
            {SPANS.map((s) => (
              <option key={s} value={s}>
                {SPAN_LABELS[s]}
              </option>
            ))}
            <option value="custom">Custom period…</option>
          </select>
        {can("settings") && (
          <button
            type="button"
            onClick={refresh}
            disabled={state?.kind === "running"}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-brand-fill px-4 text-sm font-medium text-on-brand outline-none transition hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            <RefreshCwIcon aria-hidden className={cn("size-4", state?.kind === "running" && "animate-spin")} />
            Refresh from PostHog
          </button>
        )}
      </div>
      {custom && weeks !== null && (
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-ink-2">
          <label className="flex items-center gap-1">
            from
            <input
              type="date"
              aria-label="From"
              value={weeks.first}
              min={mondays[0]}
              max={plusDays(mondays.at(-1)!, 6)}
              onChange={(e) => e.target.value && pick(e.target.value, plusDays(weeks.last, 6))}
              className={cn(fieldClass, "h-8 w-auto")}
            />
          </label>
          <label className="flex items-center gap-1">
            to
            <input
              type="date"
              aria-label="To"
              value={plusDays(weeks.last, 6)}
              min={mondays[0]}
              max={plusDays(mondays.at(-1)!, 6)}
              onChange={(e) => e.target.value && pick(weeks.first, e.target.value)}
              className={cn(fieldClass, "h-8 w-auto")}
            />
          </label>
          <span className="w-full text-ink-3">
            Rounded to whole Monday–Sunday weeks: the figures are kept by week.
          </span>
        </div>
      )}
      {weeks !== null && (
        <p className="text-xs text-ink-2">
          {range(weeks.first, period.weeks)} ({period.weeks === 1 ? "1 week" : `${period.weeks} weeks`}) against{" "}
          {range(plusDays(weeks.first, -7 * period.weeks), period.weeks)}
        </p>
      )}
      <p className="max-w-xs text-xs text-ink-2">
        {state === null
            ? can("settings")
              ? "Refresh reads the finished weeks again; about a minute."
              : "PostHog is read every morning at about 11:10 Almaty time."
            : null}
      </p>
      {state?.kind === "started" && (
        <p role="status" className="max-w-xs text-xs text-ink-2">
          Reading PostHog. The figures change here as each finished week lands, in about a minute.
        </p>
      )}
      {state?.kind === "error" && (
        <p role="alert" className="max-w-xs text-xs text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}
