"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCompany } from "@/components/company-provider";
import { AnimatedGrid } from "@/components/ui/animated-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { COMPANIES } from "@/lib/company";
import { openingLine } from "@/lib/today/opening";
import { useDay } from "./use-day";
import { dayOf, useRunway } from "./use-runway";

/** The device's own date, written out: "Friday, October 16". */
const dateLabel = (now: number) =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(now);

const clauseClass =
  "rounded-sm underline decoration-line decoration-2 underline-offset-[0.2em] outline-none transition-colors hover:text-brand hover:decoration-brand focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The page's opening: "Today", then one or two sentences from the viewer's
 * own figures (src/lib/today/opening.ts), each clause a link to where it is
 * acted on, then the date and the company in view. The sentence is the
 * page's one bold element. It waits for every piece it will say, so it never
 * grows a clause after it is read; a piece the viewer may not see, or that
 * is not known, is left out.
 */
export function OpeningLine({ needs, aside }: { needs: number | undefined; aside?: ReactNode }) {
  const now = useNow();
  const company = useCompany();
  const runway = useRunway();
  const day = useDay();
  const loading = needs === undefined || runway === undefined || day === undefined || now === null;
  const segments = loading ? [] : openingLine({ runway, needs, day, today: dayOf(now) });

  return (
    // The drifting grid sits behind the opening, reaching past it on every side.
    <header className="relative isolate space-y-3">
      <AnimatedGrid className="-inset-x-4 sm:-inset-x-8 -inset-y-10 -z-10" />
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h1 className="text-sm font-medium text-ink-2">Today</h1>
        {aside !== undefined && (
          <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2">{aside}</div>
        )}
      </div>
      {loading ? (
        <div data-testid="opening-loading" aria-busy className="space-y-2">
          <Skeleton className="h-9 w-full max-w-2xl rounded-inner" />
          <Skeleton className="h-9 w-2/3 max-w-xl rounded-inner" />
        </div>
      ) : (
        <p
          data-testid="opening-line"
          className="max-w-4xl text-[1.75rem] leading-[1.2] font-medium tracking-tight text-balance text-ink sm:text-[2.5rem]"
        >
          {segments.map((part, i) =>
            part.href === undefined ? (
              <span key={i}>{part.text}</span>
            ) : part.href.startsWith("#") ? (
              <a key={i} href={part.href} className={clauseClass}>
                {part.text}
              </a>
            ) : (
              <Link key={i} href={part.href} className={clauseClass}>
                {part.text}
              </Link>
            ),
          )}
        </p>
      )}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-3">
        {now !== null && <span>{dateLabel(now)}</span>}
        {company !== null && (
          <span>
            {COMPANIES[company].name}, {COMPANIES[company].marketLabel}
          </span>
        )}
      </p>
    </header>
  );
}
