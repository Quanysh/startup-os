"use client";

import { useQuery } from "convex/react";
import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { BriefLines } from "@/components/assistant/brief";
import { useCompany } from "@/components/company-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { BRIEF_WORDS, briefIsFresh } from "@/lib/assistant/agents";
import { briefFooter } from "@/lib/assistant/words";
import { DEFAULT_COMPANY } from "@/lib/company";

/**
 * The owner's brief on Today, after "Needs you": today's lines for the
 * company in view, compact, folded away with a press (it is reading, not
 * acting), and the way to the full brief and the past days on the Assistant.
 * Mounted for the owner alone (the page asks `isOwner` and `personal`), since
 * `assistant.brief` is an `ownerQuery`; for anyone else it is never drawn and
 * never asked for. One older than thirty-six hours is not shown: the page's
 * own clock decides, and the usual words say there is none yet.
 */
export function TodayBrief() {
  const company = useCompany() ?? DEFAULT_COMPANY;
  const brief = useQuery(api.assistant.brief, { company });
  const now = useNow();

  return (
    <section aria-labelledby="today-brief" className="rounded-card bg-panel shadow-soft">
      <details open className="group">
        <summary className="flex cursor-pointer list-none [&::-webkit-details-marker]:hidden items-center justify-between gap-4 rounded-card px-5 py-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-6">
          <h2 id="today-brief" className="text-base">
            Brief
          </h2>
          <ChevronDownIcon aria-hidden className="size-4 text-ink-3 transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-5 pb-5 sm:px-6">
          {brief === undefined || now === null ? (
            <Skeleton data-testid="brief-loading" className="h-16 w-full rounded-inner" />
          ) : brief === null || !briefIsFresh(brief.writtenAt, now) ? (
            <p className="text-sm text-ink-2" data-testid="brief-none">
              {BRIEF_WORDS.none}
            </p>
          ) : (
            <>
              <BriefLines bullets={brief.bullets} compact />
              <p className="mt-3 text-xs text-ink-3" data-testid="brief-footer">
                {briefFooter(brief.writtenAt, now)}
              </p>
            </>
          )}
          <Link
            href="/assistant"
            className="mt-3 inline-block rounded-sm text-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Open in Assistant
          </Link>
        </div>
      </details>
    </section>
  );
}
