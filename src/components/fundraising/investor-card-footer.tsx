"use client";

import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import type { InvestorCard } from "@/lib/fundraising/sync";
import { investorHref } from "./investor-table";
import { SyncChips } from "./sync-chips";

/** The foot of an investor's card on the board: what it says about Visible, and its page. */
export function InvestorCardFooter({
  card,
  onRetry,
}: {
  card: InvestorCard;
  onRetry: (id: string) => Promise<unknown>;
}) {
  return (
    <div className="mt-1.5 flex items-end justify-between gap-2">
      <SyncChips card={card} onRetry={onRetry} className="flex min-w-0 flex-wrap items-center gap-1.5" />
      <Link
        href={investorHref(card.id)}
        aria-label={`Open the page of ${card.name}`}
        title="Open its page"
        className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-3 outline-none hover:bg-surface hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowUpRightIcon aria-hidden className="size-3.5" />
      </Link>
    </div>
  );
}
