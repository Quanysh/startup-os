"use client";

import { useQuery } from "convex/react";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockAlertIcon,
  ClockIcon,
  PencilLineIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { FAILURE_SENTENCES, cadenceWords, expectedMs } from "@convex/lib/cadence";
import { MIRROR_SOURCES } from "@convex/lib/mirrorRules";
import { useCompany } from "@/components/company-provider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { useViewer, type Viewer } from "@/hooks/use-viewer";
import type { FreshnessPage } from "@/lib/page-sources";
import {
  STATE_TONE,
  STATE_WORDS,
  agoWords,
  atWords,
  classify,
  headline,
  type FreshnessState,
  type FreshnessTone,
  type Reading,
} from "@/lib/source-freshness";
import { cn } from "@/lib/utils";

const DOT: Record<FreshnessTone, string> = {
  good: "bg-good",
  watch: "bg-watch",
  weak: "bg-weak",
  neutral: "bg-ink-3",
};
const NOTE_INK: Record<FreshnessTone, string> = {
  good: "text-success-ink",
  watch: "text-warning-ink",
  weak: "text-danger-ink",
  neutral: "text-ink-2",
};
const CHIP: Record<FreshnessState, { tone: StatusTone; icon: LucideIcon }> = {
  fresh: { tone: "success", icon: CircleCheckIcon },
  late: { tone: "warning", icon: ClockIcon },
  stale: { tone: "danger", icon: ClockAlertIcon },
  failed: { tone: "danger", icon: CircleAlertIcon },
  never: { tone: "neutral", icon: CircleDashedIcon },
  typed: { tone: "neutral", icon: PencilLineIcon },
};

const isMirror = (id: string) => (MIRROR_SOURCES as readonly string[]).includes(id);

/**
 * Where a viewer can see more of a source, if anywhere they hold: a work tool
 * on Today is the viewer's own connection (Settings › Connections); any other
 * read source is on Settings › Sources, for a holder of `settings`. Typed-in
 * figures have no page of runs.
 */
export function moreAbout(reading: Reading, viewer: Viewer, page: FreshnessPage | null) {
  if (reading.cadence.kind === "typed") return null;
  if (isMirror(reading.id)) {
    const own = page === "today" || viewer.isOwner;
    return own && viewer.can("today")
      ? { href: "/settings/connections", label: "Settings › Connections" }
      : null;
  }
  return viewer.can("settings") ? { href: "/settings/sources", label: "Settings › Sources" } : null;
}

/** How far through its window a source is: a mark on a track whose middle is its cadence. */
function Gauge({ reading, now, tone }: { reading: Reading; now: number; tone: FreshnessTone }) {
  const limit = expectedMs(reading.cadence);
  if (limit === null || reading.lastOkAt === null) return null;
  const at = Math.min(1, Math.max(0, (now - reading.lastOkAt) / (2 * limit)));
  return (
    <div aria-hidden className="relative mt-2 h-1 rounded-full bg-surface">
      <div className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-line" />
      <div className="absolute -top-0.5 left-1/2 h-2 w-px bg-ink-3" />
      <div
        className={cn("absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel", DOT[tone])}
        style={{ left: `${at * 100}%` }}
      />
    </div>
  );
}

function SourceRow({
  reading,
  now,
  more,
}: {
  reading: Reading;
  now: number;
  more: { href: string; label: string } | null;
}) {
  const state = classify(reading, now);
  const chip = CHIP[state];
  const typed = reading.cadence.kind === "typed";
  const when =
    reading.lastOkAt === null
      ? typed
        ? "Nothing typed in yet."
        : "No good read yet."
      : `${typed ? "Last change" : "Last good read"} ${atWords(reading.lastOkAt, now)}, ${agoWords(now, reading.lastOkAt)}.`;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium text-ink">{reading.label}</p>
        <StatusChip tone={chip.tone} icon={chip.icon} className="shrink-0">
          {STATE_WORDS[state]}
        </StatusChip>
      </div>
      <p className="mt-1 text-xs text-ink-2">{when}</p>
      <p className="text-xs text-ink-2">{cadenceWords(reading.cadence)}.</p>
      {reading.failureKey !== null && (
        <p className="mt-1 text-xs text-danger-ink">{FAILURE_SENTENCES[reading.failureKey]}</p>
      )}
      <Gauge reading={reading} now={now} tone={STATE_TONE[state]} />
      {more !== null && (
        <p className="mt-2 text-xs">
          <Link
            href={more.href}
            className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {more.label}
          </Link>
        </p>
      )}
    </li>
  );
}

/**
 * The header's "Updated …" line: a dot for the worst of the page's sources,
 * the oldest of them in words, and how many are not on time. It opens a list
 * of each source with its last good read (in the viewer's time zone and as an
 * age), its cadence, its state and, for a viewer who holds it, where to see more.
 * Renders nothing until there is a clock and something to say.
 */
export function FreshnessIndicator({
  readings,
  page = null,
  className,
}: {
  readings: readonly Reading[] | undefined;
  /** The page the readings are for: decides where a work tool's link leads. */
  page?: FreshnessPage | null;
  className?: string;
}) {
  const now = useNow();
  const viewer = useViewer();
  if (readings === undefined || now === null) return null;
  const line = headline(readings, now);
  if (line === null) return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={line.sentence}
        className={cn(
          "-mx-2 inline-flex min-h-8 max-w-full items-center gap-2 rounded-full px-2 py-1 text-left text-sm text-ink-2 outline-none transition-colors hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-surface data-[state=open]:text-ink",
          className,
        )}
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[line.tone])} />
        <span className="min-w-0">
          {line.text}
          {line.note !== null && (
            <span className={cn("font-medium", NOTE_INK[line.tone])}>{` · ${line.note}`}</span>
          )}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-ink-3" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <p className="border-b border-line px-4 py-3 text-xs text-ink-2">
          {readings.length === 1 ? "Where this page's figures come from" : "Where this page's figures come from, oldest read first"}
        </p>
        <ul className="max-h-[min(28rem,70vh)] divide-y divide-line overflow-y-auto">
          {[...readings]
            .sort((a, b) => (a.lastOkAt ?? -Infinity) - (b.lastOkAt ?? -Infinity))
            .map((reading) => (
              <SourceRow
                key={reading.id}
                reading={reading}
                now={now}
                more={moreAbout(reading, viewer, page)}
              />
            ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The indicator for a page whose sources `freshness.forPage` sends, in the company in view. */
export function PageFreshness({
  page,
  extra = [],
  className,
}: {
  page: FreshnessPage;
  /** Readings the page works out itself (Startup's deals, typed in here). */
  extra?: readonly Reading[];
  className?: string;
}) {
  const company = useCompany();
  const rows = useQuery(api.freshness.forPage, company === null ? "skip" : { page, company });
  return (
    <FreshnessIndicator
      readings={rows === undefined ? undefined : [...rows, ...extra]}
      page={page}
      className={className}
    />
  );
}

/** A page that is only typed in: when its newest row changed, among those the viewer reads. */
export function TypedFreshness({
  label,
  at,
  className,
}: {
  /** What was typed in: "Cost lines", "Goals". */
  label: string;
  /** undefined while the page's rows load; null when there are none. */
  at: number | null | undefined;
  className?: string;
}) {
  return (
    <FreshnessIndicator
      readings={at === undefined ? undefined : [typedReading(label, at)]}
      className={className}
    />
  );
}

/** A typed-in reading the page works out from rows it already reads. */
export function typedReading(label: string, at: number | null): Reading {
  return {
    id: "typed",
    label,
    cadence: { kind: "typed" },
    lastOkAt: at,
    lastRunAt: at,
    failureKey: null,
  };
}
