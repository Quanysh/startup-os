"use client";

import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useWaitingCount } from "./inbox";

/**
 * "N waiting → Approvals": one line where a page used to decide on its own
 * (the Assistant, an agent's Runs tab). Deciding is done on /approvals alone.
 * `count` given: that figure (an agent's own calls); else the one count of
 * what waits (`useWaitingCount`, both companies), asked for the owner alone.
 */
export function WaitingLink({ count, href = "/approvals" }: { count?: number; href?: string }) {
  const waiting = useWaitingCount(count === undefined);
  const shown = count ?? waiting;
  if (shown === undefined) return <Skeleton className="h-5 w-40" data-testid="waiting-loading" />;
  return (
    <p className="text-sm text-ink-2" data-testid="waiting-link">
      <Link
        href={href}
        className="inline-flex items-center gap-1.5 rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {shown} waiting
        <ArrowRightIcon aria-hidden className="size-3.5" />
        <span className="sr-only"> on </span>
        Approvals
      </Link>
    </p>
  );
}
