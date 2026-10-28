"use client";

import { SparklesIcon } from "lucide-react";
import Link from "next/link";
import { Reveal } from "@/components/finance/motion";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { TheCompany } from "@/components/home/company";
import { NeedsYou } from "@/components/home/needs-you";
import { OpeningLine } from "@/components/home/opening-line";
import { useNeeds } from "@/components/home/use-needs";
import { ConnectLink, YourDay } from "@/components/home/your-day";
import { quietButtonClass } from "@/components/panel";
import { TodayBrief } from "@/components/today/today-brief";
import { useViewer } from "@/hooks/use-viewer";
import { cn } from "@/lib/utils";

/**
 * Today: the one start page, "what needs me, and how is the company doing?".
 * Top to bottom: the opening line (the runway, how many things need the
 * viewer, their next meeting, each a link); "Needs you", one ranked list of
 * everything waiting on them; the owner's brief; their own day; then the
 * company, a strip of key figures and the blocks their focus arranges.
 *
 * Every block decides for itself whether it is this viewer's and this
 * company's, and a query Convex would refuse is never sent: the brief and
 * the approvals are the owner's alone (`personal`, which no teammate can be
 * given), a person's own day is the `today` area's and only ever theirs, and
 * each company block needs its page's area. The page rises in once, in
 * order (`Reveal`, nothing under `prefers-reduced-motion`).
 */
export default function TodayPage() {
  const { isOwner, can } = useViewer();
  // The brief and the approvals are `ownerQuery`s: the owner, who alone holds `personal`.
  const owners = isOwner && can("personal");
  const needs = useNeeds();

  return (
    <div className="space-y-10">
      <Reveal order={0}>
        <OpeningLine
          needs={needs?.rows.length}
          aside={
            <>
              {/* The sources behind what this viewer sees here, each gated as its block is. */}
              <PageFreshness page="today" />
              {owners && (
                // A way to the chat, never a second place to ask.
                <Link href="/assistant" className={cn(quietButtonClass, "h-8 bg-surface px-3 text-xs text-ink")}>
                  <SparklesIcon aria-hidden className="size-3.5" />
                  Ask Claude
                </Link>
              )}
              <ConnectLink />
            </>
          }
        />
      </Reveal>
      <Reveal order={1}>
        <NeedsYou needs={needs} />
      </Reveal>
      {owners && (
        <Reveal order={2}>
          <TodayBrief />
        </Reveal>
      )}
      <Reveal order={3} className="empty:hidden">
        <YourDay />
      </Reveal>
      <Reveal order={4} className="empty:hidden">
        <TheCompany />
      </Reveal>
    </div>
  );
}
